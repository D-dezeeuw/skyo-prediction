import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  OMEGA_API_BASE,
  OMEGA_GRID_DIM,
  DEFAULT_OMEGA_SCALE,
  DEFAULT_OMEGA_MAX_ALPHA,
  buildSampleGrid,
  buildOmegaUrl,
  parseOmegaResponse,
  upsampleOmegaField,
  encodeOmegaToRgba,
} from '../public/omega.js';

describe('exports', () => {
  test('OMEGA_API_BASE points at Open-Meteo forecast endpoint', () => {
    assert.equal(OMEGA_API_BASE, 'https://api.open-meteo.com/v1/forecast');
  });
  test('OMEGA_GRID_DIM = 5 (25 points across the tile)', () => {
    assert.equal(OMEGA_GRID_DIM, 5);
  });
  test('DEFAULT_OMEGA_SCALE / DEFAULT_OMEGA_MAX_ALPHA are sensible', () => {
    assert.equal(DEFAULT_OMEGA_SCALE, 0.12);
    assert.equal(DEFAULT_OMEGA_MAX_ALPHA, 230);
  });
});

describe('buildSampleGrid', () => {
  const bounds = { latTop: 60, latBottom: 50, lonLeft: 0, lonRight: 10 };

  test('returns dim×dim lat/lon pairs', () => {
    const g = buildSampleGrid(bounds, 3);
    assert.equal(g.lats.length, 9);
    assert.equal(g.lons.length, 9);
    assert.equal(g.dim, 3);
  });

  test('corners hit the bounds exactly', () => {
    const g = buildSampleGrid(bounds, 3);
    // First entry = (latTop, lonLeft)
    assert.equal(g.lats[0], 60);
    assert.equal(g.lons[0], 0);
    // Last entry = (latBottom, lonRight)
    assert.equal(g.lats[8], 50);
    assert.equal(g.lons[8], 10);
  });

  test('lats step uniformly from north to south', () => {
    const g = buildSampleGrid(bounds, 3);
    // dim=3 → t = 0, 0.5, 1 → lats per row: 60, 55, 50
    assert.equal(g.lats[0], 60);
    assert.equal(g.lats[3], 55);
    assert.equal(g.lats[6], 50);
  });

  test('lons step uniformly within a row', () => {
    const g = buildSampleGrid(bounds, 3);
    // First row: lons[0..2] = 0, 5, 10
    assert.equal(g.lons[0], 0);
    assert.equal(g.lons[1], 5);
    assert.equal(g.lons[2], 10);
  });

  test('throws on missing bounds or invalid dim', () => {
    assert.throws(() => buildSampleGrid(null, 5), /bounds required/);
    assert.throws(() => buildSampleGrid(bounds, 1), />= 2/);
    assert.throws(() => buildSampleGrid(bounds, 2.5), />= 2/);
  });
});

describe('buildOmegaUrl', () => {
  test('builds a query string with comma-separated coords', () => {
    const url = buildOmegaUrl({ lats: [52, 53], lons: [5, 6] });
    assert.match(url, /latitude=52\.000,53\.000/);
    assert.match(url, /longitude=5\.000,6\.000/);
    assert.match(url, /hourly=vertical_velocity_850hPa/);
  });

  test('throws on bad input', () => {
    assert.throws(() => buildOmegaUrl(null), /lats\[\] and lons\[\]/);
    assert.throws(() => buildOmegaUrl({}), /lats\[\] and lons\[\]/);
  });
});

describe('parseOmegaResponse', () => {
  const mkLoc = (times, values) => ({
    hourly: { time: times, vertical_velocity_850hPa: values },
  });

  test('extracts the matching-hour value at each location', () => {
    const data = [
      mkLoc(['2026-05-13T00', '2026-05-13T10', '2026-05-13T20'], [0.1, -0.2, 0.3]),
      mkLoc(['2026-05-13T00', '2026-05-13T10', '2026-05-13T20'], [0.4, 0.5, -0.6]),
      mkLoc(['2026-05-13T00', '2026-05-13T10', '2026-05-13T20'], [-0.7, 0.8, 0.9]),
      mkLoc(['2026-05-13T00', '2026-05-13T10', '2026-05-13T20'], [1.0, -1.1, 1.2]),
    ];
    const out = parseOmegaResponse(data, 2, '2026-05-13T10');
    assert.ok(Math.abs(out.grid[0] - -0.2) < 1e-6);
    assert.ok(Math.abs(out.grid[1] - 0.5) < 1e-6);
    assert.ok(Math.abs(out.grid[2] - 0.8) < 1e-6);
    assert.ok(Math.abs(out.grid[3] - -1.1) < 1e-6);
    assert.equal(out.width, 2);
    assert.equal(out.height, 2);
  });

  test('falls back to first hour when no matching hour found', () => {
    const data = [
      mkLoc(['2026-05-13T05'], [0.5]),
      mkLoc(['2026-05-13T05'], [0.6]),
      mkLoc(['2026-05-13T05'], [0.7]),
      mkLoc(['2026-05-13T05'], [0.8]),
    ];
    const out = parseOmegaResponse(data, 2, '2026-05-13T22'); // not present
    assert.ok(Math.abs(out.grid[0] - 0.5) < 1e-6);
  });

  test('falls back to 0 for missing values at a location', () => {
    const data = [
      { hourly: { time: ['2026-05-13T10'], vertical_velocity_850hPa: [null] } },
      { hourly: {} }, // entirely missing
      {},             // no hourly at all
      { hourly: { time: ['2026-05-13T10'], vertical_velocity_850hPa: [0.5] } },
    ];
    const out = parseOmegaResponse(data, 2, '2026-05-13T10');
    assert.equal(out.grid[0], 0);
    assert.equal(out.grid[1], 0);
    assert.equal(out.grid[2], 0);
    assert.ok(Math.abs(out.grid[3] - 0.5) < 1e-6);
  });

  test('throws when location count mismatches dim*dim', () => {
    assert.throws(
      () => parseOmegaResponse([mkLoc(['2026-05-13T10'], [0.1])], 2, '2026-05-13T10'),
      /expected 4 locations, got 1/,
    );
  });

  test('throws on invalid input', () => {
    assert.throws(() => parseOmegaResponse(null, 2), /must be an array/);
    assert.throws(() => parseOmegaResponse([], 1), />= 2/);
    assert.throws(() => parseOmegaResponse([], 2.5), />= 2/);
  });
});

describe('upsampleOmegaField', () => {
  test('uniform low-res produces uniform high-res', () => {
    const low = { width: 3, height: 3, grid: new Float32Array(9).fill(2) };
    const up = upsampleOmegaField(low, 12, 12);
    for (const v of up.grid) assert.equal(v, 2);
  });

  test('linear gradient is preserved', () => {
    // 2×2 with values [0,1; 0,1] → uniform horizontal gradient
    const low = { width: 2, height: 2, grid: new Float32Array([0, 1, 0, 1]) };
    const up = upsampleOmegaField(low, 5, 5);
    // Middle column at x=2 (of 5) maps to gx=0.5 → value 0.5
    for (let row = 0; row < 5; row++) {
      const v = up.grid[row * 5 + 2];
      assert.ok(Math.abs(v - 0.5) < 1e-5, `row ${row}: ${v}`);
    }
  });

  test('output dimensions match the target', () => {
    const low = { width: 3, height: 3, grid: new Float32Array(9) };
    const up = upsampleOmegaField(low, 8, 6);
    assert.equal(up.width, 8);
    assert.equal(up.height, 6);
    assert.equal(up.grid.length, 48);
  });

  test('throws on missing or malformed lowRes', () => {
    assert.throws(() => upsampleOmegaField(null, 8, 8), /lowRes/);
    assert.throws(() => upsampleOmegaField({}, 8, 8), /lowRes/);
  });

  test('throws on invalid target dimensions', () => {
    const low = { width: 3, height: 3, grid: new Float32Array(9) };
    assert.throws(() => upsampleOmegaField(low, 0, 8), /target dimensions/);
    assert.throws(() => upsampleOmegaField(low, 8, -1), /target dimensions/);
  });
});

describe('encodeOmegaToRgba', () => {
  test('exact zero → transparent; sub-epsilon values also skipped', () => {
    // |t| below the 0.02 epsilon stays at alpha 0. With scale 0.12 the
    // epsilon corresponds to omega ≈ 0.0024 m/s.
    const grid = new Float32Array([0, 0.0023, -0.0023, 0]);
    const out = encodeOmegaToRgba(grid, 2, 2);
    for (let i = 3; i < out.length; i += 4) assert.equal(out[i], 0);
  });

  test('negative (rising/growth) → vivid mint green', () => {
    const grid = new Float32Array([-0.3]);
    const out = encodeOmegaToRgba(grid, 1, 1);
    assert.equal(out[0], 90);
    assert.equal(out[1], 230);
    assert.equal(out[2], 130);
    assert.ok(out[3] > 0);
  });

  test('positive (sinking/decay) → vivid magenta purple', () => {
    const grid = new Float32Array([0.3]);
    const out = encodeOmegaToRgba(grid, 1, 1);
    assert.equal(out[0], 190);
    assert.equal(out[1], 90);
    assert.equal(out[2], 240);
    assert.ok(out[3] > 0);
  });

  test('beyond ±scale clamps to t=±1 (max alpha)', () => {
    const grid = new Float32Array([10, -10]);
    const out = encodeOmegaToRgba(grid, 2, 1, { scale: 0.3, maxAlpha: 200, minAlpha: 70 });
    assert.equal(out[3], 200);
    assert.equal(out[7], 200);
  });

  test('weak omega still renders with at least minAlpha (no near-invisible washes)', () => {
    // Just above the epsilon (0.02) cutoff: |t| = 0.03 (scale 0.12 → v = 0.0036)
    const grid = new Float32Array([0.005]);
    const out = encodeOmegaToRgba(grid, 1, 1);
    // Expect alpha close to minAlpha (70), not vanishingly small
    assert.ok(out[3] >= 70, `expected at least minAlpha 70, got ${out[3]}`);
  });

  test('non-finite values render as transparent', () => {
    const grid = new Float32Array([NaN, Infinity]);
    const out = encodeOmegaToRgba(grid, 2, 1);
    assert.equal(out[3], 0);
    assert.equal(out[7], 0);
  });

  test('throws on dimension mismatch and bad scale', () => {
    const grid = new Float32Array(3);
    assert.throws(() => encodeOmegaToRgba(grid, 2, 2), /length/);
    assert.throws(() => encodeOmegaToRgba(new Float32Array(4), 2, 2, { scale: 0 }), /scale/);
  });
});
