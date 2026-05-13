import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_INTERPOLATION_FACTOR,
  interpolateHistory,
} from '../public/interpolate.js';

function makeGrid(w, h, f) {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) g[y * w + x] = f(x, y);
  }
  return g;
}

function uniformFlow(width, height, blockSize, vx, vy) {
  const fw = Math.floor(width / blockSize);
  const fh = Math.floor(height / blockSize);
  const data = new Float32Array(fw * fh * 2);
  for (let i = 0; i < data.length; i += 2) {
    data[i] = vx;
    data[i + 1] = vy;
  }
  return { width: fw, height: fh, blockSize, data };
}

describe('DEFAULT_INTERPOLATION_FACTOR', () => {
  test('defaults to 4 (≈ 60 fps over 10-min-spaced frames)', () => {
    assert.equal(DEFAULT_INTERPOLATION_FACTOR, 4);
  });
});

describe('interpolateHistory', () => {
  test('returns [] for empty input', () => {
    assert.deepEqual(interpolateHistory([], []), []);
  });

  test('returns single frame as-is when history.length < 2', () => {
    const frame = { time: 100, grid: new Float32Array(16), width: 4, height: 4 };
    const out = interpolateHistory([frame], []);
    assert.equal(out.length, 1);
    assert.equal(out[0].observed, true);
  });

  test('factor = 1 returns observed frames unchanged with .observed flag', () => {
    const frames = [
      { time: 0, grid: new Float32Array(16), width: 4, height: 4 },
      { time: 600, grid: new Float32Array(16), width: 4, height: 4 },
    ];
    const out = interpolateHistory(frames, [uniformFlow(4, 4, 4, 0, 0)], 1);
    assert.equal(out.length, 2);
    assert.equal(out[0].observed, true);
    assert.equal(out[1].observed, true);
  });

  test('factor = 4 across 2 frames yields 5 outputs (2 observed + 3 interp)', () => {
    const w = 16, h = 16;
    const frames = [
      { time: 0,   grid: makeGrid(w, h, () => 1), width: w, height: h },
      { time: 600, grid: makeGrid(w, h, () => 1), width: w, height: h },
    ];
    const flow = uniformFlow(w, h, 4, 0, 0);
    const out = interpolateHistory(frames, [flow], 4);
    assert.equal(out.length, 5);
  });

  test('factor = N across K frames yields K + (K-1)*(N-1) outputs', () => {
    const w = 16, h = 16;
    const mk = (t) => ({ time: t, grid: makeGrid(w, h, () => 1), width: w, height: h });
    const frames = [mk(0), mk(600), mk(1200), mk(1800)]; // K=4
    const flow = uniformFlow(w, h, 4, 0, 0);
    const pairs = [flow, flow, flow]; // K-1 = 3 pairs
    const out = interpolateHistory(frames, pairs, 4);
    // 4 observed + 3 pairs × 3 in-betweens = 4 + 9 = 13
    assert.equal(out.length, 13);
  });

  test('intermediate timestamps are linearly spaced between observed pairs', () => {
    const w = 4, h = 4;
    const frames = [
      { time: 0,   grid: makeGrid(w, h, () => 0), width: w, height: h },
      { time: 600, grid: makeGrid(w, h, () => 0), width: w, height: h },
    ];
    const flow = uniformFlow(w, h, 4, 0, 0);
    const out = interpolateHistory(frames, [flow], 4);
    assert.equal(out[0].time, 0);
    assert.equal(out[1].time, 150);  // 1/4
    assert.equal(out[2].time, 300);  // 2/4
    assert.equal(out[3].time, 450);  // 3/4
    assert.equal(out[4].time, 600);
  });

  test('observed flag is correctly set on every output frame', () => {
    const w = 4, h = 4;
    const frames = [
      { time: 0,   grid: makeGrid(w, h, () => 0), width: w, height: h },
      { time: 600, grid: makeGrid(w, h, () => 0), width: w, height: h },
      { time: 1200, grid: makeGrid(w, h, () => 0), width: w, height: h },
    ];
    const flow = uniformFlow(w, h, 4, 0, 0);
    const out = interpolateHistory(frames, [flow, flow], 4);
    // Pattern: O I I I O I I I O
    const observedFlags = out.map((f) => f.observed);
    assert.deepEqual(observedFlags, [true, false, false, false, true, false, false, false, true]);
  });

  test('zero-flow interpolation produces grids equal to the start of the pair', () => {
    const w = 8, h = 8;
    const a = makeGrid(w, h, (x, y) => x + y * 10);
    const b = makeGrid(w, h, (x, y) => x + y * 10);
    const frames = [
      { time: 0, grid: a, width: w, height: h },
      { time: 600, grid: b, width: w, height: h },
    ];
    const flow = uniformFlow(w, h, 4, 0, 0);
    const out = interpolateHistory(frames, [flow], 4);
    // With zero flow, every interpolated frame == frame a
    for (let i = 1; i < 4; i++) {
      for (let j = 0; j < a.length; j++) {
        assert.equal(out[i].grid[j], a[j]);
      }
    }
  });

  test('intermediate frames at dt=0.5 fall midway under uniform translation', () => {
    const w = 16, h = 16;
    // Spike at x=4
    const a = makeGrid(w, h, (x) => (x === 4 ? 10 : 0));
    // Spike at x=8 (translated +4)
    const b = makeGrid(w, h, (x) => (x === 8 ? 10 : 0));
    const flow = uniformFlow(w, h, 4, 4, 0);
    const out = interpolateHistory(
      [
        { time: 0, grid: a, width: w, height: h },
        { time: 600, grid: b, width: w, height: h },
      ],
      [flow],
      2, // factor 2 → 1 in-between at dt=0.5
    );
    assert.equal(out.length, 3);
    // dt=0.5, displacement = 2, peak should land at x=6
    assert.equal(out[1].grid[8 * w + 6], 10);
  });

  test('throws on non-integer or non-positive factor', () => {
    assert.throws(() => interpolateHistory([], [], 0), /positive integer/);
    assert.throws(() => interpolateHistory([], [], -1), /positive integer/);
    assert.throws(() => interpolateHistory([], [], 2.5), /positive integer/);
  });

  test('throws when pairs.length does not match decoded.length - 1', () => {
    const w = 4, h = 4;
    const frames = [
      { time: 0, grid: new Float32Array(16), width: w, height: h },
      { time: 600, grid: new Float32Array(16), width: w, height: h },
    ];
    assert.throws(
      () => interpolateHistory(frames, [], 4),
      /pairs.length/,
    );
  });
});
