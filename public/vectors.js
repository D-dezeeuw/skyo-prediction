/**
 * Pure helpers for the motion-vector debug overlay.
 *
 *  * tileBounds(x,y,z): convert XYZ tile coordinates to a lat/lon
 *    bounding box (standard Web-Mercator inverse).
 *  * arrowPath(x,y,vx,vy,scale): SVG `d=` string with line + arrowhead.
 *  * magnitudeColor / intensityColor: HSL gradient mappers.
 *  * buildArrows(flow, opts): turn a flow field into an array of
 *    { d, color, magnitude } entries ready for the SVG renderer.
 *
 * All output coordinates are in the tile's pixel space (0..tileSize),
 * matching the SVG viewBox set by map.js. No DOM access here.
 */

import { TRANSPARENT_DBZ, rainRateToDbz } from './palette.js';

export const COLOR_MODES = Object.freeze(['speed', 'intensity']);
export const DEFAULT_ARROW_SCALE = 2;
export const DEFAULT_ARROW_HEAD = 3;

export function tileBounds(x, y, z) {
  if (
    !Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z) ||
    x < 0 || y < 0 || z < 0
  ) {
    throw new Error('tileBounds: x, y, z must be non-negative integers');
  }
  const n = 2 ** z;
  const lonLeft = (x / n) * 360 - 180;
  const lonRight = ((x + 1) / n) * 360 - 180;
  const latTop = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * (180 / Math.PI);
  const latBottom = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * (180 / Math.PI);
  return { latTop, latBottom, lonLeft, lonRight };
}

export function arrowPath(x, y, vx, vy, scale = DEFAULT_ARROW_SCALE, head = DEFAULT_ARROW_HEAD) {
  const ex = x + vx * scale;
  const ey = y + vy * scale;
  if (vx === 0 && vy === 0) {
    return `M ${fmt(x)} ${fmt(y)} L ${fmt(x)} ${fmt(y)}`;
  }
  const angle = Math.atan2(vy, vx);
  const wing = 0.45;
  const hx1 = ex - head * Math.cos(angle - wing);
  const hy1 = ey - head * Math.sin(angle - wing);
  const hx2 = ex - head * Math.cos(angle + wing);
  const hy2 = ey - head * Math.sin(angle + wing);
  return `M ${fmt(x)} ${fmt(y)} L ${fmt(ex)} ${fmt(ey)} L ${fmt(hx1)} ${fmt(hy1)} M ${fmt(ex)} ${fmt(ey)} L ${fmt(hx2)} ${fmt(hy2)}`;
}

function fmt(n) {
  return Number(n.toFixed(2));
}

function clamp01(t) {
  if (!Number.isFinite(t)) return 0;
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

/** Cool→warm hue ramp. Magnitude 0 = blue, magnitude ≥ ref = red. */
export function magnitudeColor(magnitude, refMagnitude) {
  const denom = refMagnitude > 0 ? refMagnitude : 1;
  const t = clamp01(magnitude / denom);
  const hue = 240 * (1 - t);
  return `hsl(${hue.toFixed(0)}, 85%, 55%)`;
}

/** Map a rain rate (mm/h) to a colour echoing the radar palette stops. */
export function intensityColor(mmPerHour) {
  if (!(mmPerHour > 0)) return 'hsl(220, 30%, 65%)';
  const dbz = rainRateToDbz(mmPerHour);
  if (dbz === TRANSPARENT_DBZ) return 'hsl(220, 30%, 65%)';
  // dBZ 5 -> hue 240 (blue), dBZ 60 -> hue 0 (red).
  const t = clamp01((dbz - 5) / 55);
  const hue = 240 * (1 - t);
  return `hsl(${hue.toFixed(0)}, 90%, 55%)`;
}

/**
 * Build the render list of arrows for a flow field.
 *
 *   flow.data: Float32Array, packed [vx,vy] per block
 *   tileSize : pixel size of the SVG viewBox (e.g. 256)
 *   radarGrid: optional same-as-tile-size Float32Array of rain rates
 *              (mm/h) — required when colorMode === 'intensity', and
 *              used for intensity-based arrow gating.
 *   intensityThreshold: skip blocks whose centre samples below this
 *              rain rate (mm/h). 0 → render every block (legacy).
 *              Has no effect when radarGrid is missing.
 */
export function buildArrows(flow, {
  tileSize = 256,
  colorMode = 'speed',
  radarGrid = null,
  radarWidth = 0,
  scale = DEFAULT_ARROW_SCALE,
  intensityThreshold = 0,
} = {}) {
  if (!flow || !flow.data || !flow.width || !flow.height) return [];
  const mode = COLOR_MODES.includes(colorMode) ? colorMode : 'speed';
  const blockPxX = tileSize / flow.width;
  const blockPxY = tileSize / flow.height;
  const gateOnIntensity = radarGrid && radarWidth > 0 && intensityThreshold > 0;

  let refMagnitude = 0;
  if (mode === 'speed') {
    for (let i = 0; i < flow.data.length; i += 2) {
      const m = Math.hypot(flow.data[i], flow.data[i + 1]);
      if (m > refMagnitude) refMagnitude = m;
    }
  }

  const out = [];
  for (let by = 0; by < flow.height; by++) {
    for (let bx = 0; bx < flow.width; bx++) {
      const cx = (bx + 0.5) * blockPxX;
      const cy = (by + 0.5) * blockPxY;
      const sampled = gateOnIntensity ? sampleRadar(radarGrid, radarWidth, cx, cy) : 0;
      if (gateOnIntensity && sampled < intensityThreshold) continue;
      const i = (by * flow.width + bx) * 2;
      const vx = flow.data[i];
      const vy = flow.data[i + 1];
      const magnitude = Math.hypot(vx, vy);
      const d = arrowPath(cx, cy, vx, vy, scale);
      const color = mode === 'speed'
        ? magnitudeColor(magnitude, refMagnitude)
        : intensityColor(gateOnIntensity ? sampled : sampleRadar(radarGrid, radarWidth, cx, cy));
      out.push({ d, color, magnitude });
    }
  }
  return out;
}

function sampleRadar(grid, width, px, py) {
  if (!grid || !Number.isInteger(width) || width <= 0) return 0;
  const ix = Math.max(0, Math.min(width - 1, Math.round(px)));
  const iy = Math.max(0, Math.min(Math.floor(grid.length / width) - 1, Math.round(py)));
  return grid[iy * width + ix] ?? 0;
}
