import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONVECTIVE_INTENSITY,
  DEFAULT_CONVECTIVE_GRADIENT,
  DEFAULT_CAPE_REF,
  DEFAULT_THUNDER_SCALE,
  DEFAULT_THUNDER_MAX_ALPHA,
  convectiveMask,
  thunderstormScore,
  encodeThunderstormToRgba,
} from '../public/thunderstorm.js';

const makeGrid = (w, h, f) => {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = f(x, y);
  return g;
};

describe('exports', () => {
  test('thresholds match the plan (30 mm/h intensity, 5 mm/h/px gradient, 2000 J/kg cape ref)', () => {
    assert.equal(DEFAULT_CONVECTIVE_INTENSITY, 30);
    assert.equal(DEFAULT_CONVECTIVE_GRADIENT, 5);
    assert.equal(DEFAULT_CAPE_REF, 2000);
    assert.equal(DEFAULT_THUNDER_SCALE, 5);
    assert.equal(DEFAULT_THUNDER_MAX_ALPHA, 200);
  });
});

describe('convectiveMask', () => {
  test('flat low-intensity field → zero everywhere', () => {
    const grid = makeGrid(8, 8, () => 5);
    const out = convectiveMask(grid, 8, 8);
    for (const v of out.grid) assert.equal(v, 0);
  });

  test('flat high-intensity field (stratiform sheet) → zero — no gradient', () => {
    const grid = makeGrid(8, 8, () => 50);
    const out = convectiveMask(grid, 8, 8);
    for (const v of out.grid) assert.equal(v, 0);
  });

  test('sharp-edged hot spot → non-zero score near the edge', () => {
    // Centre block of 4 cells at 80 mm/h, surrounding at 0
    const grid = makeGrid(8, 8, (x, y) => (x >= 3 && x <= 4 && y >= 3 && y <= 4 ? 80 : 0));
    const out = convectiveMask(grid, 8, 8);
    // Some pixel should be > 0
    let nonZero = 0;
    for (const v of out.grid) if (v > 0) nonZero++;
    assert.ok(nonZero > 0, 'expected non-zero pixels');
  });

  test('boundary pixels are always zero (no full neighbourhood)', () => {
    const grid = makeGrid(8, 8, () => 80);
    const out = convectiveMask(grid, 8, 8);
    // Check the edge row
    for (let x = 0; x < 8; x++) {
      assert.equal(out.grid[x], 0, `top row x=${x}`);
      assert.equal(out.grid[7 * 8 + x], 0, `bottom row x=${x}`);
    }
  });

  test('respects custom thresholds', () => {
    // 2×2 hot region so neighbours of any non-edge cell are non-uniform —
    // gives both non-zero intensity AND non-zero gradient where they meet.
    const grid = makeGrid(8, 8, (x, y) => (x >= 3 && x <= 4 && y >= 3 && y <= 4 ? 25 : 0));
    // Default intensity threshold 30 → centre value 25 is below → zero
    const def = convectiveMask(grid, 8, 8);
    let anyNonZeroDef = false;
    for (const v of def.grid) if (v > 0) { anyNonZeroDef = true; break; }
    assert.equal(anyNonZeroDef, false);
    // Custom threshold 10 + low gradient threshold → non-zero somewhere
    const tuned = convectiveMask(grid, 8, 8, { intensityThreshold: 10, gradientThreshold: 1 });
    let anyNonZeroTuned = false;
    for (const v of tuned.grid) if (v > 0) { anyNonZeroTuned = true; break; }
    assert.ok(anyNonZeroTuned, 'expected at least one non-zero pixel after threshold relaxation');
  });

  test('throws on invalid dimensions or grid length', () => {
    assert.throws(() => convectiveMask(new Float32Array(4), 0, 4), /positive integers/);
    // grid length 5 vs width*height = 4 → mismatch
    assert.throws(() => convectiveMask(new Float32Array(5), 2, 2), /grid length/);
  });
});

describe('thunderstormScore', () => {
  const conv = { width: 2, height: 2, grid: new Float32Array([1, 0, 2, 0]) };
  const trend = { width: 2, height: 2, grid: new Float32Array([0.5, 0.5, -1, 0.2]) };
  const cape = { width: 2, height: 2, grid: new Float32Array([2000, 0, 1000, 4000]) };

  test('null convective → null', () => {
    assert.equal(thunderstormScore(null, trend, cape), null);
    assert.equal(thunderstormScore({}, trend, cape), null);
  });

  test('combines convective × (1 + positive trend) × cape/capeRef factor', () => {
    const out = thunderstormScore(conv, trend, cape);
    // Cell 0: conv=1, trend=+0.5 → tFactor=1.5; cape=2000/2000=1 → score = 1*1.5*1 = 1.5
    assert.ok(Math.abs(out.grid[0] - 1.5) < 1e-6);
    // Cell 1: conv=0 → 0
    assert.equal(out.grid[1], 0);
    // Cell 2: conv=2, trend=-1 (decaying) → tFactor=0 → 0
    assert.equal(out.grid[2], 0);
    // Cell 3: conv=0 → 0
    assert.equal(out.grid[3], 0);
  });

  test('null trend → trend factor neutral (1)', () => {
    const out = thunderstormScore(conv, null, cape);
    // Cell 0: 1 * 1 * (2000/2000=1) = 1
    assert.equal(out.grid[0], 1);
  });

  test('null cape → cape factor neutral (1)', () => {
    const out = thunderstormScore(conv, trend, null);
    // Cell 0: 1 * 1.5 * 1 = 1.5
    assert.ok(Math.abs(out.grid[0] - 1.5) < 1e-6);
  });

  test('cape above capeRef clamps to 1', () => {
    const out = thunderstormScore(conv, null, cape);
    // Cell 3: conv=0 already kills it, but check cell 2 instead with conv overridden
    const conv2 = { width: 2, height: 2, grid: new Float32Array([0, 0, 0, 1]) };
    const out2 = thunderstormScore(conv2, null, cape);
    // Cell 3: conv=1, no trend (neutral 1), cape=4000 clamped to 1 → score 1
    assert.equal(out2.grid[3], 1);
  });

  test('throws on dimension mismatches between layers', () => {
    const wrongTrend = { width: 1, height: 1, grid: new Float32Array([0.5]) };
    assert.throws(() => thunderstormScore(conv, wrongTrend, cape), /trend dimensions/);
    const wrongCape = { width: 1, height: 1, grid: new Float32Array([1500]) };
    assert.throws(() => thunderstormScore(conv, trend, wrongCape), /cape dimensions/);
  });

  test('throws on invalid capeRef option', () => {
    assert.throws(() => thunderstormScore(conv, trend, cape, { capeRef: 0 }), /capeRef/);
  });
});

describe('encodeThunderstormToRgba', () => {
  test('zero score → transparent', () => {
    const grid = new Float32Array([0]);
    const out = encodeThunderstormToRgba(grid, 1, 1);
    for (let i = 0; i < 4; i++) assert.equal(out[i], 0);
  });

  test('below epsilon → transparent', () => {
    const grid = new Float32Array([0.1]); // 0.1 / 5 = 0.02 < 0.05
    const out = encodeThunderstormToRgba(grid, 1, 1);
    assert.equal(out[3], 0);
  });

  test('moderate score → pinky-red mid-alpha', () => {
    const grid = new Float32Array([2.5]); // t = 0.5
    const out = encodeThunderstormToRgba(grid, 1, 1);
    assert.equal(out[3], 100); // 0.5 * 200
    assert.ok(out[0] > 200);
  });

  test('high score clamps to deep red, full alpha', () => {
    const grid = new Float32Array([20]);
    const out = encodeThunderstormToRgba(grid, 1, 1, { scale: 5, maxAlpha: 200 });
    assert.equal(out[0], 200);
    assert.equal(out[1], 30);
    assert.equal(out[2], 30);
    assert.equal(out[3], 200);
  });

  test('non-finite or negative values render as transparent', () => {
    const grid = new Float32Array([NaN, -1, Infinity]);
    const out = encodeThunderstormToRgba(grid, 3, 1);
    for (let i = 3; i < 12; i += 4) assert.equal(out[i], 0);
  });

  test('throws on dimension mismatch and invalid scale', () => {
    assert.throws(() => encodeThunderstormToRgba(new Float32Array(3), 2, 2), /length/);
    assert.throws(() => encodeThunderstormToRgba(new Float32Array(4), 2, 2, { scale: 0 }), /scale/);
  });
});
