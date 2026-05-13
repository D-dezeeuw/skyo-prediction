import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  advectStep,
  bilinearSample,
  forecast,
  sampleFlow,
} from '../public/advect.js';

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

function makeGrid(width, height, f) {
  const g = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      g[y * width + x] = f(x, y);
    }
  }
  return g;
}

describe('bilinearSample', () => {
  const grid = makeGrid(4, 4, (x, y) => x + y * 10);

  test('returns the exact value at integer coordinates', () => {
    assert.equal(bilinearSample(grid, 4, 4, 0, 0), 0);
    assert.equal(bilinearSample(grid, 4, 4, 1, 1), 11);
    assert.equal(bilinearSample(grid, 4, 4, 3, 3), 33);
  });

  test('interpolates linearly between two neighbours', () => {
    // (0,0)=0, (1,0)=1 → midpoint at (0.5, 0) = 0.5
    assert.equal(bilinearSample(grid, 4, 4, 0.5, 0), 0.5);
    // (0,0)=0, (0,1)=10 → midpoint at (0, 0.5) = 5
    assert.equal(bilinearSample(grid, 4, 4, 0, 0.5), 5);
  });

  test('interpolates across the diagonal correctly', () => {
    // (0,0)=0, (1,0)=1, (0,1)=10, (1,1)=11 — centre = 5.5
    assert.equal(bilinearSample(grid, 4, 4, 0.5, 0.5), 5.5);
  });

  test('out-of-bounds (below 0) returns 0', () => {
    assert.equal(bilinearSample(grid, 4, 4, -1, 0), 0);
    assert.equal(bilinearSample(grid, 4, 4, 0, -1), 0);
  });

  test('out-of-bounds (above width/height) returns 0', () => {
    assert.equal(bilinearSample(grid, 4, 4, 4.5, 0), 0);
    assert.equal(bilinearSample(grid, 4, 4, 0, 4.5), 0);
  });

  test('exactly at the upper boundary still samples (tolerance EPS)', () => {
    // (3,3) is the last cell — sampling AT it shouldn't OOB
    assert.equal(bilinearSample(grid, 4, 4, 3, 3), 33);
  });
});

describe('sampleFlow', () => {
  test('returns the constant flow at every pixel', () => {
    const f = uniformFlow(64, 64, 8, 3, -2);
    const { vx, vy } = sampleFlow(f, f.width, f.height, f.blockSize, 32, 32);
    assert.equal(vx, 3);
    assert.equal(vy, -2);
  });

  test('clamps to the nearest valid flow cell at edges', () => {
    const f = uniformFlow(64, 64, 8, 1, 0);
    const a = sampleFlow(f, f.width, f.height, f.blockSize, 0, 0);
    const b = sampleFlow(f, f.width, f.height, f.blockSize, 63, 63);
    assert.equal(a.vx, 1);
    assert.equal(b.vx, 1);
  });

  test('interpolates between block centres', () => {
    // Build a flow field whose vx varies by row: row 0 → 0, row 1 → 4
    const fw = 2, fh = 2, blockSize = 8;
    const data = new Float32Array(fw * fh * 2);
    data[0] = 0; data[1] = 0;       // (0,0)
    data[2] = 0; data[3] = 0;       // (1,0)
    data[4] = 4; data[5] = 0;       // (0,1)
    data[6] = 4; data[7] = 0;       // (1,1)
    const flow = { width: fw, height: fh, blockSize, data };
    // Block (0,0) centre at pixel (4, 4); block (0,1) centre at (4, 12).
    // Sampling at pixel (4, 8) is exactly halfway → vx should be 2.
    const { vx } = sampleFlow(flow, fw, fh, blockSize, 4, 8);
    assert.ok(Math.abs(vx - 2) < 1e-9);
  });
});

describe('advectStep', () => {
  test('zero flow → output identical to input', () => {
    const input = makeGrid(16, 16, (x, y) => Math.sin(x * 0.4) + Math.cos(y * 0.3));
    const flow = uniformFlow(16, 16, 4, 0, 0);
    const out = advectStep(input, flow, 16, 16);
    for (let i = 0; i < input.length; i++) {
      assert.ok(Math.abs(out[i] - input[i]) < 1e-9, `idx ${i}: ${out[i]} vs ${input[i]}`);
    }
  });

  test('uniform +x flow shifts the field right by vx', () => {
    // Pure horizontal stripe pattern with non-zero values
    const w = 32, h = 32;
    const input = makeGrid(w, h, (x, y) => (x % 8 === 0 ? 10 : 1));
    const flow = uniformFlow(w, h, 4, 2, 0);
    const out = advectStep(input, flow, w, h);
    // Original peak at x=8 → should appear at x=10 after +2 advection.
    // Check column at y=4 (middle), interior x.
    for (let y = 4; y < h - 4; y += 8) {
      assert.equal(out[y * w + 10], input[y * w + 8], `row ${y}, x=10`);
    }
  });

  test('uniform +y flow shifts the field down by vy', () => {
    const w = 32, h = 32;
    const input = makeGrid(w, h, (x, y) => (y % 8 === 0 ? 10 : 1));
    const flow = uniformFlow(w, h, 4, 0, 3);
    const out = advectStep(input, flow, w, h);
    // Peak at y=8 → out at y=11
    for (let x = 4; x < w - 4; x += 8) {
      assert.equal(out[11 * w + x], input[8 * w + x], `col ${x}, y=11`);
    }
  });

  test('mass conservation: a fully-interior blob preserves total mass under advection', () => {
    // Centred 16×16 box of 1s in a 64×64 domain, advected by (+2, +1).
    // The displaced box lands inside the domain (no off-edge leakage) so
    // the whole-grid sum should match the input exactly.
    const w = 64, h = 64;
    const input = makeGrid(w, h, (x, y) => (x >= 24 && x < 40 && y >= 24 && y < 40 ? 1 : 0));
    const flow = uniformFlow(w, h, 8, 2, 1);
    const out = advectStep(input, flow, w, h);
    let sumIn = 0, sumOut = 0;
    for (let i = 0; i < input.length; i++) { sumIn += input[i]; sumOut += out[i]; }
    assert.ok(Math.abs(sumOut - sumIn) / sumIn < 1e-6,
      `whole-grid mass drift: in=${sumIn}, out=${sumOut}`);
  });

  test('dt scales the effective displacement', () => {
    const w = 32, h = 32;
    const input = makeGrid(w, h, (x, y) => (x === 16 ? 10 : 0));
    const flow = uniformFlow(w, h, 4, 4, 0);
    const half = advectStep(input, flow, w, h, { dt: 0.5 });
    const full = advectStep(input, flow, w, h, { dt: 1 });
    // At dt=0.5, displacement = 2; at dt=1, displacement = 4
    assert.equal(half[16 * w + 18], 10);
    assert.equal(full[16 * w + 20], 10);
  });

  test('throws on dimension mismatch', () => {
    const flow = uniformFlow(16, 16, 4, 1, 0);
    assert.throws(
      () => advectStep(new Float32Array(64), flow, 16, 16),
      /input length/,
    );
  });

  test('throws on invalid width/height', () => {
    const flow = uniformFlow(16, 16, 4, 1, 0);
    const input = new Float32Array(256);
    assert.throws(() => advectStep(input, flow, 0, 16), /width/);
    assert.throws(() => advectStep(input, flow, 16, -1), /height/);
  });

  test('throws on malformed flow object', () => {
    const input = new Float32Array(256);
    assert.throws(() => advectStep(input, null, 16, 16), /flow must shape/);
    assert.throws(() => advectStep(input, {}, 16, 16), /flow must shape/);
    const bad = { width: 4, height: 4, blockSize: 4, data: new Float32Array(8) };
    assert.throws(() => advectStep(input, bad, 16, 16), /flow.data length/);
  });
});

describe('forecast', () => {
  test('produces N frames', () => {
    const w = 16, h = 16;
    const input = makeGrid(w, h, () => 1);
    const flow = uniformFlow(w, h, 4, 0, 0);
    const frames = forecast(input, flow, 5, w, h);
    assert.equal(frames.length, 5);
  });

  test('returns empty array for n = 0', () => {
    const w = 16, h = 16;
    const input = new Float32Array(w * h);
    const flow = uniformFlow(w, h, 4, 0, 0);
    assert.deepEqual(forecast(input, flow, 0, w, h), []);
  });

  test('throws on negative or non-integer n', () => {
    const w = 16, h = 16;
    const input = new Float32Array(w * h);
    const flow = uniformFlow(w, h, 4, 0, 0);
    assert.throws(() => forecast(input, flow, -1, w, h), /non-negative integer/);
    assert.throws(() => forecast(input, flow, 2.5, w, h), /non-negative integer/);
  });

  test('repeated steps compound the displacement', () => {
    const w = 32, h = 32;
    const input = makeGrid(w, h, (x, y) => (x === 4 ? 10 : 0));
    const flow = uniformFlow(w, h, 4, 2, 0);
    const frames = forecast(input, flow, 3, w, h);
    // Step 1: peak at x=6. Step 2: x=8. Step 3: x=10.
    assert.equal(frames[0][16 * w + 6], 10);
    assert.equal(frames[1][16 * w + 8], 10);
    assert.equal(frames[2][16 * w + 10], 10);
  });

  test('zero flow returns N copies of the input', () => {
    const w = 8, h = 8;
    const input = makeGrid(w, h, (x, y) => x * 3 + y);
    const flow = uniformFlow(w, h, 4, 0, 0);
    const frames = forecast(input, flow, 3, w, h);
    for (const frame of frames) {
      for (let i = 0; i < input.length; i++) {
        assert.equal(frame[i], input[i]);
      }
    }
  });
});

function sumBox(grid, width, x0, x1, y0, y1) {
  let s = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      s += grid[y * width + x];
    }
  }
  return s;
}
