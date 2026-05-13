import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TREND_WINDOW, computeTrend } from '../public/trend.js';

function frame(grid, w, h, time = 0) {
  return { time, grid: Float32Array.from(grid), width: w, height: h };
}

describe('DEFAULT_TREND_WINDOW', () => {
  test('defaults to 4 (~40 min of context at 10-min cadence)', () => {
    assert.equal(DEFAULT_TREND_WINDOW, 4);
  });
});

describe('computeTrend', () => {
  test('returns null for fewer than 2 frames', () => {
    assert.equal(computeTrend([]), null);
    assert.equal(computeTrend([frame([1, 2, 3, 4], 2, 2)]), null);
    assert.equal(computeTrend(null), null);
  });

  test('stable intensity → zero trend everywhere', () => {
    const a = frame([1, 2, 3, 4], 2, 2);
    const b = frame([1, 2, 3, 4], 2, 2);
    const c = frame([1, 2, 3, 4], 2, 2);
    const out = computeTrend([a, b, c]);
    for (let i = 0; i < out.grid.length; i++) assert.equal(out.grid[i], 0);
  });

  test('uniformly rising intensity → positive trend matching the step', () => {
    // Pixel goes 1 → 2 → 3 → 4 over 4 frames → slope = 1 mm/h per frame
    const a = frame([1, 5, 0, 10], 2, 2);
    const b = frame([2, 5, 0, 10], 2, 2);
    const c = frame([3, 5, 0, 10], 2, 2);
    const d = frame([4, 5, 0, 10], 2, 2);
    const out = computeTrend([a, b, c, d]);
    // Pixel 0: rises by 1 per step → slope 1
    assert.ok(Math.abs(out.grid[0] - 1) < 1e-9);
    // Pixel 1: constant 5 → slope 0
    assert.ok(Math.abs(out.grid[1]) < 1e-9);
    // Pixel 2: constant 0 → slope 0
    assert.ok(Math.abs(out.grid[2]) < 1e-9);
    // Pixel 3: constant 10 → slope 0
    assert.ok(Math.abs(out.grid[3]) < 1e-9);
  });

  test('uniformly falling intensity → negative trend', () => {
    const a = frame([10], 1, 1);
    const b = frame([8], 1, 1);
    const c = frame([6], 1, 1);
    const d = frame([4], 1, 1);
    const out = computeTrend([a, b, c, d]);
    assert.ok(Math.abs(out.grid[0] + 2) < 1e-9, `expected -2, got ${out.grid[0]}`);
  });

  test('honours window option (only uses last N frames)', () => {
    // Five frames: 0, 0, 1, 2, 3. Last 3 frames: 1, 2, 3 → slope = 1.
    // Full history slope would be different.
    const seq = [0, 0, 1, 2, 3].map((v) => frame([v], 1, 1));
    const out = computeTrend(seq, { window: 3 });
    assert.ok(Math.abs(out.grid[0] - 1) < 1e-9);
    assert.equal(out.window, 3);
  });

  test('window clamps to history.length when shorter', () => {
    const seq = [1, 2].map((v) => frame([v], 1, 1));
    const out = computeTrend(seq, { window: 10 });
    assert.equal(out.window, 2);
    // 2 frames: slope from (0, 1) to (1, 2) = 1
    assert.equal(out.grid[0], 1);
  });

  test('output preserves width/height', () => {
    const a = frame(new Array(12).fill(0), 4, 3);
    const b = frame(new Array(12).fill(1), 4, 3);
    const out = computeTrend([a, b]);
    assert.equal(out.width, 4);
    assert.equal(out.height, 3);
    assert.equal(out.grid.length, 12);
  });

  test('throws when frame dimensions mismatch', () => {
    const a = frame([1, 2, 3, 4], 2, 2);
    const b = frame([1, 2, 3, 4, 5], 5, 1);
    assert.throws(() => computeTrend([a, b]), /must share dimensions/);
  });

  test('throws when frame.grid length does not match dimensions', () => {
    const a = { width: 2, height: 2, grid: new Float32Array(4) };
    const b = { width: 2, height: 2, grid: new Float32Array(3) }; // wrong
    assert.throws(() => computeTrend([a, b]), /grid length/);
  });

  test('throws on invalid window option', () => {
    const a = frame([1], 1, 1);
    const b = frame([2], 1, 1);
    assert.throws(() => computeTrend([a, b], { window: 0 }), /window/);
    assert.throws(() => computeTrend([a, b], { window: 1 }), /window/);
    assert.throws(() => computeTrend([a, b], { window: 1.5 }), /window/);
  });

  test('detects mixed growth and decay across pixels in one pass', () => {
    // Pixel 0 grows, pixel 1 decays, pixel 2 stable.
    const a = frame([0, 10, 5], 3, 1);
    const b = frame([1, 9, 5], 3, 1);
    const c = frame([2, 8, 5], 3, 1);
    const d = frame([3, 7, 5], 3, 1);
    const out = computeTrend([a, b, c, d]);
    assert.ok(out.grid[0] > 0, 'pixel 0 should be growing');
    assert.ok(out.grid[1] < 0, 'pixel 1 should be decaying');
    assert.ok(Math.abs(out.grid[2]) < 1e-9, 'pixel 2 should be stable');
  });
});
