import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIDENCE_SCALE,
  DEFAULT_CONFIDENCE_MAX_ALPHA,
  ensembleConfidence,
  ensembleConfidencePerStep,
  encodeConfidenceToRgba,
} from '../public/confidence.js';

describe('exports', () => {
  test('exports sensible defaults', () => {
    assert.equal(DEFAULT_CONFIDENCE_SCALE, 2.0);
    assert.equal(DEFAULT_CONFIDENCE_MAX_ALPHA, 180);
  });
});

describe('ensembleConfidence', () => {
  test('identical forecasts → zero confidence everywhere', () => {
    const a = [new Float32Array([1, 2, 3, 4])];
    const b = [new Float32Array([1, 2, 3, 4])];
    const out = ensembleConfidence(a, b, 2, 2);
    for (const v of out.grid) assert.equal(v, 0);
  });

  test('returns an empty zero grid for empty input', () => {
    const out = ensembleConfidence([], [], 2, 2);
    assert.equal(out.grid.length, 4);
    for (const v of out.grid) assert.equal(v, 0);
  });

  test('per-cell RMS spread captures the disagreement', () => {
    // 1 step, |a - b| = 4 everywhere → RMS spread = 4
    const a = [new Float32Array([0, 0, 0, 0])];
    const b = [new Float32Array([4, 4, 4, 4])];
    const out = ensembleConfidence(a, b, 2, 2);
    for (const v of out.grid) assert.ok(Math.abs(v - 4) < 1e-5);
  });

  test('preserves dimensions in output', () => {
    const a = [new Float32Array(12)];
    const b = [new Float32Array(12)];
    const out = ensembleConfidence(a, b, 4, 3);
    assert.equal(out.width, 4);
    assert.equal(out.height, 3);
    assert.equal(out.grid.length, 12);
  });

  test('later forecast steps weigh more than earlier ones', () => {
    // Step 1: |a-b| = 4 at cell 0, 0 at cell 1
    // Step 2: |a-b| = 0 at cell 0, 4 at cell 1
    // Weights: [1, 2] (step 1 weight = 1, step 2 weight = 2)
    // Cell 0: sqrt((1*16 + 2*0)/3) = sqrt(5.33) ≈ 2.31
    // Cell 1: sqrt((1*0 + 2*16)/3) = sqrt(10.67) ≈ 3.27
    // → cell 1 (late disagreement) > cell 0 (early disagreement)
    const a = [new Float32Array([0, 4]), new Float32Array([0, 0])];
    const b = [new Float32Array([4, 4]), new Float32Array([0, 4])];
    const out = ensembleConfidence(a, b, 2, 1);
    assert.ok(out.grid[1] > out.grid[0], `cell 1 (${out.grid[1]}) should exceed cell 0 (${out.grid[0]})`);
  });

  test('throws on mismatched forecast lengths', () => {
    const a = [new Float32Array(4), new Float32Array(4)];
    const b = [new Float32Array(4)];
    assert.throws(() => ensembleConfidence(a, b, 2, 2), /length .* != .*length/);
  });

  test('throws on non-array inputs', () => {
    assert.throws(() => ensembleConfidence(null, [], 2, 2), /must be arrays/);
    assert.throws(() => ensembleConfidence([], null, 2, 2), /must be arrays/);
  });

  test('throws on invalid dimensions', () => {
    assert.throws(() => ensembleConfidence([], [], 0, 2), /positive integers/);
    assert.throws(() => ensembleConfidence([], [], 2, -1), /positive integers/);
  });

  test('throws when a frame length mismatches width*height', () => {
    const a = [new Float32Array(4)];
    const b = [new Float32Array(3)];
    assert.throws(() => ensembleConfidence(a, b, 2, 2), /frame 0 length mismatch/);
  });
});

describe('encodeConfidenceToRgba', () => {
  test('zero grid → fully transparent everywhere', () => {
    const grid = new Float32Array([0, 0, 0, 0]);
    const out = encodeConfidenceToRgba(grid, 2, 2);
    for (let i = 0; i < out.length; i++) assert.equal(out[i], 0);
  });

  test('below epsilon → transparent', () => {
    const grid = new Float32Array([0.01]);
    const out = encodeConfidenceToRgba(grid, 1, 1);
    assert.equal(out[3], 0);
  });

  test('mid-range value → mid-orange, mid-alpha', () => {
    // value = 1, scale = 2 → t = 0.5
    const grid = new Float32Array([1]);
    const out = encodeConfidenceToRgba(grid, 1, 1);
    // R: 255 - 35*0.5 = 237.5
    assert.ok(out[0] > 230 && out[0] < 245, `R=${out[0]}`);
    // alpha: 0.5 * 180 = 90
    assert.equal(out[3], 90);
  });

  test('values beyond scale clamp to t=1 (red, maxAlpha)', () => {
    const grid = new Float32Array([10]);
    const out = encodeConfidenceToRgba(grid, 1, 1, { scale: 2, maxAlpha: 200 });
    // t clamped → R = 220, G = 30, B = 30, alpha = 200
    assert.equal(out[0], 220);
    assert.equal(out[1], 30);
    assert.equal(out[2], 30);
    assert.equal(out[3], 200);
  });

  test('non-finite values render as transparent', () => {
    const grid = new Float32Array([NaN, Infinity]);
    const out = encodeConfidenceToRgba(grid, 2, 1);
    assert.equal(out[3], 0);
    assert.equal(out[7], 0);
  });

  test('throws on dimension mismatch', () => {
    const grid = new Float32Array(3);
    assert.throws(() => encodeConfidenceToRgba(grid, 2, 2), /length/);
  });

  test('throws on non-positive scale', () => {
    const grid = new Float32Array(4);
    assert.throws(() => encodeConfidenceToRgba(grid, 2, 2, { scale: 0 }), /scale/);
  });

  test('returns Uint8ClampedArray of width*height*4 entries', () => {
    const grid = new Float32Array(9);
    const out = encodeConfidenceToRgba(grid, 3, 3);
    assert.ok(out instanceof Uint8ClampedArray);
    assert.equal(out.length, 36);
  });
});

describe('ensembleConfidencePerStep', () => {
  test('returns one grid per forecast step, in input order', () => {
    const a = [
      Float32Array.from([1, 2, 3, 4]),
      Float32Array.from([5, 6, 7, 8]),
      Float32Array.from([9, 10, 11, 12]),
    ];
    const b = [
      Float32Array.from([0, 2, 4, 4]),
      Float32Array.from([5, 8, 7, 10]),
      Float32Array.from([10, 10, 14, 12]),
    ];
    const out = ensembleConfidencePerStep(a, b, 2, 2);
    assert.equal(out.length, 3);
    for (const e of out) {
      assert.equal(e.width, 2);
      assert.equal(e.height, 2);
      assert.equal(e.grid.length, 4);
    }
  });

  test('per-step value is the absolute per-cell difference', () => {
    const a = [Float32Array.from([10, 20, 30, 40])];
    const b = [Float32Array.from([12, 18, 30, 50])];
    const out = ensembleConfidencePerStep(a, b, 2, 2);
    assert.deepEqual([...out[0].grid], [2, 2, 0, 10]);
  });

  test('agreement (a === b) → zero grid', () => {
    const a = [Float32Array.from([5, 5, 5, 5])];
    const b = [Float32Array.from([5, 5, 5, 5])];
    const out = ensembleConfidencePerStep(a, b, 2, 2);
    for (const v of out[0].grid) assert.equal(v, 0);
  });

  test('empty input → empty output', () => {
    const out = ensembleConfidencePerStep([], [], 4, 4);
    assert.deepEqual(out, []);
  });

  test('throws on non-array inputs', () => {
    assert.throws(() => ensembleConfidencePerStep(null, [], 2, 2), /arrays/);
    assert.throws(() => ensembleConfidencePerStep([], 'no', 2, 2), /arrays/);
  });

  test('throws on member-length mismatch', () => {
    const a = [new Float32Array(4)];
    const b = [new Float32Array(4), new Float32Array(4)];
    assert.throws(() => ensembleConfidencePerStep(a, b, 2, 2), /length .* !=/);
  });

  test('throws on invalid dimensions', () => {
    assert.throws(() => ensembleConfidencePerStep([], [], 0, 4), /positive integers/);
    assert.throws(() => ensembleConfidencePerStep([], [], 4, 0), /positive integers/);
  });

  test('throws on frame-grid length mismatch', () => {
    const a = [new Float32Array(3)];
    const b = [new Float32Array(4)];
    assert.throws(() => ensembleConfidencePerStep(a, b, 2, 2), /frame 0/);
  });
});
