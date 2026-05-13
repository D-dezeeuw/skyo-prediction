import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CAPE_SCALE,
  DEFAULT_CAPE_MAX_ALPHA,
  buildCapeUrl,
  parseCapeResponse,
  upsampleCapeField,
  encodeCapeToRgba,
} from '../public/cape.js';

describe('exports', () => {
  test('default scale = 2500 J/kg (severe convection threshold)', () => {
    assert.equal(DEFAULT_CAPE_SCALE, 2500);
    assert.equal(DEFAULT_CAPE_MAX_ALPHA, 180);
  });
});

describe('buildCapeUrl', () => {
  test('builds an Open-Meteo URL with the cape hourly variable', () => {
    const url = buildCapeUrl({ lats: [52, 53], lons: [5, 6] });
    assert.match(url, /latitude=52\.000,53\.000/);
    assert.match(url, /hourly=cape/);
  });
});

describe('parseCapeResponse', () => {
  test('extracts cape values at the matching hour', () => {
    const data = [
      { hourly: { time: ['2026-05-13T10', '2026-05-13T11'], cape: [500, 1500] } },
      { hourly: { time: ['2026-05-13T10', '2026-05-13T11'], cape: [800, 2200] } },
      { hourly: { time: ['2026-05-13T10', '2026-05-13T11'], cape: [1000, 1800] } },
      { hourly: { time: ['2026-05-13T10', '2026-05-13T11'], cape: [200, 600] } },
    ];
    const out = parseCapeResponse(data, 2, '2026-05-13T11');
    assert.equal(out.grid[0], 1500);
    assert.equal(out.grid[1], 2200);
    assert.equal(out.grid[2], 1800);
    assert.equal(out.grid[3], 600);
    assert.equal(out.width, 2);
    assert.equal(out.height, 2);
  });

  test('falls back to first hour on miss; 0 for missing values', () => {
    const data = [
      { hourly: { time: ['2026-05-13T10'], cape: [800] } },
      { hourly: {} },
      {},
      { hourly: { time: ['2026-05-13T10'], cape: [null] } },
    ];
    const out = parseCapeResponse(data, 2, '2026-05-13T99');
    assert.equal(out.grid[0], 800);
    assert.equal(out.grid[1], 0);
    assert.equal(out.grid[2], 0);
    assert.equal(out.grid[3], 0);
  });
});

describe('upsampleCapeField', () => {
  test('delegates to omega upsampler — uniform low-res stays uniform', () => {
    const low = { width: 3, height: 3, grid: new Float32Array(9).fill(1500) };
    const up = upsampleCapeField(low, 8, 8);
    for (const v of up.grid) assert.equal(v, 1500);
  });
});

describe('encodeCapeToRgba', () => {
  test('zero CAPE → transparent', () => {
    const grid = new Float32Array([0]);
    const out = encodeCapeToRgba(grid, 1, 1);
    for (let i = 0; i < 4; i++) assert.equal(out[i], 0);
  });

  test('below epsilon (~5 % of scale = 125 J/kg) → transparent', () => {
    const grid = new Float32Array([100]);
    const out = encodeCapeToRgba(grid, 1, 1);
    assert.equal(out[3], 0);
  });

  test('moderate CAPE renders mid-orange with proportional alpha', () => {
    const grid = new Float32Array([1250]); // t = 0.5
    const out = encodeCapeToRgba(grid, 1, 1);
    // alpha: 0.5 * 180 = 90
    assert.equal(out[3], 90);
    assert.ok(out[0] > 200 && out[0] < 250);
  });

  test('CAPE at or above scale clamps to t=1 (deep red, full alpha)', () => {
    const grid = new Float32Array([5000]);
    const out = encodeCapeToRgba(grid, 1, 1, { scale: 2500, maxAlpha: 200 });
    assert.equal(out[0], 200);
    assert.equal(out[1], 30);
    assert.equal(out[2], 30);
    assert.equal(out[3], 200);
  });

  test('non-finite or negative values render as transparent', () => {
    const grid = new Float32Array([NaN, -100, Infinity]);
    const out = encodeCapeToRgba(grid, 3, 1);
    assert.equal(out[3], 0);
    assert.equal(out[7], 0);
    assert.equal(out[11], 0);
  });

  test('throws on dimension mismatch and invalid scale', () => {
    assert.throws(() => encodeCapeToRgba(new Float32Array(3), 2, 2), /length/);
    assert.throws(() => encodeCapeToRgba(new Float32Array(4), 2, 2, { scale: 0 }), /scale/);
  });
});
