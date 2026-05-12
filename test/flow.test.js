import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BLOCK_SIZE,
  DEFAULT_SEARCH_RADIUS,
  DEFAULT_SMOOTHING_WINDOW,
  computeFlow,
  computeFlowPairs,
  smoothFlows,
  flowFromHistory,
} from '../public/flow.js';

/** Build a width x height grid where each pixel = f(x, y). */
function makeGrid(width, height, f) {
  const g = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      g[y * width + x] = f(x, y);
    }
  }
  return g;
}

/** Shift `src` by (dx, dy) pixels into a new grid; out-of-bounds becomes 0. */
function shifted(src, width, height, dx, dy) {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = y - dy;
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x++) {
      const sx = x - dx;
      if (sx < 0 || sx >= width) continue;
      out[y * width + x] = src[sy * width + sx];
    }
  }
  return out;
}

/** A textured 64x64 grid that's not flat — required for SSD to have a unique minimum. */
function texturedGrid(w, h) {
  return makeGrid(w, h, (x, y) =>
    Math.sin(x * 0.4) * Math.cos(y * 0.3) + Math.sin((x + y) * 0.2) * 0.5,
  );
}

describe('exports', () => {
  test('exports sensible defaults', () => {
    assert.equal(DEFAULT_BLOCK_SIZE, 16);
    assert.equal(DEFAULT_SEARCH_RADIUS, 8);
    assert.equal(DEFAULT_SMOOTHING_WINDOW, 3);
  });
});

describe('computeFlow', () => {
  test('returns zero flow on identical frames', () => {
    const grid = texturedGrid(64, 64);
    const flow = computeFlow(grid, grid, 64, 64);
    assert.equal(flow.width, 4);
    assert.equal(flow.height, 4);
    assert.equal(flow.blockSize, 16);
    for (let i = 0; i < flow.data.length; i++) {
      assert.equal(flow.data[i], 0, `expected zero at idx ${i}, got ${flow.data[i]}`);
    }
  });

  test('detects uniform translation to the right (+3, 0)', () => {
    const prev = texturedGrid(64, 64);
    const curr = shifted(prev, 64, 64, 3, 0);
    const flow = computeFlow(prev, curr, 64, 64);

    // Interior blocks (away from edges where shifted-in zeros confuse SSD)
    // should agree with the truth vector.
    let agreeing = 0;
    for (let by = 1; by < flow.height - 1; by++) {
      for (let bx = 1; bx < flow.width - 1; bx++) {
        const i = (by * flow.width + bx) * 2;
        if (flow.data[i] === 3 && flow.data[i + 1] === 0) agreeing++;
      }
    }
    const interiorBlocks = (flow.width - 2) * (flow.height - 2);
    assert.ok(agreeing === interiorBlocks, `expected all ${interiorBlocks} interior blocks to match, got ${agreeing}`);
  });

  test('detects uniform translation downward (0, +2)', () => {
    const prev = texturedGrid(64, 64);
    const curr = shifted(prev, 64, 64, 0, 2);
    const flow = computeFlow(prev, curr, 64, 64);

    let agreeing = 0;
    for (let by = 1; by < flow.height - 1; by++) {
      for (let bx = 1; bx < flow.width - 1; bx++) {
        const i = (by * flow.width + bx) * 2;
        if (flow.data[i] === 0 && flow.data[i + 1] === 2) agreeing++;
      }
    }
    const interiorBlocks = (flow.width - 2) * (flow.height - 2);
    assert.ok(agreeing === interiorBlocks);
  });

  test('detects diagonal translation (+2, +2)', () => {
    const prev = texturedGrid(64, 64);
    const curr = shifted(prev, 64, 64, 2, 2);
    const flow = computeFlow(prev, curr, 64, 64);
    const i = (2 * flow.width + 2) * 2; // an interior block
    assert.equal(flow.data[i], 2);
    assert.equal(flow.data[i + 1], 2);
  });

  test('respects custom blockSize and searchRadius', () => {
    const prev = texturedGrid(32, 32);
    const curr = shifted(prev, 32, 32, 1, 0);
    const flow = computeFlow(prev, curr, 32, 32, { blockSize: 8, searchRadius: 4 });
    assert.equal(flow.width, 4);
    assert.equal(flow.height, 4);
    assert.equal(flow.blockSize, 8);
    const i = (1 * flow.width + 1) * 2;
    assert.equal(flow.data[i], 1);
    assert.equal(flow.data[i + 1], 0);
  });

  test('search radius limits detectable motion', () => {
    const prev = texturedGrid(64, 64);
    const curr = shifted(prev, 64, 64, 6, 0);
    const flow = computeFlow(prev, curr, 64, 64, { searchRadius: 2 });
    // Cannot resolve a 6-pixel shift with a radius-2 search; best it can do is 2.
    const i = (2 * flow.width + 2) * 2;
    assert.equal(flow.data[i], 2);
  });

  test('throws on dimension mismatch', () => {
    const grid = new Float32Array(64);
    assert.throws(() => computeFlow(grid, grid, 16, 8), /prev length/);
  });

  test('throws on invalid block size', () => {
    const grid = new Float32Array(256);
    assert.throws(() => computeFlow(grid, grid, 16, 16, { blockSize: 0 }), /blockSize/);
    assert.throws(() => computeFlow(grid, grid, 16, 16, { blockSize: -1 }), /blockSize/);
    assert.throws(() => computeFlow(grid, grid, 16, 16, { blockSize: 1.5 }), /blockSize/);
  });

  test('throws on invalid search radius', () => {
    const grid = new Float32Array(256);
    assert.throws(() => computeFlow(grid, grid, 16, 16, { searchRadius: -1 }), /searchRadius/);
    assert.throws(() => computeFlow(grid, grid, 16, 16, { searchRadius: 1.5 }), /searchRadius/);
  });

  test('throws on invalid width or height', () => {
    const grid = new Float32Array(256);
    assert.throws(() => computeFlow(grid, grid, 0, 16), /width/);
    assert.throws(() => computeFlow(grid, grid, 16, -1), /height/);
  });

  test('throws on null grid', () => {
    const grid = new Float32Array(256);
    assert.throws(() => computeFlow(null, grid, 16, 16), /prev length/);
    assert.throws(() => computeFlow(grid, null, 16, 16), /curr length/);
  });
});

describe('smoothFlows', () => {
  const mkField = (w, h, fill) => ({
    width: w, height: h, blockSize: 16,
    data: Float32Array.from({ length: w * h * 2 }, () => fill),
  });

  test('returns null for empty or non-array input', () => {
    assert.equal(smoothFlows([]), null);
    assert.equal(smoothFlows(null), null);
    assert.equal(smoothFlows(undefined), null);
  });

  test('passes a single field through (mean of one = itself)', () => {
    const a = mkField(2, 2, 3);
    const out = smoothFlows([a]);
    assert.deepEqual([...out.data], [3, 3, 3, 3, 3, 3, 3, 3]);
  });

  test('averages multiple fields component-wise', () => {
    const a = mkField(2, 2, 2);
    const b = mkField(2, 2, 4);
    const c = mkField(2, 2, 6);
    const out = smoothFlows([a, b, c]);
    // mean(2,4,6) = 4
    for (const v of out.data) assert.equal(v, 4);
  });

  test('throws when fields have mismatched dimensions', () => {
    assert.throws(
      () => smoothFlows([mkField(2, 2, 0), mkField(3, 3, 0)]),
      /must share dimensions/,
    );
  });

  test('preserves blockSize, width, height from the first field', () => {
    const a = mkField(4, 3, 0);
    a.blockSize = 32;
    const out = smoothFlows([a]);
    assert.equal(out.width, 4);
    assert.equal(out.height, 3);
    assert.equal(out.blockSize, 32);
  });
});

describe('computeFlowPairs', () => {
  test('returns [] for fewer than 2 entries', () => {
    assert.deepEqual(computeFlowPairs([]), []);
    assert.deepEqual(computeFlowPairs([{ grid: new Float32Array(4), width: 2, height: 2 }]), []);
    assert.deepEqual(computeFlowPairs(null), []);
    assert.deepEqual(computeFlowPairs(undefined), []);
  });

  test('returns N-1 fields for N grids', () => {
    const w = 64, h = 64;
    const base = texturedGrid(w, h);
    const history = [
      { grid: base, width: w, height: h },
      { grid: shifted(base, w, h, 1, 0), width: w, height: h },
      { grid: shifted(base, w, h, 2, 0), width: w, height: h },
      { grid: shifted(base, w, h, 3, 0), width: w, height: h },
    ];
    const pairs = computeFlowPairs(history);
    assert.equal(pairs.length, 3);
  });

  test('each pair captures the motion from history[i] to history[i+1]', () => {
    const w = 64, h = 64;
    const base = texturedGrid(w, h);
    // Three different per-step motions: +1, +3, +5
    const history = [
      { grid: base, width: w, height: h },
      { grid: shifted(base, w, h, 1, 0), width: w, height: h },
      { grid: shifted(base, w, h, 4, 0), width: w, height: h },  // +3 from prev
      { grid: shifted(base, w, h, 9, 0), width: w, height: h },  // +5 from prev
    ];
    const pairs = computeFlowPairs(history);
    // Sample interior block (2,2) of each pair
    const i = (2 * pairs[0].width + 2) * 2;
    assert.equal(pairs[0].data[i], 1);
    assert.equal(pairs[1].data[i], 3);
    assert.equal(pairs[2].data[i], 5);
  });

  test('forwards block-size and search-radius options', () => {
    const w = 32, h = 32;
    const base = texturedGrid(w, h);
    const history = [
      { grid: base, width: w, height: h },
      { grid: shifted(base, w, h, 1, 0), width: w, height: h },
    ];
    const pairs = computeFlowPairs(history, { blockSize: 8, searchRadius: 4 });
    assert.equal(pairs[0].blockSize, 8);
    assert.equal(pairs[0].width, 4);
  });
});

describe('flowFromHistory', () => {
  test('returns null for fewer than 2 entries', () => {
    assert.equal(flowFromHistory([]), null);
    assert.equal(flowFromHistory([{ grid: new Float32Array(4), width: 2, height: 2 }]), null);
    assert.equal(flowFromHistory(null), null);
  });

  test('produces a smoothed field from a moving sequence', () => {
    const w = 64, h = 64;
    const base = texturedGrid(w, h);
    const history = [
      { grid: base, width: w, height: h },
      { grid: shifted(base, w, h, 1, 0), width: w, height: h },
      { grid: shifted(base, w, h, 2, 0), width: w, height: h },
      { grid: shifted(base, w, h, 3, 0), width: w, height: h },
    ];
    const out = flowFromHistory(history, { window: 3 });
    // Three frame-pairs at (+1,0). Smoothed mean should still be ~1 in vx.
    const i = (2 * out.width + 2) * 2;
    assert.ok(Math.abs(out.data[i] - 1) < 1e-9);
    assert.equal(out.data[i + 1], 0);
  });

  test('only smooths the last `window` pairs', () => {
    const w = 64, h = 64;
    const base = texturedGrid(w, h);
    // Five frames: first two pairs at +1, last two pairs at +3.
    const history = [
      { grid: base, width: w, height: h },
      { grid: shifted(base, w, h, 1, 0), width: w, height: h },
      { grid: shifted(base, w, h, 2, 0), width: w, height: h },
      { grid: shifted(base, w, h, 5, 0), width: w, height: h },
      { grid: shifted(base, w, h, 8, 0), width: w, height: h },
    ];
    const out = flowFromHistory(history, { window: 2 });
    // Last two pairs: (5 - 2) = +3 and (8 - 5) = +3. Smoothed mean = 3.
    const i = (2 * out.width + 2) * 2;
    assert.ok(Math.abs(out.data[i] - 3) < 1e-9);
  });

  test('clamps window to at least 1 (avoids slice(0))', () => {
    const w = 64, h = 64;
    const base = texturedGrid(w, h);
    const history = [
      { grid: base, width: w, height: h },
      { grid: shifted(base, w, h, 2, 0), width: w, height: h },
    ];
    const out = flowFromHistory(history, { window: 0 });
    const i = (2 * out.width + 2) * 2;
    assert.equal(out.data[i], 2);
  });
});
