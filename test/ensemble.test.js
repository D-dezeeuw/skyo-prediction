import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ENSEMBLE_SIZE,
  DEFAULT_RAIN_THRESHOLD,
  DEFAULT_ROTATION_RANGE_DEG,
  DEFAULT_SCALE_RANGE,
  DEFAULT_PROBABILITY_MAX_ALPHA,
  buildPerturbations,
  perturbFlow,
  computeProbabilityFields,
  maxProbabilityField,
  encodeProbabilityToRgba,
} from '../public/ensemble.js';

const mkFlow = (data, w = 1, h = 1, blockSize = 16) => ({ width: w, height: h, blockSize, data: Float32Array.from(data) });

describe('exports', () => {
  test('sensible defaults per the plan', () => {
    assert.equal(DEFAULT_ENSEMBLE_SIZE, 8);
    assert.equal(DEFAULT_RAIN_THRESHOLD, 0.5);
    assert.equal(DEFAULT_ROTATION_RANGE_DEG, 15);
    assert.equal(DEFAULT_SCALE_RANGE, 0.15);
    assert.equal(DEFAULT_PROBABILITY_MAX_ALPHA, 200);
  });
});

describe('buildPerturbations', () => {
  test('n = 1 returns the unperturbed pair only', () => {
    assert.deepEqual(buildPerturbations(1), [{ theta: 0, scale: 1 }]);
  });

  test('returns N pairs spread across the rotation/scale ranges', () => {
    const out = buildPerturbations(5, { rotationRangeDeg: 10, scaleRange: 0.1 });
    assert.equal(out.length, 5);
    // Endpoints
    assert.ok(Math.abs(out[0].theta - (-10 * Math.PI / 180)) < 1e-9);
    assert.ok(Math.abs(out[4].theta - (10 * Math.PI / 180)) < 1e-9);
    assert.ok(Math.abs(out[0].scale - 0.9) < 1e-9);
    assert.ok(Math.abs(out[4].scale - 1.1) < 1e-9);
    // Centre
    assert.ok(Math.abs(out[2].theta) < 1e-9);
    assert.ok(Math.abs(out[2].scale - 1) < 1e-9);
  });

  test('throws on invalid n', () => {
    assert.throws(() => buildPerturbations(0), /positive integer/);
    assert.throws(() => buildPerturbations(-1), /positive integer/);
    assert.throws(() => buildPerturbations(1.5), /positive integer/);
  });
});

describe('perturbFlow', () => {
  test('θ=0, scale=1 returns the same vectors (new buffer)', () => {
    const flow = mkFlow([3, 4]);
    const out = perturbFlow(flow, 0, 1);
    assert.equal(out.data[0], 3);
    assert.equal(out.data[1], 4);
    assert.notEqual(out.data, flow.data); // new buffer
  });

  test('scale = 2 doubles every component', () => {
    const flow = mkFlow([1, -1, 2, 3], 2, 1);
    const out = perturbFlow(flow, 0, 2);
    assert.deepEqual([...out.data], [2, -2, 4, 6]);
  });

  test('θ = 90° rotates (1, 0) → (0, 1)', () => {
    const flow = mkFlow([1, 0]);
    const out = perturbFlow(flow, Math.PI / 2, 1);
    assert.ok(Math.abs(out.data[0]) < 1e-6);
    assert.ok(Math.abs(out.data[1] - 1) < 1e-6);
  });

  test('preserves width/height/blockSize', () => {
    const flow = { width: 3, height: 2, blockSize: 32, data: new Float32Array(12) };
    const out = perturbFlow(flow, 0, 1);
    assert.equal(out.width, 3);
    assert.equal(out.height, 2);
    assert.equal(out.blockSize, 32);
  });

  test('throws on bad input', () => {
    assert.throws(() => perturbFlow(null, 0, 1), /flow with .data required/);
    assert.throws(() => perturbFlow({}, 0, 1), /flow with .data required/);
    assert.throws(() => perturbFlow(mkFlow([0, 0]), NaN, 1), /finite numbers/);
    assert.throws(() => perturbFlow(mkFlow([0, 0]), 0, Infinity), /finite numbers/);
  });
});

describe('computeProbabilityFields', () => {
  test('returns [] for empty input', () => {
    assert.deepEqual(computeProbabilityFields([], 2, 2), []);
  });

  test('all members agree on rain → probability 1 everywhere', () => {
    const wet = new Float32Array([2, 2, 2, 2]);
    const out = computeProbabilityFields([[wet], [wet], [wet]], 2, 2);
    assert.equal(out.length, 1);
    for (const v of out[0]) assert.equal(v, 1);
  });

  test('all members agree on no-rain → probability 0', () => {
    const dry = new Float32Array([0, 0, 0, 0]);
    const out = computeProbabilityFields([[dry], [dry]], 2, 2);
    for (const v of out[0]) assert.equal(v, 0);
  });

  test('half members rain → probability 0.5 at those cells', () => {
    const wet = new Float32Array([5, 0]);
    const dry = new Float32Array([0, 0]);
    const out = computeProbabilityFields([[wet], [dry]], 2, 1);
    assert.equal(out[0][0], 0.5);
    assert.equal(out[0][1], 0);
  });

  test('produces one probability grid per forecast step', () => {
    const member = [new Float32Array([1, 0]), new Float32Array([1, 1])];
    const out = computeProbabilityFields([member, member], 2, 1);
    assert.equal(out.length, 2);
  });

  test('rainThreshold gates the count', () => {
    const wet = new Float32Array([0.6]);
    // threshold 0.5: counts; threshold 1.0: doesn't count
    const at05 = computeProbabilityFields([[wet]], 1, 1, { rainThreshold: 0.5 });
    const at10 = computeProbabilityFields([[wet]], 1, 1, { rainThreshold: 1.0 });
    assert.equal(at05[0][0], 1);
    assert.equal(at10[0][0], 0);
  });

  test('throws on inconsistent member step counts', () => {
    const m1 = [new Float32Array(4), new Float32Array(4)];
    const m2 = [new Float32Array(4)];
    assert.throws(() => computeProbabilityFields([m1, m2], 2, 2), /step count/);
  });

  test('throws on inconsistent grid sizes', () => {
    const m1 = [new Float32Array(4)];
    const m2 = [new Float32Array(3)];
    assert.throws(() => computeProbabilityFields([m1, m2], 2, 2), /width\*height/);
  });
});

describe('maxProbabilityField', () => {
  test('takes per-cell max across step grids', () => {
    const a = new Float32Array([0.2, 0.8, 0.0]);
    const b = new Float32Array([0.5, 0.6, 0.1]);
    const c = new Float32Array([0.1, 0.7, 0.9]);
    const out = maxProbabilityField([a, b, c], 3, 1);
    // Float32 precision: tolerate ~1e-6 since 0.5/0.8/0.9 don't round-trip exactly
    assert.ok(Math.abs(out.grid[0] - 0.5) < 1e-6, `cell 0: ${out.grid[0]}`);
    assert.ok(Math.abs(out.grid[1] - 0.8) < 1e-6, `cell 1: ${out.grid[1]}`);
    assert.ok(Math.abs(out.grid[2] - 0.9) < 1e-6, `cell 2: ${out.grid[2]}`);
  });

  test('empty input → all-zero grid of expected size', () => {
    const out = maxProbabilityField([], 3, 2);
    assert.equal(out.grid.length, 6);
    for (const v of out.grid) assert.equal(v, 0);
  });

  test('throws on grid-size mismatch', () => {
    const a = new Float32Array([0.5, 0.5]);
    const b = new Float32Array([0.5, 0.5, 0.5]);
    assert.throws(() => maxProbabilityField([a, b], 2, 1), /width\*height/);
  });
});

describe('encodeProbabilityToRgba', () => {
  test('zero → transparent', () => {
    const grid = new Float32Array([0]);
    const out = encodeProbabilityToRgba(grid, 1, 1);
    for (let i = 0; i < 4; i++) assert.equal(out[i], 0);
  });

  test('below epsilon → transparent', () => {
    const grid = new Float32Array([0.04]);
    const out = encodeProbabilityToRgba(grid, 1, 1);
    assert.equal(out[3], 0);
  });

  test('low probability → blue-ish', () => {
    const grid = new Float32Array([0.2]);
    const out = encodeProbabilityToRgba(grid, 1, 1);
    assert.ok(out[2] > out[0], `expected blue dominant, got R=${out[0]} B=${out[2]}`);
  });

  test('high probability → yellow-ish (R+G high, B low)', () => {
    const grid = new Float32Array([1]);
    const out = encodeProbabilityToRgba(grid, 1, 1);
    assert.ok(out[0] > 200);
    assert.ok(out[1] > 200);
    assert.ok(out[2] < 100);
  });

  test('alpha scales with probability', () => {
    const lo = encodeProbabilityToRgba(new Float32Array([0.3]), 1, 1, { maxAlpha: 200 });
    const hi = encodeProbabilityToRgba(new Float32Array([0.9]), 1, 1, { maxAlpha: 200 });
    assert.ok(hi[3] > lo[3]);
  });

  test('values > 1 clamp to 1 (saturation)', () => {
    const grid = new Float32Array([5]);
    const out = encodeProbabilityToRgba(grid, 1, 1);
    assert.ok(out[0] > 200 && out[1] > 200);
  });

  test('non-finite values render as transparent', () => {
    const grid = new Float32Array([NaN, Infinity, -1]);
    const out = encodeProbabilityToRgba(grid, 3, 1);
    for (let i = 3; i < 12; i += 4) assert.equal(out[i], 0);
  });

  test('throws on dimension mismatch', () => {
    assert.throws(() => encodeProbabilityToRgba(new Float32Array(3), 2, 2), /length/);
  });
});
