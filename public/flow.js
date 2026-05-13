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

/** Default exponential-decay rate for weighted temporal smoothing.
 *  weight[i] = decay^(newest_idx - i). 0.7 → newest pair gets ~30% of
 *  total weight, half-life ≈ 2 pairs (~20 min at 10-min cadence).
 *  Smaller = more responsive, larger = more stable. */
export const DEFAULT_TEMPORAL_DECAY = 0.7;

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
 * Uniform average of a stack of flow fields (each field gets weight 1/N).
 * All fields must share dimensions.
 */
export function smoothFlows(fields) {
  return smoothFlowsWeighted(fields, { decay: 1 });
}

/**
 * Exponential-decay weighted average of a stack of flow fields, ordered
 * oldest-first. The newest field (last in array) gets weight 1; each
 * older field gets weight = decay × the next-newer one's weight.
 * decay = 1 reduces to a uniform average; decay → 0 collapses to "use
 * only the latest field". The default 0.7 has a ~2-pair half-life.
 *
 * Why bother: a single per-pair flow field has noisy patches (low-
 * contrast blocks, brief speckle, rotation that block-matching can't
 * resolve). Uniform averaging over a small window dilutes those errors
 * but loses responsiveness. Exponential decay over a larger window keeps
 * recent-bias for direction changes while letting the older 8 pairs
 * collectively dampen one-off bad pairs.
 */
export function smoothFlowsWeighted(fields, options = {}) {
  if (!Array.isArray(fields) || fields.length === 0) return null;
  const { decay = DEFAULT_TEMPORAL_DECAY } = options;
  if (!Number.isFinite(decay) || decay <= 0 || decay > 1) {
    throw new Error('smoothFlowsWeighted: decay must be in (0, 1]');
  }
  const ref = fields[0];
  for (let i = 1; i < fields.length; i++) {
    const f = fields[i];
    if (f.width !== ref.width || f.height !== ref.height) {
      throw new Error('smoothFlowsWeighted: all fields must share dimensions');
    }
  }

  // Precompute weights: weights[i] = decay^(newestIdx - i)
  const N = fields.length;
  const weights = new Float64Array(N);
  let weightSum = 0;
  for (let i = 0; i < N; i++) {
    weights[i] = Math.pow(decay, (N - 1) - i);
    weightSum += weights[i];
  }

  const len = ref.data.length;
  const data = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0;
    for (let k = 0; k < N; k++) sum += weights[k] * fields[k].data[i];
    data[i] = sum / weightSum;
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
 * one, and return all pairs collapsed into a single field via
 * exponential-decay weighted averaging. Returns null if fewer than 2
 * grids.
 *
 * Pass `decay: 1` for uniform averaging (legacy behaviour). Pass
 * `window: N` to limit the temporal extent (default uses all pairs).
 */
export function flowFromHistory(history, options = {}) {
  const {
    window,
    decay = DEFAULT_TEMPORAL_DECAY,
    medianFilterEach = true,
    ...flowOpts
  } = options;
  let pairs = computeFlowPairs(history, flowOpts);
  if (pairs.length === 0) return null;
  if (medianFilterEach) pairs = pairs.map(medianFilter);
  if (Number.isInteger(window) && window > 0) {
    pairs = pairs.slice(-window);
  }
  return smoothFlowsWeighted(pairs, { decay });
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
