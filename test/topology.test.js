import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THRESHOLDS_MM_PER_HOUR,
  DEFAULT_MIN_AREA_CELLS,
  DEFAULT_FRAME_INTERVAL_MINUTES,
  buildTopology,
} from '../public/topology.js';

const mkGrid = (w, h, fn) => {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = fn(x, y);
  return g;
};

describe('exports', () => {
  test('defaults match the plan', () => {
    assert.deepEqual([...DEFAULT_THRESHOLDS_MM_PER_HOUR], [0.5, 2, 10, 30]);
    assert.equal(DEFAULT_MIN_AREA_CELLS, 5);
    assert.equal(DEFAULT_FRAME_INTERVAL_MINUTES, 10);
  });
});

describe('buildTopology — empty / no rain', () => {
  test('all-zero grid → empty clouds, sane frame metadata', () => {
    const grid = new Float32Array(64);
    const out = buildTopology(grid, 8, 8);
    assert.equal(out.clouds.length, 0);
    assert.equal(out.frame.kind, 'observed');
    assert.equal(out.frame.leadMinutes, 0);
    assert.equal(out.frame.intervalMinutes, 10);
    assert.deepEqual(out.frame.grid, { width: 8, height: 8 });
    assert.deepEqual(out.thresholds.rainMmPerHour, [0.5, 2, 10, 30]);
  });

  test('frame metadata is forwarded into the topology', () => {
    const grid = new Float32Array(64);
    const out = buildTopology(grid, 8, 8, {}, {
      frame: {
        time: '2026-05-13T14:30:00Z',
        kind: 'forecast',
        leadMinutes: 60,
        intervalMinutes: 10,
        tile: { x: 16, y: 10, z: 5 },
      },
    });
    assert.equal(out.frame.time, '2026-05-13T14:30:00Z');
    assert.equal(out.frame.kind, 'forecast');
    assert.equal(out.frame.leadMinutes, 60);
    assert.deepEqual(out.frame.tile, { x: 16, y: 10, z: 5 });
  });
});

describe('buildTopology — single blob', () => {
  test('a 5×5 hot region → exactly one cloud with stable id c001', () => {
    const grid = mkGrid(20, 20, (x, y) => (x >= 5 && x <= 9 && y >= 5 && y <= 9 ? 25 : 0));
    const out = buildTopology(grid, 20, 20);
    assert.equal(out.clouds.length, 1);
    const c = out.clouds[0];
    assert.equal(c.id, 'c001');
    assert.equal(c.blob.cellCount, 25);
    assert.equal(c.blob.peak, 25);
    // Centroid at (7, 7) — middle of 5..9
    assert.ok(Math.abs(c.centroid[0] - 7) < 1e-6);
    assert.ok(Math.abs(c.centroid[1] - 7) < 1e-6);
    // Levels: only 0.5, 2, 10 (peak 25 < 30)
    const tiers = c.levels.map((l) => l.thresholdMmPerHour);
    assert.deepEqual(tiers, [0.5, 2, 10]);
    // Each level has one polygon
    for (const lvl of c.levels) {
      assert.ok(lvl.polygons.length >= 1);
    }
    // Severity: peak 25 → heavy
    assert.equal(c.severity.tier, 'heavy');
  });

  test('peak above 30 includes the 30 mm/h core', () => {
    const grid = mkGrid(20, 20, (x, y) => (x >= 5 && x <= 9 && y >= 5 && y <= 9 ? 50 : 0));
    const out = buildTopology(grid, 20, 20);
    assert.equal(out.clouds.length, 1);
    const c = out.clouds[0];
    assert.deepEqual(c.levels.map((l) => l.thresholdMmPerHour), [0.5, 2, 10, 30]);
  });
});

describe('buildTopology — multiple blobs', () => {
  test('two disjoint blobs → two clouds, sorted by descending severity', () => {
    // Blob A: 5×5 at peak 50 (severe)
    // Blob B: 5×5 at peak 8 (moderate)
    const grid = mkGrid(40, 20, (x, y) => {
      if (x >= 2 && x <= 6 && y >= 2 && y <= 6) return 50;  // A: severe
      if (x >= 30 && x <= 34 && y >= 10 && y <= 14) return 8; // B: moderate
      return 0;
    });
    const out = buildTopology(grid, 40, 20);
    assert.equal(out.clouds.length, 2);
    // Severe sorts first → c001 is the 50-peak blob
    assert.equal(out.clouds[0].severity.tier, 'severe');
    assert.equal(out.clouds[0].id, 'c001');
    assert.equal(out.clouds[1].severity.tier, 'moderate');
    assert.equal(out.clouds[1].id, 'c002');
  });

  test('ties on severity score break by larger area (deterministic)', () => {
    // Two blobs with identical peak/intensity profile — only area differs
    const grid = mkGrid(40, 20, (x, y) => {
      if (x >= 2 && x <= 6 && y >= 2 && y <= 6) return 8;     // 5×5 = 25 cells
      if (x >= 28 && x <= 36 && y >= 10 && y <= 18) return 8; // 9×9 = 81 cells
      return 0;
    });
    const out = buildTopology(grid, 40, 20);
    assert.equal(out.clouds.length, 2);
    // Larger area is c001
    assert.equal(out.clouds[0].blob.cellCount, 81);
    assert.equal(out.clouds[1].blob.cellCount, 25);
  });
});

describe('buildTopology — masking', () => {
  test('contour for one blob does NOT enclose pixels of an adjacent blob', () => {
    // Two side-by-side blobs separated by 3 cells of zero
    const grid = mkGrid(20, 10, (x, y) => {
      if (x >= 2 && x <= 5 && y >= 2 && y <= 6) return 30;
      if (x >= 10 && x <= 13 && y >= 2 && y <= 6) return 30;
      return 0;
    });
    const out = buildTopology(grid, 20, 10);
    assert.equal(out.clouds.length, 2);
    for (const c of out.clouds) {
      const env = c.levels[0];
      assert.ok(env.polygons.length >= 1);
      // Polygon vertices for cloud A should all have x ≤ 6.5; cloud B all x ≥ 9.5
      for (const poly of env.polygons) {
        const xs = poly.map((p) => p[0]);
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        // Either entirely on the left or entirely on the right of the gap
        assert.ok(maxX < 7 || minX > 8, `cloud ${c.id} polygon x range [${minX}, ${maxX}]`);
      }
    }
  });
});

describe('buildTopology — supporting signals & motion', () => {
  test('severity is computed per-blob from the supporting fields', () => {
    const grid = mkGrid(20, 20, (x, y) => (x >= 5 && x <= 9 && y >= 5 && y <= 9 ? 40 : 0));
    const cape = { width: 20, height: 20, grid: new Float32Array(400).fill(1500) };
    const conv = { width: 20, height: 20, grid: new Float32Array(400) };
    // Set some convective core cells inside the blob
    for (let y = 6; y <= 8; y++) for (let x = 6; x <= 8; x++) conv.grid[y * 20 + x] = 1;
    const tscore = { width: 20, height: 20, grid: new Float32Array(400) };
    for (let y = 6; y <= 8; y++) for (let x = 6; x <= 8; x++) tscore.grid[y * 20 + x] = 0.7;
    const out = buildTopology(grid, 20, 20, { cape, convective: conv, thunderscore: tscore });
    assert.equal(out.clouds[0].severity.tier, 'thunderstorm');
    assert.ok(out.clouds[0].severity.drivers.convectiveCoreCells > 0);
  });

  test('motion samples the (coarser) flow field inside the blob', () => {
    const grid = mkGrid(20, 20, (x, y) => (x >= 5 && x <= 9 && y >= 5 && y <= 9 ? 30 : 0));
    // Flow at 5×5 resolution (each block covers 4×4 source pixels)
    // Uniform translation: vx=2, vy=0 in flow-block units → vx=0.5 per source pixel
    const flow = { width: 5, height: 5, blockSize: 4, data: new Float32Array(50) };
    for (let i = 0; i < 25; i++) { flow.data[i * 2] = 2; flow.data[i * 2 + 1] = 0; }
    const out = buildTopology(grid, 20, 20, { flow });
    const m = out.clouds[0].motion;
    assert.ok(m, 'expected motion to be set');
    // Source-pixel units: vx = 2 / (fW/gridWidth) = 2 / 0.25 = 8
    assert.ok(Math.abs(m.vx - 8) < 1e-6, `vx=${m.vx}`);
    assert.ok(Math.abs(m.vy) < 1e-6, `vy=${m.vy}`);
  });

  test('motion is null when no flow field is supplied', () => {
    const grid = mkGrid(20, 20, (x, y) => (x >= 5 && x <= 9 && y >= 5 && y <= 9 ? 30 : 0));
    const out = buildTopology(grid, 20, 20);
    assert.equal(out.clouds[0].motion, null);
  });

  test('motion ignores NaN flow samples (returns null if nothing valid)', () => {
    const grid = mkGrid(20, 20, (x, y) => (x >= 5 && x <= 9 && y >= 5 && y <= 9 ? 30 : 0));
    const flow = { width: 5, height: 5, blockSize: 4, data: new Float32Array(50).fill(NaN) };
    const out = buildTopology(grid, 20, 20, { flow });
    assert.equal(out.clouds[0].motion, null);
  });
});

describe('buildTopology — input validation', () => {
  test('throws on invalid dimensions', () => {
    assert.throws(() => buildTopology(new Float32Array(2), 1, 2), />= 2/);
  });

  test('throws on grid length mismatch', () => {
    assert.throws(() => buildTopology(new Float32Array(5), 2, 2), /grid length/);
  });

  test('throws on empty thresholds array', () => {
    assert.throws(() => buildTopology(new Float32Array(4), 2, 2, {}, { thresholds: [] }), /thresholds/);
  });

  test('thresholds passed unsorted are sorted internally', () => {
    const grid = mkGrid(20, 20, (x, y) => (x >= 5 && x <= 9 && y >= 5 && y <= 9 ? 25 : 0));
    const out = buildTopology(grid, 20, 20, {}, { thresholds: [10, 0.5, 2] });
    assert.deepEqual(out.thresholds.rainMmPerHour, [0.5, 2, 10]);
    // Cloud levels also sorted
    assert.deepEqual(out.clouds[0].levels.map((l) => l.thresholdMmPerHour), [0.5, 2, 10]);
  });
});
