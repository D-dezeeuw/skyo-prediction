/**
 * Marching-squares contour extraction for rain-rate grids, plus
 * Douglas–Peucker simplification and grid-pixel → lat/lng projection.
 *
 * For each 2×2 cell in the grid we compute a 4-bit case index from
 * which corners are above the threshold, look up the segment(s) the
 * contour traces through that cell, linearly interpolate the exact
 * crossing points along the cell edges, then stitch the per-cell
 * segments into closed (or boundary-open) polygons by endpoint match.
 *
 * Convention: above-threshold region is on the LEFT as you walk along
 * the contour, so closed polygons wind CCW around their interior.
 *
 * Saddle cases (5 and 10) are resolved by the standard split — two
 * disjoint segments per cell, one cutting each above-corner free.
 *
 * Pure functions only. No DOM, no Spektrum.
 */

import { tileBounds } from './vectors.js';

export const DEFAULT_SIMPLIFY_TOLERANCE = 0.5;

export function marchingSquares(grid, width, height, threshold) {
  if (!Number.isInteger(width) || width < 2 || !Number.isInteger(height) || height < 2) {
    throw new Error('marchingSquares: width and height must be integers >= 2');
  }
  if (!grid || grid.length !== width * height) {
    throw new Error('marchingSquares: grid length does not match width*height');
  }
  if (!Number.isFinite(threshold)) {
    throw new Error('marchingSquares: threshold must be finite');
  }

  const segments = [];
  for (let y = 0; y < height - 1; y++) {
    for (let x = 0; x < width - 1; x++) {
      const tl = grid[y * width + x];
      const tr = grid[y * width + x + 1];
      const br = grid[(y + 1) * width + x + 1];
      const bl = grid[(y + 1) * width + x];

      const caseIdx =
        (bl >= threshold ? 1 : 0) |
        (br >= threshold ? 2 : 0) |
        (tr >= threshold ? 4 : 0) |
        (tl >= threshold ? 8 : 0);
      if (caseIdx === 0 || caseIdx === 15) continue;

      // Inline edge crossing helpers. The lerp parameter `t` is the
      // fraction from the first corner to the second where the contour
      // crosses; clamped into [0, 1] so degenerate cases (constant
      // along an edge) collapse safely to an endpoint.
      const lerpT = (a, b) => {
        if (a === b) return 0.5;
        const t = (threshold - a) / (b - a);
        return t < 0 ? 0 : t > 1 ? 1 : t;
      };
      // T (top), R (right), B (bottom), L (left) — points on cell boundary.
      const T = () => [x + lerpT(tl, tr), y];
      const R = () => [x + 1, y + lerpT(tr, br)];
      const B = () => [x + lerpT(bl, br), y + 1];
      const L = () => [x, y + lerpT(tl, bl)];

      switch (caseIdx) {
        case 1:  segments.push([L(), B()]); break;
        case 2:  segments.push([B(), R()]); break;
        case 3:  segments.push([L(), R()]); break;
        case 4:  segments.push([R(), T()]); break;
        case 5:  segments.push([L(), T()]); segments.push([R(), B()]); break;
        case 6:  segments.push([B(), T()]); break;
        case 7:  segments.push([L(), T()]); break;
        case 8:  segments.push([T(), L()]); break;
        case 9:  segments.push([T(), B()]); break;
        case 10: segments.push([T(), R()]); segments.push([B(), L()]); break;
        case 11: segments.push([T(), R()]); break;
        case 12: segments.push([R(), L()]); break;
        case 13: segments.push([R(), B()]); break;
        case 14: segments.push([B(), L()]); break;
        // 0 and 15 already filtered.
      }
    }
  }
  return stitchSegments(segments);
}

function pointKey(pt) {
  return `${pt[0].toFixed(6)},${pt[1].toFixed(6)}`;
}

function stitchSegments(segments) {
  const polygons = [];
  if (segments.length === 0) return polygons;

  // Index segments by their start point so we can chain end → next start.
  // Saddles emit segments with all four edge-midpoints distinct, so no
  // collision under normal grids.
  const startIndex = new Map();
  for (let i = 0; i < segments.length; i++) {
    startIndex.set(pointKey(segments[i][0]), i);
  }
  const used = new Uint8Array(segments.length);

  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    const polygon = [segments[i][0]];
    let cur = i;
    while (true) {
      used[cur] = 1;
      const endPt = segments[cur][1];
      polygon.push(endPt);
      const nextIdx = startIndex.get(pointKey(endPt));
      if (nextIdx === undefined || used[nextIdx]) break;
      cur = nextIdx;
    }
    // If the chain closed back on itself, drop the duplicated first
    // vertex so consumers can treat it as a closed ring without
    // double-counting the seam.
    if (polygon.length >= 3 && pointKey(polygon[0]) === pointKey(polygon[polygon.length - 1])) {
      polygon.pop();
    }
    polygons.push(polygon);
  }
  return polygons;
}

/**
 * Douglas–Peucker polyline simplification. For a closed polygon, the
 * caller should append the first vertex as the last so the algorithm
 * sees it as a polyline; this function does NOT auto-close.
 *
 * Tolerance is in the same units as the input points (grid cells for
 * raw marching-squares output, degrees for already-projected polygons).
 */
export function simplifyPolygon(points, tolerance = DEFAULT_SIMPLIFY_TOLERANCE) {
  if (!Array.isArray(points)) {
    throw new Error('simplifyPolygon: points must be an array');
  }
  if (!(tolerance >= 0)) {
    throw new Error('simplifyPolygon: tolerance must be >= 0');
  }
  if (points.length < 3) return points.map((p) => p.slice());

  // Iterative DP to avoid recursion depth blow-up on long polygons.
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop();
    let maxDist = -1;
    let maxIdx = -1;
    const [x1, y1] = points[start];
    const [x2, y2] = points[end];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const segLen = Math.hypot(dx, dy);
    for (let i = start + 1; i < end; i++) {
      const [px, py] = points[i];
      let d;
      if (segLen === 0) {
        d = Math.hypot(px - x1, py - y1);
      } else {
        d = Math.abs(dy * px - dx * py + x2 * y1 - y2 * x1) / segLen;
      }
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxDist > tolerance && maxIdx >= 0) {
      keep[maxIdx] = 1;
      stack.push([start, maxIdx]);
      stack.push([maxIdx, end]);
    }
  }

  const out = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i].slice());
  return out;
}

/**
 * Run marching squares at every level and return one entry per level.
 * Levels are not sorted — caller controls order (typically ascending,
 * so envelope-first / core-last reads naturally).
 */
export function tracePolygonsForLevels(grid, width, height, levels) {
  if (!Array.isArray(levels)) {
    throw new Error('tracePolygonsForLevels: levels must be an array');
  }
  return levels.map((threshold) => ({
    threshold,
    polygons: marchingSquares(grid, width, height, threshold),
  }));
}

/**
 * Project polygon vertices from grid-pixel coords to [lng, lat] pairs
 * in the GeoJSON convention. Uses the proper Web-Mercator inverse for
 * latitude (so the projection stays accurate at any tile/zoom, not
 * just small ones).
 *
 * Grid pixel (0, 0) maps to (lonLeft, latTop). Pixel (gridWidth-1,
 * gridHeight-1) maps to (lonRight, latBottom).
 */
export function polygonToLatLng(polygon, tile, gridWidth, gridHeight) {
  if (!Array.isArray(polygon)) {
    throw new Error('polygonToLatLng: polygon must be an array');
  }
  if (!tile || !Number.isInteger(tile.x) || !Number.isInteger(tile.y) || !Number.isInteger(tile.z)) {
    throw new Error('polygonToLatLng: tile must be { x, y, z } integers');
  }
  if (!Number.isInteger(gridWidth) || gridWidth < 2 || !Number.isInteger(gridHeight) || gridHeight < 2) {
    throw new Error('polygonToLatLng: gridWidth and gridHeight must be integers >= 2');
  }
  const { lonLeft, lonRight } = tileBounds(tile.x, tile.y, tile.z);
  const n = 2 ** tile.z;
  return polygon.map(([px, py]) => {
    const tx = px / (gridWidth - 1);
    const ty = py / (gridHeight - 1);
    const lng = lonLeft + (lonRight - lonLeft) * tx;
    const fracTileY = tile.y + ty;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * fracTileY) / n))) * (180 / Math.PI);
    return [lng, lat];
  });
}
