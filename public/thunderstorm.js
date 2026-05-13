/**
 * Thunderstorm-risk fusion. Per the plan in PLAN.md Phase 5, we
 * combine three signals:
 *
 *   1. Convective cell mask (this module) — small, intense, sharp-
 *      gradient features in the current radar grid. Convective cores
 *      tend to be a few km wide with very steep intensity gradients.
 *   2. Rapid intensification — clamp positive trend (mm/h/frame) from
 *      Phase 2's growth/decay field. A cell still building is more
 *      likely to become a thunderstorm than a fading one.
 *   3. CAPE — atmospheric instability from Phase 4. CAPE > 1000 J/kg
 *      means thunderstorms are physically possible given a trigger.
 *
 *   score = convective × clamp(trend, 0) × normalize(CAPE)
 *
 * Output is a unit-less ≥ 0 score grid: zero everywhere there's no
 * convective signature, scaling up where all three signals agree.
 *
 * Pure functions only.
 */

/** Mean rain rate (mm/h) above which a block is "very intense". */
export const DEFAULT_CONVECTIVE_INTENSITY = 30;
/** Local intensity gradient magnitude (mm/h per pixel) that marks a
 *  sharp edge — characteristic of convective cells, not stratiform sheets. */
export const DEFAULT_CONVECTIVE_GRADIENT = 5;
/** CAPE value where the score saturates (J/kg). */
export const DEFAULT_CAPE_REF = 2000;
/** Render colour ramp magnitude (final score). */
export const DEFAULT_THUNDER_SCALE = 5;
export const DEFAULT_THUNDER_MAX_ALPHA = 200;

/**
 * Per-pixel convective mask. For each interior pixel, multiply the
 * (intensity - threshold) by (gradient_magnitude - gthreshold), both
 * clipped at zero. Boundary pixels have no gradient → 0.
 *
 * Both factors must be positive for the pixel to register, so a
 * uniformly heavy stratiform sheet (high intensity, low gradient) is
 * rejected while a sharp-edged convective core lights up.
 */
export function convectiveMask(grid, width, height, options = {}) {
  const {
    intensityThreshold = DEFAULT_CONVECTIVE_INTENSITY,
    gradientThreshold = DEFAULT_CONVECTIVE_GRADIENT,
  } = options;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('convectiveMask: width and height must be positive integers');
  }
  if (!grid || grid.length !== width * height) {
    throw new Error('convectiveMask: grid length does not match width*height');
  }
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const c = grid[row + x];
      const ix = c - intensityThreshold;
      if (ix <= 0) continue;
      // 3×3 Sobel-style gradient on grid intensity.
      const gx = (grid[row + x + 1] - grid[row + x - 1]) / 2;
      const gy = (grid[row + x + width] - grid[row + x - width]) / 2;
      const gMag = Math.hypot(gx, gy);
      const gFactor = gMag - gradientThreshold;
      if (gFactor <= 0) continue;
      out[row + x] = ix * gFactor;
    }
  }
  return { width, height, grid: out };
}

/**
 * Fuse the three signals into a single non-negative score per pixel.
 *
 *   trend: { width, height, grid } from computeTrend — units mm/h per
 *          frame-interval. We use only the positive (growing) part.
 *   cape:  { width, height, grid } at the same resolution as the
 *          convective mask — already upsampled to match.
 *   capeRef: J/kg where the cape factor reaches 1; above this, capped.
 *
 * Any of trend/cape can be null; missing signals fall back to 1
 * (neutral) so the score still reflects the available evidence.
 */
export function thunderstormScore(convective, trend, cape, options = {}) {
  if (!convective?.grid) return null;
  const { capeRef = DEFAULT_CAPE_REF } = options;
  if (!(capeRef > 0)) {
    throw new Error('thunderstormScore: capeRef must be positive');
  }
  const { width, height, grid: convGrid } = convective;
  const n = width * height;
  if (trend && trend.grid && trend.grid.length !== n) {
    throw new Error('thunderstormScore: trend dimensions must match convective mask');
  }
  if (cape && cape.grid && cape.grid.length !== n) {
    throw new Error('thunderstormScore: cape dimensions must match convective mask');
  }
  const out = new Float32Array(n);
  const trendGrid = trend?.grid ?? null;
  const capeGrid = cape?.grid ?? null;
  for (let p = 0; p < n; p++) {
    const c = convGrid[p];
    if (c <= 0) continue;
    // Trend factor: only positive (growing) cells contribute. Neutral 1
    // when trend is absent.
    let tFactor = 1;
    if (trendGrid) {
      const tv = trendGrid[p];
      tFactor = tv > 0 ? 1 + tv : 0;
      if (tFactor <= 0) continue;
    }
    // CAPE factor: linear ramp 0..1 to capeRef, clipped above.
    let capeFactor = 1;
    if (capeGrid) {
      const cv = capeGrid[p];
      capeFactor = cv > 0 ? Math.min(1, cv / capeRef) : 0;
      if (capeFactor <= 0) continue;
    }
    out[p] = c * tFactor * capeFactor;
  }
  return { width, height, grid: out };
}

/**
 * Sequential transparent → bright-red colormap for the final score.
 * Saturates at `scale`; below `epsilon` short-circuits to transparent
 * to avoid speckling clean regions.
 */
export function encodeThunderstormToRgba(grid, width, height, options = {}) {
  const { scale = DEFAULT_THUNDER_SCALE, maxAlpha = DEFAULT_THUNDER_MAX_ALPHA } = options;
  if (!(scale > 0)) throw new Error('encodeThunderstormToRgba: scale must be positive');
  const expected = width * height;
  if (grid.length !== expected) {
    throw new Error(`encodeThunderstormToRgba: grid length ${grid.length} != width*height ${expected}`);
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const epsilon = 0.05;
  for (let p = 0, i = 0; p < grid.length; p++, i += 4) {
    const v = grid[p];
    if (!Number.isFinite(v) || v <= 0) continue;
    let t = v / scale;
    if (t > 1) t = 1;
    if (t < epsilon) continue;
    // 0 → magenta-pink (240, 70, 130), 1 → deep red-orange (200, 30, 30)
    out[i] = 240 - 40 * t;
    out[i + 1] = 70 - 40 * t;
    out[i + 2] = 130 - 100 * t;
    out[i + 3] = t * maxAlpha;
  }
  return out;
}
