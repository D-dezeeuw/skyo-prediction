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
 * with one vector per block. Three layered noise filters (intensity gate
 * at flow time, SSD-confidence drop, 3×3 vector median) keep false
 * positives from leaking into downstream advection.
 */

export const DEFAULT_BLOCK_SIZE = 16;
export const DEFAULT_SEARCH_RADIUS = 8;
export const DEFAULT_SMOOTHING_WINDOW = 3;

/** Default mean-rain-rate cutoff for the flow-time intensity gate.
 *  Blocks below this in BOTH source frames are marked as no-flow. */
export const DEFAULT_FLOW_INTENSITY_THRESHOLD = 0.05;

/** Default ratio of best-SSD to block energy above which we treat the
 *  match as coincidence rather than correspondence. >1 keeps everything;
 *  ~0.4 is a reasonable starting point for noisy radar. */
export const DEFAULT_FLOW_CONFIDENCE_THRESHOLD = 0.5;

export function computeFlow(prev, curr, width, height, options = {}) {
  const {
    blockSize = DEFAULT_BLOCK_SIZE,
    searchRadius = DEFAULT_SEARCH_RADIUS,
    intensityThreshold = 0,
    confidenceThreshold = Infinity,
  } = options;
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
  const blockArea = blockSize * blockSize;

  for (let by = 0; by < flowH; by++) {
    for (let bx = 0; bx < flowW; bx++) {
      const idx = (by * flowW + bx) * 2;

      // Intensity gate: skip blocks with no signal in either frame.
      // Block matching on flat-zero returns arbitrary zero motion.
      if (intensityThreshold > 0) {
        const meanPrev = blockMean(prev, width, bx * blockSize, by * blockSize, blockSize);
        const meanCurr = blockMean(curr, width, bx * blockSize, by * blockSize, blockSize);
        if (meanPrev < intensityThreshold && meanCurr < intensityThreshold) {
          // already zero-initialised
          continue;
        }
      }

      const { vx, vy, bestSSD, energy } = bestMatch(
        prev, curr,
        bx * blockSize, by * blockSize,
        blockSize, searchRadius,
        width, height,
      );

      // Confidence gate: drop matches that explain the block poorly.
      // Normalise by block energy so the threshold is intensity-invariant.
      if (Number.isFinite(confidenceThreshold) && energy > 0) {
        const ratio = bestSSD / (energy + blockArea); // +blockArea avoids div-near-zero on faint blocks
        if (ratio > confidenceThreshold) {
          continue;
        }
      }

      data[idx] = vx;
      data[idx + 1] = vy;
    }
  }

  return { width: flowW, height: flowH, blockSize, data };
}

/**
 * 3×3 vector-median filter. For each block, replace (vx, vy) with the
 * coordinate-wise median of itself and its eight neighbours. Outliers
 * that disagree with all surroundings get smoothed away; coherent
 * fronts pass through unchanged. Edge blocks use whatever neighbours
 * exist (no padding).
 */
export function medianFilter(field) {
  if (!field?.data) return field;
  const { width, height, blockSize, data } = field;
  const out = new Float32Array(data.length);
  const xs = [];
  const ys = [];
  for (let by = 0; by < height; by++) {
    for (let bx = 0; bx < width; bx++) {
      xs.length = 0;
      ys.length = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = by + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = bx + dx;
          if (nx < 0 || nx >= width) continue;
          const i = (ny * width + nx) * 2;
          xs.push(data[i]);
          ys.push(data[i + 1]);
        }
      }
      const idx = (by * width + bx) * 2;
      out[idx] = median(xs);
      out[idx + 1] = median(ys);
    }
  }
  return { width, height, blockSize, data: out };
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
 * Convenience: compute per-pair fields, optionally median-filter each
 * one, and return the last `window` smoothed into a single field.
 * Returns null if fewer than 2 grids.
 */
export function flowFromHistory(history, options = {}) {
  const {
    window = DEFAULT_SMOOTHING_WINDOW,
    medianFilterEach = true,
    ...flowOpts
  } = options;
  let pairs = computeFlowPairs(history, flowOpts);
  if (pairs.length === 0) return null;
  if (medianFilterEach) pairs = pairs.map(medianFilter);
  return smoothFlows(pairs.slice(-Math.max(1, window)));
}

function bestMatch(prev, curr, x0, y0, blockSize, search, w, h) {
  let bestSSD = Infinity;
  let bestDx = 0;
  let bestDy = 0;

  // Block energy = sum of squared values in the prev block. Used by the
  // confidence gate to normalise SSD against the block's own intensity.
  let energy = 0;
  for (let py = 0; py < blockSize; py++) {
    const row = (y0 + py) * w;
    for (let px = 0; px < blockSize; px++) {
      const v = prev[row + x0 + px];
      energy += v * v;
    }
  }

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

  return { vx: bestDx, vy: bestDy, bestSSD, energy };
}

function blockMean(grid, width, x0, y0, blockSize) {
  let sum = 0;
  for (let py = 0; py < blockSize; py++) {
    const row = (y0 + py) * width;
    for (let px = 0; px < blockSize; px++) {
      sum += grid[row + x0 + px];
    }
  }
  return sum / (blockSize * blockSize);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length & 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
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
