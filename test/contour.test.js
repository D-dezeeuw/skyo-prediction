import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SIMPLIFY_TOLERANCE,
  marchingSquares,
  simplifyPolygon,
  tracePolygonsForLevels,
  polygonToLatLng,
} from '../public/contour.js';

const mkGrid = (w, h, fn) => {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = fn(x, y);
  return g;
};

const polygonPerimeter = (pts) => {
  let p = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    p += Math.hypot(x2 - x1, y2 - y1);
  }
  return p;
};

const polygonBBox = (pts) => {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
};

describe('exports', () => {
  test('default simplify tolerance is 0.5 cells', () => {
    assert.equal(DEFAULT_SIMPLIFY_TOLERANCE, 0.5);
  });
});

describe('marchingSquares', () => {
  test('threshold below all values → no polygons', () => {
    const grid = mkGrid(6, 6, () => 5);
    assert.deepEqual(marchingSquares(grid, 6, 6, 100), []);
  });

  test('threshold above all values → no polygons', () => {
    const grid = mkGrid(6, 6, () => 5);
    assert.deepEqual(marchingSquares(grid, 6, 6, 0), []);
  });

  test('a single rectangular blob produces one closed polygon enclosing it', () => {
    // 3×3 hot block at (3..5, 3..5) with value 50; everything else 0
    const grid = mkGrid(10, 10, (x, y) => (x >= 3 && x <= 5 && y >= 3 && y <= 5 ? 50 : 0));
    const polys = marchingSquares(grid, 10, 10, 25);
    assert.equal(polys.length, 1);
    const poly = polys[0];
    // Closed contour ≈ 8 cell-edge segments around the block; with the
    // duplicate seam vertex stripped we expect ~8 vertices
    assert.ok(poly.length >= 6 && poly.length <= 12, `got ${poly.length} vertices`);
    // Contour should enclose the block (bbox roughly 2.5..5.5 in each axis)
    const bb = polygonBBox(poly);
    assert.ok(bb.minX < 3, `minX=${bb.minX}`);
    assert.ok(bb.maxX > 5, `maxX=${bb.maxX}`);
    assert.ok(bb.minY < 3, `minY=${bb.minY}`);
    assert.ok(bb.maxY > 5, `maxY=${bb.maxY}`);
  });

  test('two disjoint blobs produce two polygons', () => {
    const grid = mkGrid(20, 20, (x, y) => {
      if (x >= 2 && x <= 4 && y >= 2 && y <= 4) return 50;
      if (x >= 14 && x <= 16 && y >= 14 && y <= 16) return 50;
      return 0;
    });
    const polys = marchingSquares(grid, 20, 20, 25);
    assert.equal(polys.length, 2);
  });

  test('threshold lands exactly on a corner value (degenerate edge) — does not crash', () => {
    const grid = mkGrid(6, 6, (x, y) => (x === 3 && y === 3 ? 25 : 0));
    // threshold 25 → only corner (3,3) is above; cells around it all hit
    // some non-trivial case but with a degenerate (a===b) lerp on edges
    // where both corners are 0. The function should still return a valid
    // (possibly tiny) closed polygon and not throw or NaN.
    const polys = marchingSquares(grid, 6, 6, 25);
    assert.ok(polys.length >= 1);
    for (const p of polys) {
      for (const [x, y] of p) {
        assert.ok(Number.isFinite(x) && Number.isFinite(y));
      }
    }
  });

  test('saddle case 5 (diagonal corners above) emits two distinct segments per cell', () => {
    // 2×2 corner-only grid: TL=0, TR=50, BR=0, BL=50. Cell (0,0) is the
    // entire grid → caseIdx = BL(1) + BR(0) + TR(4) + TL(0) = 5 → saddle.
    const grid = new Float32Array([0, 50, 50, 0]);
    const polys = marchingSquares(grid, 2, 2, 25);
    // Two segments → two polygons (since both end at boundaries that
    // don't connect).
    assert.equal(polys.length, 2);
  });

  test('saddle case 10 (other diagonal) also emits two segments', () => {
    // TL=50, TR=0, BR=50, BL=0 → caseIdx = 0 + 2 + 0 + 8 = 10 → saddle.
    const grid = new Float32Array([50, 0, 0, 50]);
    const polys = marchingSquares(grid, 2, 2, 25);
    assert.equal(polys.length, 2);
  });

  test('a larger blob produces a longer perimeter', () => {
    const small = mkGrid(20, 20, (x, y) => (x >= 8 && x <= 11 && y >= 8 && y <= 11 ? 50 : 0));
    const large = mkGrid(20, 20, (x, y) => (x >= 4 && x <= 15 && y >= 4 && y <= 15 ? 50 : 0));
    const sPolys = marchingSquares(small, 20, 20, 25);
    const lPolys = marchingSquares(large, 20, 20, 25);
    assert.ok(polygonPerimeter(lPolys[0]) > polygonPerimeter(sPolys[0]));
  });

  test('throws on invalid dimensions', () => {
    assert.throws(() => marchingSquares(new Float32Array(2), 1, 2, 0.5), />= 2/);
    assert.throws(() => marchingSquares(new Float32Array(2), 2, 1, 0.5), />= 2/);
    assert.throws(() => marchingSquares(new Float32Array(4), 2.5, 2, 0.5), />= 2/);
  });

  test('throws on grid length mismatch', () => {
    assert.throws(() => marchingSquares(new Float32Array(5), 2, 2, 0.5), /grid length/);
    assert.throws(() => marchingSquares(null, 2, 2, 0.5), /grid length/);
  });

  test('throws on non-finite threshold', () => {
    assert.throws(() => marchingSquares(new Float32Array(4), 2, 2, NaN), /threshold/);
    assert.throws(() => marchingSquares(new Float32Array(4), 2, 2, Infinity), /threshold/);
  });

  test('bbox option restricts the scan but produces the same polygon for an isolated blob', () => {
    // 50×50 grid with a single 5×5 hot block at (20..24, 20..24)
    const grid = mkGrid(50, 50, (x, y) => (x >= 20 && x <= 24 && y >= 20 && y <= 24 ? 50 : 0));
    const full = marchingSquares(grid, 50, 50, 25);
    const limited = marchingSquares(grid, 50, 50, 25, {
      bbox: { minX: 20, maxX: 24, minY: 20, maxY: 24 },
    });
    assert.equal(full.length, limited.length);
    // Same vertex count after the +1 padding picks up the contour around the block
    assert.equal(full[0].length, limited[0].length);
  });

  test('mask + maskValue zero out cells whose label != target (no leakage from other blobs)', () => {
    // Two side-by-side 3×3 blobs at value 50, separated by 2 cells of zero.
    // Without masking, both contours are returned. With mask targeting blob-1
    // only, only that blob's contour comes back.
    const grid = mkGrid(15, 5, (x, y) => {
      if (x >= 1 && x <= 3 && y >= 1 && y <= 3) return 50;
      if (x >= 8 && x <= 10 && y >= 1 && y <= 3) return 50;
      return 0;
    });
    // Hand-craft a labels array: blob 1 on the left, blob 2 on the right
    const labels = new Int32Array(15 * 5);
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) labels[y * 15 + x] = 1;
    for (let y = 1; y <= 3; y++) for (let x = 8; x <= 10; x++) labels[y * 15 + x] = 2;

    const both = marchingSquares(grid, 15, 5, 25);
    assert.equal(both.length, 2);

    const onlyOne = marchingSquares(grid, 15, 5, 25, {
      mask: labels, maskValue: 1,
    });
    assert.equal(onlyOne.length, 1);
    // The remaining polygon is the left blob: all x ≤ 3.5
    const maxX = Math.max(...onlyOne[0].map((p) => p[0]));
    assert.ok(maxX <= 4, `expected left-blob only, maxX=${maxX}`);
  });

  test('bbox + mask combine — only scans the blob region AND masks neighbours', () => {
    // Two overlapping-bbox blobs: one big square + one tiny dot inside its bbox.
    // Without mask we'd see both. With mask we see only the targeted one even
    // though bbox includes the other's pixels.
    const grid = mkGrid(20, 20, (x, y) => {
      if (x >= 2 && x <= 12 && y >= 2 && y <= 12) return 50;  // big square (blob 1)
      if (x === 8 && y === 8) return 0;                        // hole — different blob (irrelevant for this test)
      return 0;
    });
    // Different fake "blob": a single cell at (15, 15) marked label 2
    grid[15 * 20 + 15] = 50;
    const labels = new Int32Array(20 * 20);
    for (let y = 2; y <= 12; y++) for (let x = 2; x <= 12; x++) labels[y * 20 + x] = 1;
    labels[15 * 20 + 15] = 2;

    // Targeting blob 1 only, with bbox covering the whole grid — must still
    // skip the (15, 15) cell because mask says it's blob 2.
    const out = marchingSquares(grid, 20, 20, 25, {
      bbox: { minX: 0, maxX: 19, minY: 0, maxY: 19 },
      mask: labels, maskValue: 1,
    });
    assert.equal(out.length, 1);
    const maxX = Math.max(...out[0].map((p) => p[0]));
    const maxY = Math.max(...out[0].map((p) => p[1]));
    assert.ok(maxX < 14, `polygon should not reach the blob-2 cell at x=15, got maxX=${maxX}`);
    assert.ok(maxY < 14);
  });

  test('bbox without mask still works (just bounds the scan)', () => {
    // Big grid, single small blob. Scan with a tight bbox — must find it.
    const grid = mkGrid(100, 100, (x, y) => (x >= 10 && x <= 14 && y >= 10 && y <= 14 ? 50 : 0));
    const polys = marchingSquares(grid, 100, 100, 25, {
      bbox: { minX: 10, maxX: 14, minY: 10, maxY: 14 },
    });
    assert.equal(polys.length, 1);
  });
});

describe('simplifyPolygon', () => {
  test('fewer than 3 points → returned as-is (deep-copied)', () => {
    const a = [[0, 0]];
    const out = simplifyPolygon(a);
    assert.deepEqual(out, [[0, 0]]);
    assert.notEqual(out[0], a[0]);
    const b = [[0, 0], [1, 1]];
    assert.deepEqual(simplifyPolygon(b), [[0, 0], [1, 1]]);
  });

  test('a perfectly straight polyline collapses to its endpoints', () => {
    const line = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0]];
    const out = simplifyPolygon(line, 0.01);
    assert.deepEqual(out, [[0, 0], [5, 0]]);
  });

  test('preserves a vertex that deviates more than tolerance', () => {
    // L-shape: (0,0) → (5,0) → (5,5) — the corner at (5,0) must survive
    const poly = [[0, 0], [5, 0], [5, 5]];
    const out = simplifyPolygon(poly, 0.5);
    assert.equal(out.length, 3);
  });

  test('drops a vertex that deviates less than tolerance', () => {
    // (0,0) → (1, 0.1) → (2, 0): the bump is 0.1, well under tolerance 1
    const poly = [[0, 0], [1, 0.1], [2, 0]];
    const out = simplifyPolygon(poly, 1);
    assert.deepEqual(out, [[0, 0], [2, 0]]);
  });

  test('tolerance 0 keeps every vertex with any deviation', () => {
    const poly = [[0, 0], [1, 0.001], [2, 0]];
    const out = simplifyPolygon(poly, 0);
    assert.equal(out.length, 3);
  });

  test('handles a degenerate polyline where start == end (zero-length base)', () => {
    const poly = [[5, 5], [6, 5], [5, 5]];
    const out = simplifyPolygon(poly, 0.5);
    // The bump at (6,5) is 1.0 from the base point — survives
    assert.equal(out.length, 3);
  });

  test('throws on bad inputs', () => {
    assert.throws(() => simplifyPolygon('not an array'), /array/);
    assert.throws(() => simplifyPolygon([[0, 0], [1, 1]], -1), /tolerance/);
    assert.throws(() => simplifyPolygon([[0, 0], [1, 1]], NaN), /tolerance/);
  });
});

describe('tracePolygonsForLevels', () => {
  test('returns one entry per level, in input order', () => {
    const grid = mkGrid(10, 10, (x, y) => (x >= 3 && x <= 6 && y >= 3 && y <= 6 ? 50 : 0));
    const out = tracePolygonsForLevels(grid, 10, 10, [10, 25, 40]);
    assert.equal(out.length, 3);
    assert.deepEqual(out.map((e) => e.threshold), [10, 25, 40]);
    for (const entry of out) assert.ok(Array.isArray(entry.polygons));
  });

  test('empty levels → empty result', () => {
    const grid = mkGrid(10, 10, () => 50);
    assert.deepEqual(tracePolygonsForLevels(grid, 10, 10, []), []);
  });

  test('throws on non-array levels', () => {
    assert.throws(() => tracePolygonsForLevels(new Float32Array(4), 2, 2, 5), /array/);
  });

  test('higher-threshold contours sit inside lower-threshold ones (nested)', () => {
    // Concentric: outer ring 30, inner core 80
    const grid = mkGrid(20, 20, (x, y) => {
      const dx = x - 10; const dy = y - 10;
      const r = Math.hypot(dx, dy);
      if (r < 3) return 80;
      if (r < 7) return 30;
      return 0;
    });
    const [low, high] = tracePolygonsForLevels(grid, 20, 20, [15, 50]);
    const lowBB = polygonBBox(low.polygons[0]);
    const highBB = polygonBBox(high.polygons[0]);
    // High-threshold polygon is strictly inside low-threshold polygon
    assert.ok(highBB.minX > lowBB.minX, `nested minX: ${highBB.minX} > ${lowBB.minX}`);
    assert.ok(highBB.maxX < lowBB.maxX);
    assert.ok(highBB.minY > lowBB.minY);
    assert.ok(highBB.maxY < lowBB.maxY);
  });
});

describe('polygonToLatLng', () => {
  const tile = { x: 16, y: 10, z: 5 }; // NL-area tile (already used in vectors.js tests)

  test('grid-pixel (0, 0) maps to the tile top-left corner', () => {
    const out = polygonToLatLng([[0, 0]], tile, 10, 10);
    // Tile (16,10,5): lonLeft = 16/32 * 360 - 180 = 0; latTop = atan(sinh(π * (1 - 20/32))) * 180/π
    const expectedLatTop = Math.atan(Math.sinh(Math.PI * (1 - 20 / 32))) * (180 / Math.PI);
    assert.ok(Math.abs(out[0][0] - 0) < 1e-9, `lng: ${out[0][0]}`);
    assert.ok(Math.abs(out[0][1] - expectedLatTop) < 1e-9, `lat: ${out[0][1]}`);
  });

  test('grid-pixel (W-1, H-1) maps to the tile bottom-right corner', () => {
    const out = polygonToLatLng([[9, 9]], tile, 10, 10);
    // lonRight = 17/32 * 360 - 180 = 11.25
    assert.ok(Math.abs(out[0][0] - 11.25) < 1e-9);
    const expectedLatBot = Math.atan(Math.sinh(Math.PI * (1 - 22 / 32))) * (180 / Math.PI);
    assert.ok(Math.abs(out[0][1] - expectedLatBot) < 1e-9);
  });

  test('output length matches input length and order is preserved', () => {
    const out = polygonToLatLng([[0, 0], [9, 0], [9, 9], [0, 9]], tile, 10, 10);
    assert.equal(out.length, 4);
    // Going around the tile, lng monotonically increases on the top edge
    assert.ok(out[1][0] > out[0][0]);
  });

  test('throws on invalid polygon, tile, or grid dims', () => {
    assert.throws(() => polygonToLatLng('nope', tile, 10, 10), /polygon/);
    assert.throws(() => polygonToLatLng([], { x: 1.5, y: 0, z: 0 }, 10, 10), /tile/);
    assert.throws(() => polygonToLatLng([], tile, 1, 10), />= 2/);
    assert.throws(() => polygonToLatLng([], tile, 10, 1), />= 2/);
  });
});
