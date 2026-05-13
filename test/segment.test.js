import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RAIN_THRESHOLD,
  DEFAULT_MIN_AREA_CELLS,
  DEFAULT_CONNECTIVITY,
  labelConnectedComponents,
} from '../public/segment.js';

const mkGrid = (w, h, fn) => {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = fn(x, y);
  return g;
};

describe('exports', () => {
  test('defaults match the plan (0.5 mm/h, 5 cells, 8-connectivity)', () => {
    assert.equal(DEFAULT_RAIN_THRESHOLD, 0.5);
    assert.equal(DEFAULT_MIN_AREA_CELLS, 5);
    assert.equal(DEFAULT_CONNECTIVITY, 8);
  });
});

describe('labelConnectedComponents', () => {
  test('empty grid (all zero) → no blobs, all labels zero', () => {
    const grid = new Float32Array(64);
    const out = labelConnectedComponents(grid, 8, 8);
    assert.equal(out.blobs.length, 0);
    for (const v of out.labels) assert.equal(v, 0);
  });

  test('single rectangular blob → exactly one blob with correct stats', () => {
    // 3×3 hot block at (2..4, 2..4) in an 8×8 grid, peak 50, others 5
    const grid = mkGrid(8, 8, (x, y) => (x >= 2 && x <= 4 && y >= 2 && y <= 4 ? 50 : 5));
    const out = labelConnectedComponents(grid, 8, 8, { threshold: 10 });
    assert.equal(out.blobs.length, 1);
    const b = out.blobs[0];
    assert.equal(b.id, 1);
    assert.equal(b.cells.length, 9);
    assert.equal(b.peak, 50);
    assert.equal(b.mean, 50);
    assert.equal(b.sum, 450);
    assert.deepEqual(b.bbox, { minX: 2, maxX: 4, minY: 2, maxY: 4 });
    // All 9 in-blob cells are labeled 1; everything else is 0
    let inLabel = 0;
    for (const v of out.labels) if (v === 1) inLabel++;
    assert.equal(inLabel, 9);
  });

  test('two disjoint blobs → two distinct IDs', () => {
    const grid = mkGrid(10, 10, (x, y) => {
      if (x >= 0 && x <= 2 && y >= 0 && y <= 2) return 30; // 3×3 top-left
      if (x >= 6 && x <= 8 && y >= 6 && y <= 8) return 40; // 3×3 bottom-right
      return 0;
    });
    const out = labelConnectedComponents(grid, 10, 10);
    assert.equal(out.blobs.length, 2);
    const [a, b] = out.blobs;
    assert.equal(a.id, 1);
    assert.equal(b.id, 2);
    assert.equal(a.cells.length, 9);
    assert.equal(b.cells.length, 9);
    assert.equal(a.peak, 30);
    assert.equal(b.peak, 40);
  });

  test('donut → single blob covering the ring only (hole stays unlabeled)', () => {
    // 5×5 ring: outer 5×5 at value 20, inner 3×3 (1..3,1..3) at 0
    const grid = mkGrid(5, 5, (x, y) => {
      const inHole = x >= 1 && x <= 3 && y >= 1 && y <= 3;
      return inHole ? 0 : 20;
    });
    const out = labelConnectedComponents(grid, 5, 5);
    assert.equal(out.blobs.length, 1);
    const b = out.blobs[0];
    // Ring = 25 - 9 = 16 cells
    assert.equal(b.cells.length, 16);
    // Hole cells are still labeled 0
    assert.equal(out.labels[1 * 5 + 1], 0);
    assert.equal(out.labels[2 * 5 + 2], 0);
    assert.equal(out.labels[3 * 5 + 3], 0);
  });

  test('threshold gating drops sub-threshold cells from the component', () => {
    // 3×3 block where only the centre is above threshold 10
    const grid = mkGrid(8, 8, (x, y) => {
      if (x === 4 && y === 4) return 50;
      if (x >= 3 && x <= 5 && y >= 3 && y <= 5) return 5;
      return 0;
    });
    const sub = labelConnectedComponents(grid, 8, 8, { threshold: 10, minAreaCells: 1 });
    assert.equal(sub.blobs.length, 1);
    assert.equal(sub.blobs[0].cells.length, 1);
    // Lower threshold: whole 3×3 joins
    const wide = labelConnectedComponents(grid, 8, 8, { threshold: 1, minAreaCells: 1 });
    assert.equal(wide.blobs.length, 1);
    assert.equal(wide.blobs[0].cells.length, 9);
  });

  test('minAreaCells filter drops small blobs entirely', () => {
    // Two blobs: one 3×3 (9 cells), one single cell (1 cell)
    const grid = mkGrid(10, 10, (x, y) => {
      if (x >= 0 && x <= 2 && y >= 0 && y <= 2) return 30;
      if (x === 8 && y === 8) return 30;
      return 0;
    });
    // Default minAreaCells=5 → only the 3×3 survives
    const def = labelConnectedComponents(grid, 10, 10);
    assert.equal(def.blobs.length, 1);
    assert.equal(def.blobs[0].cells.length, 9);
    // The lone speckle pixel is unlabeled
    assert.equal(def.labels[8 * 10 + 8], 0);
    // minAreaCells=1 keeps both
    const all = labelConnectedComponents(grid, 10, 10, { minAreaCells: 1 });
    assert.equal(all.blobs.length, 2);
  });

  test('fully rainy grid → one giant blob covering all cells', () => {
    const grid = mkGrid(6, 6, () => 10);
    const out = labelConnectedComponents(grid, 6, 6);
    assert.equal(out.blobs.length, 1);
    assert.equal(out.blobs[0].cells.length, 36);
    assert.deepEqual(out.blobs[0].bbox, { minX: 0, maxX: 5, minY: 0, maxY: 5 });
  });

  test('4-connectivity vs 8-connectivity differ on diagonally-touching blobs', () => {
    // Two 1-cell blobs touching only at the corner (4,4) and (5,5)
    const grid = mkGrid(10, 10, (x, y) => ((x === 4 && y === 4) || (x === 5 && y === 5) ? 30 : 0));
    const c4 = labelConnectedComponents(grid, 10, 10, { connectivity: 4, minAreaCells: 1 });
    const c8 = labelConnectedComponents(grid, 10, 10, { connectivity: 8, minAreaCells: 1 });
    assert.equal(c4.blobs.length, 2, '4-conn separates diagonal-touching');
    assert.equal(c8.blobs.length, 1, '8-conn merges diagonal-touching');
  });

  test('NaN and negative values are skipped (not above threshold)', () => {
    const grid = new Float32Array([NaN, -1, 30, 30, 30, 30, NaN, -2, 30]);
    const out = labelConnectedComponents(grid, 3, 3, { minAreaCells: 1 });
    // Cells 2,3,4,5,8 are above threshold (5 cells, all 8-connected)
    assert.equal(out.blobs.length, 1);
    assert.equal(out.blobs[0].cells.length, 5);
    assert.equal(out.labels[0], 0);
    assert.equal(out.labels[1], 0);
    assert.equal(out.labels[6], 0);
  });

  test('blob IDs are dense, deterministic, and assigned in scan order', () => {
    // Three small blobs, each 5 cells, scattered
    const grid = mkGrid(20, 5, (x, y) => {
      if (y === 0 && x >= 0 && x <= 4) return 30;   // blob A
      if (y === 2 && x >= 8 && x <= 12) return 30;  // blob B
      if (y === 4 && x >= 15 && x <= 19) return 30; // blob C
      return 0;
    });
    const out = labelConnectedComponents(grid, 20, 5);
    assert.equal(out.blobs.length, 3);
    assert.deepEqual(out.blobs.map((b) => b.id), [1, 2, 3]);
    // Top-left blob earns id 1, then mid-row id 2, then bottom-row id 3
    assert.equal(out.labels[0 * 20 + 0], 1);
    assert.equal(out.labels[2 * 20 + 8], 2);
    assert.equal(out.labels[4 * 20 + 15], 3);
  });

  test('peak/mean/sum stats are correct on heterogeneous-intensity blob', () => {
    // 5-cell horizontal blob with values [10, 20, 30, 20, 10]
    const grid = mkGrid(5, 1, (x) => [10, 20, 30, 20, 10][x]);
    const out = labelConnectedComponents(grid, 5, 1, { minAreaCells: 1 });
    assert.equal(out.blobs.length, 1);
    const b = out.blobs[0];
    assert.equal(b.cells.length, 5);
    assert.equal(b.peak, 30);
    assert.equal(b.sum, 90);
    assert.ok(Math.abs(b.mean - 18) < 1e-6);
  });

  test('throws on invalid dimensions', () => {
    assert.throws(() => labelConnectedComponents(new Float32Array(0), 0, 4), /positive integers/);
    assert.throws(() => labelConnectedComponents(new Float32Array(0), 4, 0), /positive integers/);
    assert.throws(() => labelConnectedComponents(new Float32Array(0), 1.5, 4), /positive integers/);
  });

  test('throws on grid length mismatch', () => {
    assert.throws(() => labelConnectedComponents(new Float32Array(5), 2, 2), /grid length/);
    assert.throws(() => labelConnectedComponents(null, 2, 2), /grid length/);
  });

  test('throws on invalid connectivity', () => {
    assert.throws(
      () => labelConnectedComponents(new Float32Array(4), 2, 2, { connectivity: 6 }),
      /connectivity/,
    );
  });

  test('throws on invalid minAreaCells', () => {
    assert.throws(
      () => labelConnectedComponents(new Float32Array(4), 2, 2, { minAreaCells: 0 }),
      /minAreaCells/,
    );
    assert.throws(
      () => labelConnectedComponents(new Float32Array(4), 2, 2, { minAreaCells: 1.5 }),
      /minAreaCells/,
    );
  });

  test('U-shape (two columns joined at the bottom) is one blob via union', () => {
    // 5×5: two vertical bars at x=0 and x=4, joined by row y=4. Verifies
    // the union step (left bar gets a label, right bar gets a different
    // label, then they merge through the bottom row).
    const grid = mkGrid(5, 5, (x, y) => ((x === 0 || x === 4 || y === 4) ? 30 : 0));
    const out = labelConnectedComponents(grid, 5, 5, { connectivity: 4 });
    assert.equal(out.blobs.length, 1);
    // 5 + 5 + 3 (middle of bottom row, x=1..3) = 13 cells
    assert.equal(out.blobs[0].cells.length, 13);
  });
});
