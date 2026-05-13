/**
 * Stochastic ensemble forecast (lightweight pysteps-STEPS analogue).
 *
 * Perturb the smoothed flow field N ways — rotate by ±θ, scale by 1±s —
 * advect each perturbation forward, then aggregate per-cell rain
 * probability across the resulting forecast streams. Cells where most
 * members rain → high probability; cells where only outliers rain →
 * low probability. The output is the "probability of rain over the
 * 2-hour horizon" grid that gets rendered as an overlay.
 *
 * Lighter than true STEPS (which uses spatially-correlated stochastic
 * noise plus a regression-on-AR(1) growth term) but captures the same
 * idea: a single deterministic forecast hides flow-uncertainty; an
 * ensemble surfaces it.
 *
 * Pure functions only. The advection driver (forecast loop) lives in
 * advect.js — this module just produces perturbed flow fields and
 * aggregates the results.
 */

export const DEFAULT_ENSEMBLE_SIZE = 8;
/** mm/h above which a cell counts as "rain" for probability accounting. */
export const DEFAULT_RAIN_THRESHOLD = 0.5;
export const DEFAULT_ROTATION_RANGE_DEG = 15;
export const DEFAULT_SCALE_RANGE = 0.15;
export const DEFAULT_PROBABILITY_MAX_ALPHA = 200;

/**
 * Build N perturbation parameter pairs (θ in radians, scale factor)
 * spread evenly across the configured ranges. The N=1 special case
 * returns the unperturbed (0, 1) pair so the API stays well-defined
 * for trivial ensemble sizes.
 */
export function buildPerturbations(n, options = {}) {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('buildPerturbations: n must be a positive integer');
  }
  const {
    rotationRangeDeg = DEFAULT_ROTATION_RANGE_DEG,
    scaleRange = DEFAULT_SCALE_RANGE,
  } = options;
  const out = [];
  if (n === 1) return [{ theta: 0, scale: 1 }];
  // Spread evenly across [-range, +range] inclusive.
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1); // 0..1
    const span = 2 * t - 1; // -1..+1
    const theta = (span * rotationRangeDeg * Math.PI) / 180;
    const scale = 1 + span * scaleRange;
    out.push({ theta, scale });
  }
  return out;
}

/**
 * Apply a (rotation, scale) perturbation to a flow field. Returns a
 * new flow object; original is untouched.
 *
 * For each block's (vx, vy):
 *   vx' = scale * (vx cos θ - vy sin θ)
 *   vy' = scale * (vx sin θ + vy cos θ)
 */
export function perturbFlow(flow, theta, scale) {
  if (!flow?.data) {
    throw new Error('perturbFlow: flow with .data required');
  }
  if (!Number.isFinite(theta) || !Number.isFinite(scale)) {
    throw new Error('perturbFlow: theta and scale must be finite numbers');
  }
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const data = new Float32Array(flow.data.length);
  for (let i = 0; i < flow.data.length; i += 2) {
    const vx = flow.data[i];
    const vy = flow.data[i + 1];
    data[i] = scale * (vx * cos - vy * sin);
    data[i + 1] = scale * (vx * sin + vy * cos);
  }
  return { width: flow.width, height: flow.height, blockSize: flow.blockSize, data };
}

/**
 * Across an array of forecast streams (each = array of Float32 grids),
 * compute per-cell probability of rain at each forecast step. Returns
 * an array of probability grids (one per step), each grid in [0, 1].
 */
export function computeProbabilityFields(forecasts, width, height, options = {}) {
  if (!Array.isArray(forecasts) || forecasts.length === 0) return [];
  const { rainThreshold = DEFAULT_RAIN_THRESHOLD } = options;
  const memberCount = forecasts.length;
  const stepCount = forecasts[0].length;
  const expected = width * height;
  // Validate
  for (const member of forecasts) {
    if (!Array.isArray(member) || member.length !== stepCount) {
      throw new Error('computeProbabilityFields: every member must have the same step count');
    }
    for (const step of member) {
      if (!step || step.length !== expected) {
        throw new Error('computeProbabilityFields: every step grid must be width*height long');
      }
    }
  }
  const out = [];
  for (let s = 0; s < stepCount; s++) {
    const counts = new Float32Array(expected);
    for (let m = 0; m < memberCount; m++) {
      const grid = forecasts[m][s];
      for (let p = 0; p < expected; p++) {
        if (grid[p] >= rainThreshold) counts[p] += 1;
      }
    }
    const probGrid = new Float32Array(expected);
    for (let p = 0; p < expected; p++) probGrid[p] = counts[p] / memberCount;
    out.push(probGrid);
  }
  return out;
}

/**
 * Aggregate a stack of per-step probability grids into one — per cell,
 * take the MAX probability across all forecast steps. Answers
 * "what's the highest chance of rain at this cell over the next 2 h?"
 */
export function maxProbabilityField(probabilityGrids, width, height) {
  if (!Array.isArray(probabilityGrids) || probabilityGrids.length === 0) {
    return { width, height, grid: new Float32Array(width * height) };
  }
  const expected = width * height;
  const out = new Float32Array(expected);
  for (const grid of probabilityGrids) {
    if (grid.length !== expected) {
      throw new Error('maxProbabilityField: grid length does not match width*height');
    }
    for (let p = 0; p < expected; p++) {
      if (grid[p] > out[p]) out[p] = grid[p];
    }
  }
  return { width, height, grid: out };
}

/**
 * Sequential transparent → blue → cyan → green → yellow colormap for
 * probability-of-rain (0..1). Below epsilon → transparent so empty
 * regions don't add visual static.
 */
export function encodeProbabilityToRgba(grid, width, height, options = {}) {
  const { maxAlpha = DEFAULT_PROBABILITY_MAX_ALPHA } = options;
  const expected = width * height;
  if (grid.length !== expected) {
    throw new Error(`encodeProbabilityToRgba: grid length ${grid.length} != width*height ${expected}`);
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const epsilon = 0.05;
  for (let p = 0, i = 0; p < grid.length; p++, i += 4) {
    const v = grid[p];
    if (!Number.isFinite(v) || v < epsilon) continue;
    let t = v > 1 ? 1 : v;
    // Three-stop ramp:
    //   0.0  → blue   (60, 100, 230)
    //   0.5  → cyan/green (60, 200, 130)
    //   1.0  → yellow (240, 220, 60)
    let r, g, b;
    if (t < 0.5) {
      const k = t / 0.5;
      r = 60;
      g = 100 + (200 - 100) * k;
      b = 230 + (130 - 230) * k;
    } else {
      const k = (t - 0.5) / 0.5;
      r = 60 + (240 - 60) * k;
      g = 200 + (220 - 200) * k;
      b = 130 + (60 - 130) * k;
    }
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = t * maxAlpha;
  }
  return out;
}
