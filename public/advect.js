/**
 * Semi-Lagrangian advection.
 *
 * For each output cell (x, y):
 *   1. Sample the flow field at (x, y) — bilinear interp into the
 *      block-resolution flow grid
 *   2. Trace backward in time: source = (x - vx*dt, y - vy*dt)
 *   3. Bilinear sample the input scalar field at the source position
 *   4. output[x, y] = that sampled value
 *
 * This is the standard "back-trace" semi-Lagrangian scheme: stable
 * (no CFL constraint on dt), approximately mass-preserving, and
 * embarrassingly parallel. Out-of-bounds source positions become 0
 * (rain that drifts off the domain is lost — physically realistic
 * for a finite radar tile).
 *
 * Pure functions only — no DOM, no Spektrum.
 */

/** Default sub-pixel sampling tolerance for boundary handling. */
const EPS = 1e-9;

export function advectStep(input, flow, width, height, options = {}) {
  const { dt = 1, trend = null, trendStrength = 1 } = options;
  validate(input, flow, width, height);
  if (trend && (trend.grid?.length !== width * height || trend.width !== width || trend.height !== height)) {
    throw new Error('advectStep: trend dimensions must match input width/height');
  }
  const out = new Float32Array(width * height);
  const flowW = flow.width;
  const flowH = flow.height;
  const blockSize = flow.blockSize;
  const trendGrid = trend?.grid ?? null;
  const trendDt = trendStrength * dt;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Sample flow at (x, y). Flow vectors sit at block centres:
      //   block (bx, by) centre = ((bx+0.5)*blockSize, (by+0.5)*blockSize).
      // So the flow-grid coordinate of pixel (x, y) is:
      //   (x / blockSize - 0.5, y / blockSize - 0.5).
      const { vx, vy } = sampleFlow(flow, flowW, flowH, blockSize, x, y);
      const sx = x - vx * dt;
      const sy = y - vy * dt;
      let value = bilinearSample(input, width, height, sx, sy);
      // Source-cell growth/decay: the cell that brought the rain here
      // was growing/shrinking; apply that trend over the same dt.
      // Bilinear-sampling the trend grid (rather than nearest-neighbour)
      // keeps gradients smooth across pixels.
      if (trendGrid) {
        const trendRate = bilinearSample(trendGrid, width, height, sx, sy);
        value += trendRate * trendDt;
        // Clamp to non-negative mm/h — negative rain isn't a thing.
        if (value < 0) value = 0;
      }
      out[y * width + x] = value;
    }
  }
  return out;
}

/**
 * Generate N forecast frames by repeatedly advecting the starting
 * frame along the same flow. Returns an array of length N (does not
 * include the starting frame).
 *
 * Each step uses dt=1 by default, advancing the field by one
 * frame-interval of motion per step. Pass `dt < 1` for fractional
 * steps (used by Story 6.5 inter-frame interpolation).
 */
export function forecast(initial, flow, n, width, height, options = {}) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('forecast: n must be a non-negative integer');
  }
  const { dt = 1, trend = null, trendStrength = 1 } = options;
  const frames = [];
  let current = initial;
  for (let i = 0; i < n; i++) {
    current = advectStep(current, flow, width, height, { dt, trend, trendStrength });
    frames.push(current);
  }
  return frames;
}

/**
 * Bilinear sample of a 2D Float32Array `grid` at fractional (x, y).
 * Out-of-bounds → 0 (no rain flowing in from outside the domain).
 */
export function bilinearSample(grid, width, height, x, y) {
  if (x < -EPS || x > width - 1 + EPS) return 0;
  if (y < -EPS || y > height - 1 + EPS) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const tx = x - x0;
  const ty = y - y0;
  const i00 = y0 * width + x0;
  const i10 = y0 * width + x1;
  const i01 = y1 * width + x0;
  const i11 = y1 * width + x1;
  const v00 = grid[i00];
  const v10 = grid[i10];
  const v01 = grid[i01];
  const v11 = grid[i11];
  return (
    v00 * (1 - tx) * (1 - ty) +
    v10 * tx * (1 - ty) +
    v01 * (1 - tx) * ty +
    v11 * tx * ty
  );
}

/**
 * Bilinear sample of the flow field at pixel-space (px, py). Returns
 * {vx, vy}. Out-of-flow-bounds clamps to the nearest valid flow cell
 * (radar at the edge still has a defined direction of motion).
 */
export function sampleFlow(flow, flowW, flowH, blockSize, px, py) {
  let fx = px / blockSize - 0.5;
  let fy = py / blockSize - 0.5;
  if (fx < 0) fx = 0;
  if (fy < 0) fy = 0;
  if (fx > flowW - 1) fx = flowW - 1;
  if (fy > flowH - 1) fy = flowH - 1;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, flowW - 1);
  const y1 = Math.min(y0 + 1, flowH - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = (y0 * flowW + x0) * 2;
  const i10 = (y0 * flowW + x1) * 2;
  const i01 = (y1 * flowW + x0) * 2;
  const i11 = (y1 * flowW + x1) * 2;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  const vx =
    flow.data[i00] * w00 +
    flow.data[i10] * w10 +
    flow.data[i01] * w01 +
    flow.data[i11] * w11;
  const vy =
    flow.data[i00 + 1] * w00 +
    flow.data[i10 + 1] * w10 +
    flow.data[i01 + 1] * w01 +
    flow.data[i11 + 1] * w11;
  return { vx, vy };
}

function validate(input, flow, width, height) {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error('advectStep: width must be a positive integer');
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error('advectStep: height must be a positive integer');
  }
  if (!input || input.length !== width * height) {
    throw new Error(`advectStep: input length ${input?.length} != width*height ${width * height}`);
  }
  if (!flow || !flow.data || !flow.width || !flow.height || !flow.blockSize) {
    throw new Error('advectStep: flow must shape as {width, height, blockSize, data}');
  }
  if (flow.data.length !== flow.width * flow.height * 2) {
    throw new Error('advectStep: flow.data length does not match width*height*2');
  }
}
