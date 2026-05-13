/**
 * Per-pixel intensity-trend computation.
 *
 * Fits a least-squares line through the rain rate at each pixel over
 * the last `window` observed frames. Positive slope = cell is growing,
 * negative = decaying, zero = stable. Output units are mm/h per
 * frame-interval; downstream advection multiplies by `dt` so growth
 * applies correctly at fractional time-steps.
 *
 * For evenly-spaced frames the x-variance is constant (Σ(i-x̄)² for
 * i ∈ 0..k-1) so we lift it out of the inner loop. Per-pixel cost
 * collapses to two passes over k frames: O(W * H * k).
 *
 * Pure function — no DOM, no Spektrum.
 */

export const DEFAULT_TREND_WINDOW = 4;
/** Trend-magnitude cutoff for the colormap: anything beyond ±scale is
 *  clamped to ±1 (full saturation). Units are mm/h per frame-interval. */
export const DEFAULT_TREND_COLORMAP_SCALE = 1.0;
/** Maximum alpha for non-zero trend pixels (0..255). 200 ≈ 0.78 → the
 *  underlying radar stays partly visible. */
export const DEFAULT_TREND_MAX_ALPHA = 200;

export function computeTrend(history, options = {}) {
  const { window = DEFAULT_TREND_WINDOW } = options;
  if (!Number.isInteger(window) || window < 2) {
    throw new Error('computeTrend: window must be an integer >= 2');
  }
  if (!Array.isArray(history) || history.length < 2) return null;

  const k = Math.min(window, history.length);
  const recent = history.slice(-k);
  const ref = recent[0];
  const w = ref.width;
  const h = ref.height;
  const n = w * h;

  for (const f of recent) {
    if (f.width !== w || f.height !== h) {
      throw new Error('computeTrend: all frames must share dimensions');
    }
    if (!f.grid || f.grid.length !== n) {
      throw new Error('computeTrend: frame.grid length does not match width*height');
    }
  }

  // x_i = i for i ∈ 0..k-1; x̄ = (k-1)/2;  Σ(i-x̄)² = k(k²-1)/12
  const xMean = (k - 1) / 2;
  const xVariance = (k * (k * k - 1)) / 12;
  // For k=2 xVariance = 0.5; for k=4, = 5; for k=12, = 143. Always > 0.

  const grid = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    let yMean = 0;
    for (let i = 0; i < k; i++) yMean += recent[i].grid[p];
    yMean /= k;

    let covar = 0;
    for (let i = 0; i < k; i++) {
      covar += (i - xMean) * (recent[i].grid[p] - yMean);
    }
    grid[p] = covar / xVariance;
  }

  return { width: w, height: h, window: k, grid };
}

/**
 * Diverging colormap. Positive trend (growth) → red; negative
 * (decay) → blue; near-zero → transparent. Alpha scales with
 * |trend|/scale so weak signals are faint, strong signals are bold.
 * Returns an RGBA Uint8ClampedArray suitable for ImageData.data.set().
 */
export function encodeTrendToRgba(grid, width, height, options = {}) {
  const { scale = DEFAULT_TREND_COLORMAP_SCALE, maxAlpha = DEFAULT_TREND_MAX_ALPHA } = options;
  if (!(scale > 0)) throw new Error('encodeTrendToRgba: scale must be positive');
  const expected = width * height;
  if (grid.length !== expected) {
    throw new Error(`encodeTrendToRgba: grid length ${grid.length} != width*height ${expected}`);
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const epsilon = 0.01;
  for (let p = 0, i = 0; p < grid.length; p++, i += 4) {
    const v = grid[p];
    if (!Number.isFinite(v)) continue;
    let t = v / scale;
    if (t > 1) t = 1;
    if (t < -1) t = -1;
    if (Math.abs(t) < epsilon) continue; // RGBA already zero
    if (t > 0) {
      out[i] = 240; out[i + 1] = 80; out[i + 2] = 60;
      out[i + 3] = t * maxAlpha;
    } else {
      out[i] = 60; out[i + 1] = 130; out[i + 2] = 240;
      out[i + 3] = -t * maxAlpha;
    }
  }
  return out;
}
