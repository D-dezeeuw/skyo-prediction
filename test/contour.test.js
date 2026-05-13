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
