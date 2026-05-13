/**
 * Inter-frame interpolation. RainViewer publishes a radar frame every
 * 10 minutes; advecting at fractional `dt` between adjacent frames
 * injects sub-frames so playback feels smooth instead of slideshow-like.
 *
 * For each pair (history[i], history[i+1]) with their fitted flow
 * pairs[i], generate `factor - 1` intermediate frames at
 *   dt = 1/factor, 2/factor, ..., (factor-1)/factor
 * via semi-Lagrangian advection of history[i]. The endpoints (the
 * original observed frames) are included unchanged so the result
 * interleaves observed and computed frames in chronological order.
 *
 * Pure functions only.
 */

import { advectStep } from './advect.js';

export const DEFAULT_INTERPOLATION_FACTOR = 4;

/**
 * Inter-frame interpolation across a full decoded history.
 *
 *   decoded: array of { time, grid, width, height }
 *   pairs:   array of flow fields (length decoded.length - 1)
 *   factor:  how many output frames per observed-frame interval.
 *            factor=1 → no interpolation (returns observed only).
 *            factor=4 → 3 intermediate frames per pair → 4× density.
 *
 * Returns an array of { time, grid, width, height, observed: bool }.
 * Length = decoded.length + (decoded.length - 1) * (factor - 1).
 */
export function interpolateHistory(decoded, pairs, factor = DEFAULT_INTERPOLATION_FACTOR) {
  if (!Number.isInteger(factor) || factor < 1) {
    throw new Error('interpolateHistory: factor must be a positive integer');
  }
  if (!Array.isArray(decoded) || decoded.length === 0) return [];
  if (factor === 1 || decoded.length < 2) {
    return decoded.map((f) => ({ ...f, observed: true }));
  }
  if (!Array.isArray(pairs) || pairs.length !== decoded.length - 1) {
    throw new Error(`interpolateHistory: pairs.length ${pairs?.length} != decoded.length - 1 (${decoded.length - 1})`);
  }

  const out = [];
  for (let i = 0; i < decoded.length - 1; i++) {
    const a = decoded[i];
    const b = decoded[i + 1];
    const flow = pairs[i];
    const dtNext = b.time - a.time;

    // Push the observed start of this pair
    out.push({ ...a, observed: true });

    // Two-sided morph interpolation: advect `a` FORWARD by t AND advect
    // `b` BACKWARD by (1 - t), then per-cell max-blend. Pure forward-
    // advection alone causes the bilinear sampler to bleed away peaks
    // over multiple sub-steps, leaving "holes" of light-blue in the
    // centre of moving storm cells. Max-blending preserves peaks from
    // whichever endpoint still holds them at that moment.
    for (let k = 1; k < factor; k++) {
      const t = k / factor;
      const fwd  = advectStep(a.grid, flow, a.width, a.height, { dt:  t });
      const back = advectStep(b.grid, flow, a.width, a.height, { dt: -(1 - t) });
      const grid = new Float32Array(a.width * a.height);
      for (let p = 0; p < grid.length; p++) {
        const fv = fwd[p];
        const bv = back[p];
        grid[p] = fv > bv ? fv : bv;
      }
      out.push({
        time: a.time + dtNext * t,
        grid,
        width: a.width,
        height: a.height,
        observed: false,
      });
    }
  }
  // Push the final observed frame (the one we didn't push as a "start")
  out.push({ ...decoded[decoded.length - 1], observed: true });

  return out;
}
