/**
 * Topology orchestrator for the cloud topology layer.
 *
 * Combines the three Phase-7 building bricks (segment / contour /
 * severity) into a single canonical `Topology` object per frame:
 *
 *   1. Segment the rain-rate grid at the lowest threshold → blobs.
 *   2. For each blob, mask the source grid to that blob's footprint
 *      and run marching squares at every threshold up to its peak.
 *      Masking guarantees a polygon belongs to exactly one cloud.
 *   3. Score severity by sampling the supporting fields (trend,
 *      convective, CAPE, thunderscore, probability) inside the blob.
 *   4. Compute a centroid in grid coords and a mean motion vector
 *      sampled from the (typically lower-resolution) flow field.
 *   5. Sort clouds by descending severity score and assign deterministic
 *      IDs c001, c002, …
 *
 * The output is JSON-serializable end-to-end (no typed arrays in the
 * Cloud objects — polygons are plain `[[x, y], …]` arrays). Conversion
 * to the canonical GeoJSON shape lives in topology-geojson.js.
 *
 * Pure function — no DOM, no Spektrum.
 */

import { labelConnectedComponents } from './segment.js';
import { marchingSquares } from './contour.js';
import { scoreCloud } from './severity.js';

export const DEFAULT_THRESHOLDS_MM_PER_HOUR = Object.freeze([0.5, 2, 10, 30]);
export const DEFAULT_MIN_AREA_CELLS = 5;
export const DEFAULT_FRAME_INTERVAL_MINUTES = 10;

export function buildTopology(grid, width, height, supporting = {}, options = {}) {
  if (!Number.isInteger(width) || width < 2 || !Number.isInteger(height) || height < 2) {
    throw new Error('buildTopology: width and height must be integers >= 2');
  }
  if (!grid || grid.length !== width * height) {
    throw new Error('buildTopology: grid length does not match width*height');
  }

  const {
    thresholds = DEFAULT_THRESHOLDS_MM_PER_HOUR,
    minAreaCells = DEFAULT_MIN_AREA_CELLS,
    frame: frameIn,
  } = options;

  if (!Array.isArray(thresholds) || thresholds.length === 0) {
    throw new Error('buildTopology: thresholds must be a non-empty array');
  }
  const sortedThresholds = [...thresholds].sort((a, b) => a - b);
  const baseThreshold = sortedThresholds[0];

  const frame = {
    time: frameIn?.time ?? null,
    kind: frameIn?.kind ?? 'observed',
    leadMinutes: Number.isFinite(frameIn?.leadMinutes) ? frameIn.leadMinutes : 0,
    intervalMinutes: Number.isFinite(frameIn?.intervalMinutes)
      ? frameIn.intervalMinutes
      : DEFAULT_FRAME_INTERVAL_MINUTES,
    tile: frameIn?.tile ?? { x: 0, y: 0, z: 0 },
    grid: { width, height },
  };

  const thresholdsMeta = { rainMmPerHour: [...sortedThresholds], minAreaCells };

  const { blobs } = labelConnectedComponents(grid, width, height, {
    threshold: baseThreshold,
    minAreaCells,
  });

  if (blobs.length === 0) {
    return { frame, thresholds: thresholdsMeta, clouds: [] };
  }

  const clouds = [];
  for (const blob of blobs) {
    let sumX = 0;
    let sumY = 0;
    for (const p of blob.cells) {
      sumX += p % width;
      sumY += Math.floor(p / width);
    }
    const centroid = [sumX / blob.cells.length, sumY / blob.cells.length];

    // Mask the source grid to this blob's footprint so contour extraction
    // doesn't pick up neighbours.
    const blobGrid = new Float32Array(width * height);
    for (const p of blob.cells) blobGrid[p] = grid[p];

    const levels = [];
    for (const t of sortedThresholds) {
      if (t > blob.peak) continue;
      const polygons = marchingSquares(blobGrid, width, height, t);
      levels.push({ thresholdMmPerHour: t, polygons });
    }

    const severity = scoreCloud(blob, supporting);
    const motion = sampleFlowInBlob(blob, supporting.flow, width, height);

    clouds.push({
      id: '',
      blob: {
        id: blob.id,
        cellCount: blob.cells.length,
        bbox: { ...blob.bbox },
        peak: blob.peak,
        mean: blob.mean,
        sum: blob.sum,
      },
      levels,
      centroid,
      severity,
      motion,
    });
  }

  // Stable IDs by descending severity score; ties broken by larger area.
  clouds.sort((a, b) => {
    if (b.severity.score !== a.severity.score) return b.severity.score - a.severity.score;
    return b.blob.cellCount - a.blob.cellCount;
  });
  for (let i = 0; i < clouds.length; i++) {
    clouds[i].id = `c${String(i + 1).padStart(3, '0')}`;
  }

  return { frame, thresholds: thresholdsMeta, clouds };
}

/**
 * Mean flow vector inside the blob's footprint, sampled from a typically
 * coarser-resolution flow field. Returns `{ vx, vy }` in grid-cells per
 * frame interval (matching the units of the source grid), or null when
 * no flow field is available or no valid samples land inside the blob.
 */
function sampleFlowInBlob(blob, flow, gridWidth, gridHeight) {
  if (!flow || !flow.data || !Number.isInteger(flow.width) || flow.width <= 0
      || !Number.isInteger(flow.height) || flow.height <= 0) {
    return null;
  }
  const fW = flow.width;
  const fH = flow.height;
  const sx = fW / gridWidth;
  const sy = fH / gridHeight;
  // Each flow block covers `1/sx` × `1/sy` source pixels; a source pixel
  // at (px, py) maps to the flow block at (floor(px*sx), floor(py*sy)).
  let svx = 0;
  let svy = 0;
  let count = 0;
  for (const p of blob.cells) {
    const px = p % gridWidth;
    const py = Math.floor(p / gridWidth);
    const fx = Math.min(fW - 1, Math.floor(px * sx));
    const fy = Math.min(fH - 1, Math.floor(py * sy));
    const fp = (fy * fW + fx) * 2;
    const vx = flow.data[fp];
    const vy = flow.data[fp + 1];
    if (Number.isFinite(vx) && Number.isFinite(vy)) {
      svx += vx;
      svy += vy;
      count++;
    }
  }
  if (count === 0) return null;
  // Convert vx, vy from flow-block units to source-grid-pixel units so
  // the motion vector is comparable to the centroid coordinates.
  return {
    vx: (svx / count) / sx,
    vy: (svy / count) / sy,
  };
}
