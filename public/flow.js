/**
 * TREC (Tracking Radar Echoes by Correlation) optical flow — pure JS.
 *
 * For each non-overlapping block in the previous frame, search a small
 * window in the current frame for the offset that minimises sum-of-
 * squared-differences. The winning (dx, dy) becomes that block's flow
 * vector. Industry standard for radar nowcasting since the 1980s and
 * embarrassingly parallel — a WebGL kernel will be a drop-in replacement
 * if/when CPU profiling justifies it.
 *
 * Output: a Float32Array of length flowW * flowH * 2 packed [vx, vy, ...]
 * with one vector per block (block size defaults to 16, so a 256×256
 * input produces a 16×16 flow field).
 */

export const DEFAULT_BLOCK_SIZE = 16;
export const DEFAULT_SEARCH_RADIUS = 8;
export const DEFAULT_SMOOTHING_WINDOW = 3;

export function computeFlow(prev, curr, width, height, options = {}) {
  const { blockSize = DEFAULT_BLOCK_SIZE, searchRadius = DEFAULT_SEARCH_RADIUS } = options;
  validateGrids(prev, curr, width, height);
  if (!Number.isInteger(blockSize) || blockSize <= 0) {
    throw new Error('computeFlow: blockSize must be a positive integer');
  }
  if (!Number.isInteger(searchRadius) || searchRadius < 0) {
    throw new Error('computeFlow: searchRadius must be a non-negative integer');
  }

  const flowW = Math.floor(width / blockSize);
  const flowH = Math.floor(height / blockSize);
  const data = new Float32Array(flowW * flowH * 2);

  for (let by = 0; by < flowH; by++) {
    for (let bx = 0; bx < flowW; bx++) {
      const [vx, vy] = bestMatch(
        prev, curr,
        bx * blockSize, by * blockSize,
        blockSize, searchRadius,
        width, height,
      );
      const idx = (by * flowW + bx) * 2;
      data[idx] = vx;
      data[idx + 1] = vy;
    }
  }

  return { width: flowW, height: flowH, blockSize, data };
}

/**
 * Average a stack of flow fields (last-N temporal smoothing).
 * All fields must have matching dimensions; mismatches throw.
 */
export function smoothFlows(fields) {
  if (!Array.isArray(fields) || fields.length === 0) return null;
  const ref = fields[0];
  for (let i = 1; i < fields.length; i++) {
    const f = fields[i];
    if (f.width !== ref.width || f.height !== ref.height) {
      throw new Error('smoothFlows: all fields must share dimensions');
    }
  }
  const data = new Float32Array(ref.data.length);
  for (let i = 0; i < data.length; i++) {
    let sum = 0;
    for (let k = 0; k < fields.length; k++) sum += fields[k].data[i];
    data[i] = sum / fields.length;
  }
  return { width: ref.width, height: ref.height, blockSize: ref.blockSize, data };
}

/**
 * Compute the flow field between every adjacent pair of grids in
 * `history`. Returns an array of N-1 fields for N grids; pair i is the
 * motion from history[i] to history[i+1]. Empty array if <2 grids.
 *
 * Each history entry must shape as { grid: Float32Array, width, height }.
 */
export function computeFlowPairs(history, options = {}) {
  if (!Array.isArray(history) || history.length < 2) return [];
  const fields = [];
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1];
    const b = history[i];
    fields.push(computeFlow(a.grid, b.grid, a.width, a.height, options));
  }
  return fields;
}

/**
 * Convenience: compute per-pair fields and return the last `window`
 * smoothed into a single field. Returns null if fewer than 2 grids.
 */
export function flowFromHistory(history, options = {}) {
  const { window = DEFAULT_SMOOTHING_WINDOW, ...flowOpts } = options;
  const pairs = computeFlowPairs(history, flowOpts);
  if (pairs.length === 0) return null;
  return smoothFlows(pairs.slice(-Math.max(1, window)));
}

function bestMatch(prev, curr, x0, y0, blockSize, search, w, h) {
  let bestSSD = Infinity;
  let bestDx = 0;
  let bestDy = 0;

  for (let dy = -search; dy <= search; dy++) {
    const ty = y0 + dy;
    if (ty < 0 || ty + blockSize > h) continue;
    for (let dx = -search; dx <= search; dx++) {
      const tx = x0 + dx;
      if (tx < 0 || tx + blockSize > w) continue;

      let ssd = 0;
      for (let py = 0; py < blockSize; py++) {
        const prevRow = (y0 + py) * w;
        const currRow = (ty + py) * w;
        for (let px = 0; px < blockSize; px++) {
          const d = prev[prevRow + x0 + px] - curr[currRow + tx + px];
          ssd += d * d;
          if (ssd >= bestSSD) break;
        }
        if (ssd >= bestSSD) break;
      }

      if (ssd < bestSSD) {
        bestSSD = ssd;
        bestDx = dx;
        bestDy = dy;
      }
    }
  }

  return [bestDx, bestDy];
}

function validateGrids(prev, curr, width, height) {
  if (!Number.isInteger(width) || width <= 0) {
    throw new Error('computeFlow: width must be a positive integer');
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new Error('computeFlow: height must be a positive integer');
  }
  const expected = width * height;
  if (!prev || prev.length !== expected) {
    throw new Error(`computeFlow: prev length ${prev?.length} != width*height ${expected}`);
  }
  if (!curr || curr.length !== expected) {
    throw new Error(`computeFlow: curr length ${curr?.length} != width*height ${expected}`);
  }
}
