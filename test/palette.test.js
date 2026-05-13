import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  PALETTE_STOPS,
  TRANSPARENT_DBZ,
  dbzToRainRate,
  rainRateToDbz,
  rgbToDbz,
  dbzToRgb,
  dbzToRgbSmooth,
  RAIN_FADE_FLOOR_DBZ,
  RAIN_FADE_CEILING_DBZ,
  decodeRgbaToRainRate,
  encodeRainRateToRgba,
  bilinearUpsample,
} from '../public/palette.js';

describe('PALETTE_STOPS', () => {
  test('first stop is the transparent / no-rain anchor', () => {
    assert.equal(PALETTE_STOPS[0].dbz, TRANSPARENT_DBZ);
  });

  test('rain-bearing stops are monotonically increasing in dBZ', () => {
    const rainStops = PALETTE_STOPS.filter((s) => Number.isFinite(s.dbz));
    for (let i = 1; i < rainStops.length; i++) {
      assert.ok(
        rainStops[i].dbz > rainStops[i - 1].dbz,
        `stop ${i} (dbz=${rainStops[i].dbz}) must exceed previous (${rainStops[i - 1].dbz})`,
      );
    }
  });

  test('every stop has a 3-element rgb tuple in [0,255]', () => {
    for (const s of PALETTE_STOPS) {
      assert.equal(s.rgb.length, 3);
      for (const c of s.rgb) {
        assert.ok(c >= 0 && c <= 255, `channel ${c} out of range`);
      }
    }
  });
});

describe('Marshall-Palmer Z-R', () => {
  test('dbzToRainRate returns 0 for non-finite input', () => {
    assert.equal(dbzToRainRate(TRANSPARENT_DBZ), 0);
    assert.equal(dbzToRainRate(NaN), 0);
  });

  test('dbzToRainRate increases monotonically with dBZ', () => {
    let prev = -Infinity;
    for (let dbz = 0; dbz <= 60; dbz += 5) {
      const r = dbzToRainRate(dbz);
      assert.ok(r > prev, `expected R(${dbz})>${prev}, got ${r}`);
      prev = r;
    }
  });

  test('rainRateToDbz returns -Infinity for zero/negative rain', () => {
    assert.equal(rainRateToDbz(0), TRANSPARENT_DBZ);
    assert.equal(rainRateToDbz(-1), TRANSPARENT_DBZ);
  });

  test('round-trips dbz → mm/h → dbz to high precision', () => {
    for (const dbz of [5, 15, 25, 35, 45, 55]) {
      const r = dbzToRainRate(dbz);
      const back = rainRateToDbz(r);
      assert.ok(Math.abs(back - dbz) < 1e-9, `round-trip ${dbz} -> ${r} -> ${back}`);
    }
  });

  test('approximate physical sanity: 30 dBZ gives ~3 mm/h, 50 dBZ ~50 mm/h', () => {
    // Marshall-Palmer textbook ballpark
    assert.ok(dbzToRainRate(30) > 2 && dbzToRainRate(30) < 4);
    assert.ok(dbzToRainRate(50) > 30 && dbzToRainRate(50) < 80);
  });
});

describe('rgbToDbz', () => {
  test('alpha = 0 always decodes to TRANSPARENT_DBZ regardless of colour', () => {
    assert.equal(rgbToDbz(255, 255, 255, 0), TRANSPARENT_DBZ);
    assert.equal(rgbToDbz(123, 45, 67, 0), TRANSPARENT_DBZ);
  });

  test('exact palette colours decode to their stop dBZ', () => {
    for (const stop of PALETTE_STOPS.filter((s) => Number.isFinite(s.dbz))) {
      const [r, g, b] = stop.rgb;
      assert.equal(rgbToDbz(r, g, b, 255), stop.dbz);
    }
  });

  test('near-palette colours snap to nearest stop', () => {
    // Slightly-off pure red -> 50 dBZ stop (rgb 255,0,0)
    assert.equal(rgbToDbz(250, 5, 5), 50);
  });

  test('pure black opaque pixel decodes to TRANSPARENT_DBZ (no-rain anchor)', () => {
    assert.equal(rgbToDbz(0, 0, 0, 255), TRANSPARENT_DBZ);
  });

  test('alpha defaults to 255 (opaque) when omitted', () => {
    assert.equal(rgbToDbz(255, 0, 0), 50);
  });
});

describe('dbzToRgb', () => {
  test('non-finite or sub-threshold dbz returns the no-rain colour', () => {
    assert.deepEqual([...dbzToRgb(TRANSPARENT_DBZ)], [0, 0, 0]);
    assert.deepEqual([...dbzToRgb(NaN)], [0, 0, 0]);
    assert.deepEqual([...dbzToRgb(-50)], [0, 0, 0]);
  });

  test('exact stop dBZ returns that stop colour', () => {
    for (const stop of PALETTE_STOPS.filter((s) => Number.isFinite(s.dbz))) {
      assert.deepEqual([...dbzToRgb(stop.dbz)], [...stop.rgb]);
    }
  });

  test('mid-range dBZ snaps to closest stop', () => {
    // 47 is between 45 and 50, closer to 45
    const rgb45 = PALETTE_STOPS.find((s) => s.dbz === 45).rgb;
    assert.deepEqual([...dbzToRgb(47)], [...rgb45]);
  });
});

describe('decodeRgbaToRainRate', () => {
  test('throws when buffer length does not match width*height*4', () => {
    assert.throws(
      () => decodeRgbaToRainRate(new Uint8ClampedArray(10), 2, 2),
      /does not match/,
    );
  });

  test('decodes a 2x2 grid of mixed pixels into a Float32Array of mm/h', () => {
    // Two transparent, one pure red (50 dBZ), one black opaque (no rain)
    const buf = new Uint8ClampedArray([
      0, 0, 0, 0,        // transparent
      255, 0, 0, 255,    // red, 50 dBZ
      0, 144, 0, 255,    // dark green, 30 dBZ
      0, 0, 0, 255,      // black opaque, no rain
    ]);
    const grid = decodeRgbaToRainRate(buf, 2, 2);
    assert.equal(grid.length, 4);
    assert.equal(grid[0], 0);
    assert.ok(grid[1] > 30 && grid[1] < 80, `expected ~50 dBZ rain rate, got ${grid[1]}`);
    assert.ok(grid[2] > 2 && grid[2] < 4, `expected ~30 dBZ rain rate, got ${grid[2]}`);
    assert.equal(grid[3], 0);
  });

  test('returns a Float32Array with width*height entries', () => {
    const buf = new Uint8ClampedArray(4 * 9);
    const grid = decodeRgbaToRainRate(buf, 3, 3);
    assert.ok(grid instanceof Float32Array);
    assert.equal(grid.length, 9);
  });
});

describe('dbzToRgbSmooth', () => {
  test('returns null below the lowest rain stop / for non-finite input', () => {
    assert.equal(dbzToRgbSmooth(TRANSPARENT_DBZ), null);
    assert.equal(dbzToRgbSmooth(NaN), null);
    assert.equal(dbzToRgbSmooth(-50), null);
    assert.equal(dbzToRgbSmooth(0), null);
  });

  test('returns the exact palette colour at every defined stop', () => {
    for (const stop of PALETTE_STOPS) {
      if (!Number.isFinite(stop.dbz)) continue;
      const out = dbzToRgbSmooth(stop.dbz);
      assert.ok(out);
      assert.ok(Math.abs(out[0] - stop.rgb[0]) < 1e-6, `r at ${stop.dbz}`);
      assert.ok(Math.abs(out[1] - stop.rgb[1]) < 1e-6, `g at ${stop.dbz}`);
      assert.ok(Math.abs(out[2] - stop.rgb[2]) < 1e-6, `b at ${stop.dbz}`);
    }
  });

  test('values between two stops produce strictly-between RGB channels', () => {
    // 32.5 dBZ is halfway between stop 30 (dark green 0,144,0) and stop 35
    // (yellow 255,255,0). Each channel must lerp accordingly.
    const out = dbzToRgbSmooth(32.5);
    assert.ok(out);
    assert.ok(Math.abs(out[0] - 127.5) < 1e-6, `r=${out[0]}`);
    assert.ok(Math.abs(out[1] - 199.5) < 1e-6, `g=${out[1]}`);
    assert.equal(out[2], 0);
  });

  test('values above the top stop clamp to the top stop colour', () => {
    const top = PALETTE_STOPS[PALETTE_STOPS.length - 1];
    const out = dbzToRgbSmooth(top.dbz + 50);
    assert.deepEqual(out, [...top.rgb]);
  });

  test('fade-in band defaults are sensible', () => {
    assert.equal(RAIN_FADE_FLOOR_DBZ, 5);
    assert.equal(RAIN_FADE_CEILING_DBZ, 10);
  });
});

describe('encodeRainRateToRgba', () => {
  test('throws on dimension mismatch', () => {
    assert.throws(
      () => encodeRainRateToRgba(new Float32Array(5), 2, 2),
      /does not match/,
    );
  });

  test('zero / negative mm/h → transparent black (RGBA = 0,0,0,0)', () => {
    const grid = new Float32Array([0, -1, 0, 0]);
    const out = encodeRainRateToRgba(grid, 2, 2);
    for (let i = 0; i < out.length; i++) assert.equal(out[i], 0);
  });

  test('heavy rain (above the fade-in band) renders opaque and near the red palette stop', () => {
    // 50 mm/h ≈ 51 dBZ → between stop 50 (red) and stop 55 (dark red), so
    // the smooth lerp lands close to red.
    const grid = new Float32Array([50]);
    const out = encodeRainRateToRgba(grid, 1, 1);
    assert.ok(out[0] > 230 && out[0] <= 255, `r=${out[0]}`);
    assert.equal(out[1], 0);
    assert.equal(out[2], 0);
    assert.equal(out[3], 255);
  });

  test('very light rain (below the fade ceiling) fades alpha rather than rendering fully opaque', () => {
    // ~0.1 mm/h ≈ 7 dBZ — partway up the fade band 5..10 dBZ
    const grid = new Float32Array([0.1]);
    const out = encodeRainRateToRgba(grid, 1, 1);
    assert.ok(out[3] > 0 && out[3] < 255, `expected partial alpha, got ${out[3]}`);
  });

  test('mid-band rain rate interpolates RGB between adjacent palette stops', () => {
    // 5 mm/h ≈ 32 dBZ — between stop 30 (dark green 0,144,0) and stop 35
    // (yellow 255,255,0). Smooth lerp must be in between on every channel,
    // NOT a snap to either endpoint.
    const grid = new Float32Array([5]);
    const out = encodeRainRateToRgba(grid, 1, 1);
    assert.ok(out[0] > 0 && out[0] < 255, `r=${out[0]} should be interpolated`);
    assert.ok(out[1] > 144 && out[1] < 255, `g=${out[1]} should be interpolated`);
    assert.equal(out[2], 0); // both stops have b=0
  });

  test('roundtrips back through decodeRgbaToRainRate (within palette quantisation)', () => {
    const grid = new Float32Array([0, 3, 50, 0]);
    const rgba = encodeRainRateToRgba(grid, 2, 2);
    const back = decodeRgbaToRainRate(rgba, 2, 2);
    assert.equal(back[0], 0);
    assert.equal(back[3], 0);
    // Mid-band: round-trip lands within palette stop quantisation
    assert.ok(back[1] > 1 && back[1] < 10, `idx 1: ${back[1]}`);
    assert.ok(back[2] > 30 && back[2] < 80, `idx 2: ${back[2]}`);
  });

  test('returns a Uint8ClampedArray of width*height*4 entries', () => {
    const grid = new Float32Array(9);
    const out = encodeRainRateToRgba(grid, 3, 3);
    assert.ok(out instanceof Uint8ClampedArray);
    assert.equal(out.length, 36);
  });
});

describe('bilinearUpsample', () => {
  test('factor=1 short-circuits and returns the same grid reference', () => {
    const grid = Float32Array.from([1, 2, 3, 4]);
    const out = bilinearUpsample(grid, 2, 2, 1);
    assert.equal(out, grid);
  });

  test('factor=2 quadruples the cell count and interpolates between corners', () => {
    const grid = Float32Array.from([0, 10, 0, 10]); // 2×2: top row 0,10; bottom row 0,10
    const out = bilinearUpsample(grid, 2, 2, 2);
    assert.equal(out.length, 16);
    // The interior column (x=1, x=2) should hold mid values between 0 and 10
    // Specifically the four output cells in the top-left 2x2 of the upsampled
    // grid (covering source (0..1) × (0..1)) should range smoothly 0..10 in x.
    assert.equal(out[0], 0);    // (0,0) → source (0,0) = 0
    assert.ok(out[1] > 0 && out[1] < 10, `out[1]=${out[1]}`);  // (1,0) interpolated
    assert.ok(Math.abs(out[2] - 10) < 1e-6 || Math.abs(out[2] - 10) < 1e-6); // (2,0)
  });

  test('factor=2 preserves source corner values at the upsampled corner positions', () => {
    const grid = Float32Array.from([5, 20, 30, 40]);
    const out = bilinearUpsample(grid, 2, 2, 2);
    // Source (0,0) = 5 → out (0,0) = 5
    assert.equal(out[0], 5);
    // Source (1,0) = 20 → out (2,0) = 20 (since at integer-multiple coords)
    assert.equal(out[2], 20);
    // Source (0,1) = 30 → out (0,2) = 30
    assert.equal(out[2 * 4 + 0], 30);
    // Source (1,1) = 40 → out (2,2) = 40
    assert.equal(out[2 * 4 + 2], 40);
  });

  test('factor=2 on a uniform field stays uniform', () => {
    const grid = new Float32Array(16).fill(7);
    const out = bilinearUpsample(grid, 4, 4, 2);
    for (const v of out) assert.equal(v, 7);
  });

  test('factor=4 expands by 16× cell count', () => {
    const out = bilinearUpsample(new Float32Array(4), 2, 2, 4);
    assert.equal(out.length, 64);
  });

  test('throws on bad inputs', () => {
    assert.throws(() => bilinearUpsample(null, 2, 2, 2), /grid length/);
    assert.throws(() => bilinearUpsample(new Float32Array(3), 2, 2, 2), /grid length/);
    assert.throws(() => bilinearUpsample(new Float32Array(4), 0, 2, 2), /positive integers/);
    assert.throws(() => bilinearUpsample(new Float32Array(4), 2, 2, 0), /positive integer/);
    assert.throws(() => bilinearUpsample(new Float32Array(4), 2, 2, 1.5), /positive integer/);
  });
});
