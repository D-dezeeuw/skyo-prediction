import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTopology } from '../public/topology.js';
import {
  DEFAULT_TILE_SIZE,
  DEFAULT_LABEL_TIER_THRESHOLD,
  RENDER_MODES,
  COLOR_MODES,
  TIER_PALETTE,
  buildTopologyRenderItems,
} from '../public/topology-render.js';

const mkGrid = (w, h, fn) => {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = fn(x, y);
  return g;
};

const samplePeak = (peak) => {
  const grid = mkGrid(20, 20, (x, y) => (x >= 5 && x <= 9 && y >= 5 && y <= 9 ? peak : 0));
  return buildTopology(grid, 20, 20, {}, { frame: { tile: { x: 16, y: 10, z: 5 } } });
};

describe('exports', () => {
  test('defaults', () => {
    assert.equal(DEFAULT_TILE_SIZE, 256);
    assert.equal(DEFAULT_LABEL_TIER_THRESHOLD, 'heavy');
  });

  test('palette covers every tier', () => {
    for (const tier of ['light', 'moderate', 'heavy', 'severe', 'thunderstorm']) {
      assert.ok(TIER_PALETTE[tier], `missing palette for ${tier}`);
    }
  });

  test('render and color mode enums', () => {
    assert.deepEqual([...RENDER_MODES], ['fill', 'line', 'fill+line']);
    assert.deepEqual([...COLOR_MODES], ['tier', 'mono']);
  });

  test('thunderstorm palette is dashed; others are not', () => {
    assert.equal(TIER_PALETTE.thunderstorm.dashed, true);
    for (const tier of ['light', 'moderate', 'heavy', 'severe']) {
      assert.equal(TIER_PALETTE[tier].dashed, false);
    }
  });
});

describe('buildTopologyRenderItems', () => {
  test('empty topology → empty list', () => {
    const grid = new Float32Array(64);
    const t = buildTopology(grid, 8, 8, {}, { frame: { tile: { x: 16, y: 10, z: 5 } } });
    assert.deepEqual(buildTopologyRenderItems(t), []);
  });

  test('null / malformed topology → empty list', () => {
    assert.deepEqual(buildTopologyRenderItems(null), []);
    assert.deepEqual(buildTopologyRenderItems({ clouds: [] }), []);
    assert.deepEqual(buildTopologyRenderItems({ clouds: [], frame: { grid: { width: 1, height: 1 } } }), []);
  });

  test('emits one polygon per cloud level polygon, with the right kind', () => {
    const t = samplePeak(25); // heavy — levels at 0.5, 2, 10
    const items = buildTopologyRenderItems(t);
    const polygons = items.filter((i) => i.type === 'polygon');
    // 3 levels × 1 polygon each = 3 polygons
    assert.equal(polygons.length, 3);
    const envelopes = polygons.filter((p) => p.kind === 'envelope');
    const cores = polygons.filter((p) => p.kind === 'core');
    assert.equal(envelopes.length, 1);
    assert.equal(cores.length, 2);
  });

  test('envelope items carry fill; cores have fill="none"', () => {
    const t = samplePeak(25);
    const items = buildTopologyRenderItems(t);
    const env = items.find((i) => i.kind === 'envelope');
    const core = items.find((i) => i.kind === 'core');
    assert.ok(env.fill && env.fill !== 'none', `envelope fill: ${env.fill}`);
    assert.ok(env.fillOpacity > 0);
    assert.equal(core.fill, 'none');
    assert.equal(core.fillOpacity, 0);
  });

  test('tier drives the colour palette', () => {
    const heavy = buildTopologyRenderItems(samplePeak(25));
    const severe = buildTopologyRenderItems(samplePeak(50));
    const heavyEnv = heavy.find((i) => i.kind === 'envelope');
    const severeEnv = severe.find((i) => i.kind === 'envelope');
    assert.equal(heavyEnv.stroke, TIER_PALETTE.heavy.stroke);
    assert.equal(severeEnv.stroke, TIER_PALETTE.severe.stroke);
  });

  test('polygon "d" attributes are valid SVG path strings', () => {
    const t = samplePeak(25);
    const items = buildTopologyRenderItems(t);
    for (const item of items) {
      if (item.type !== 'polygon') continue;
      assert.match(item.d, /^M [\d.-]+ [\d.-]+ /);
      assert.match(item.d, / Z$/);
    }
  });

  test('coordinates are projected from grid-px to tile-px space', () => {
    const t = samplePeak(25);
    const items = buildTopologyRenderItems(t, { tileSize: 512 });
    // 20×20 grid, tileSize 512 → scale = 512 / 19 ≈ 26.94
    // The hot block spans grid-px ~4.5..9.5, so tile-px coords should be
    // roughly 4.5*26.94 ≈ 121 .. 9.5*26.94 ≈ 256
    const env = items.find((i) => i.kind === 'envelope');
    const nums = env.d.match(/-?\d+\.?\d*/g).map(Number);
    const minCoord = Math.min(...nums);
    const maxCoord = Math.max(...nums);
    assert.ok(minCoord > 50 && minCoord < 200, `minCoord=${minCoord}`);
    assert.ok(maxCoord > 200 && maxCoord < 350, `maxCoord=${maxCoord}`);
  });

  test('labels are off by default (showLabels=false)', () => {
    const heavy = buildTopologyRenderItems(samplePeak(25));
    const labels = heavy.filter((i) => i.type === 'label');
    assert.equal(labels.length, 0);
  });

  test('showLabels=true emits a label for tiers ≥ heavy', () => {
    const heavy = buildTopologyRenderItems(samplePeak(25), { showLabels: true });
    const labels = heavy.filter((i) => i.type === 'label');
    assert.equal(labels.length, 1);
    assert.equal(labels[0].text, 'HEAVY');
  });

  test('showLabels=true does not emit a label for tiers < heavy', () => {
    const moderate = buildTopologyRenderItems(samplePeak(5), { showLabels: true });
    const labels = moderate.filter((i) => i.type === 'label');
    assert.equal(labels.length, 0);
  });

  test('showLabels=false suppresses labels even for severe', () => {
    const items = buildTopologyRenderItems(samplePeak(50), { showLabels: false });
    const labels = items.filter((i) => i.type === 'label');
    assert.equal(labels.length, 0);
  });

  test('labelTierMin can be lowered to include moderate', () => {
    const items = buildTopologyRenderItems(samplePeak(5), {
      showLabels: true,
      labelTierMin: 'moderate',
    });
    const labels = items.filter((i) => i.type === 'label');
    assert.equal(labels.length, 1);
    assert.equal(labels[0].text, 'MODERATE');
  });

  test('label coordinates are projected to tile-px', () => {
    const t = samplePeak(25);
    const items = buildTopologyRenderItems(t, { tileSize: 512, showLabels: true });
    const label = items.find((i) => i.type === 'label');
    // Centroid at grid (7, 7) → tile (7 * 512/19, 7 * 512/19) ≈ (188.6, 188.6)
    assert.ok(Math.abs(label.x - 188.6) < 1, `label.x=${label.x}`);
    assert.ok(Math.abs(label.y - 188.6) < 1, `label.y=${label.y}`);
  });

  test('renderMode "line" → no fill on any polygon', () => {
    const items = buildTopologyRenderItems(samplePeak(25), { renderMode: 'line' });
    const polys = items.filter((i) => i.type === 'polygon');
    for (const p of polys) {
      assert.equal(p.fill, 'none', `${p.kind} has fill ${p.fill}`);
    }
  });

  test('renderMode "fill" → no stroke (strokeWidth 0) on any polygon', () => {
    const items = buildTopologyRenderItems(samplePeak(25), { renderMode: 'fill' });
    const polys = items.filter((i) => i.type === 'polygon');
    for (const p of polys) {
      assert.equal(p.strokeWidth, 0);
      assert.equal(p.stroke, 'none');
    }
  });

  test('renderMode "fill+line" (default) → envelope has both, cores have line only', () => {
    const items = buildTopologyRenderItems(samplePeak(25));
    const env = items.find((i) => i.kind === 'envelope');
    const core = items.find((i) => i.kind === 'core');
    assert.ok(env.fill && env.fill !== 'none');
    assert.ok(env.strokeWidth > 0);
    assert.equal(core.fill, 'none');
    assert.ok(core.strokeWidth > 0);
  });

  test('unknown renderMode falls back to fill+line', () => {
    const items = buildTopologyRenderItems(samplePeak(25), { renderMode: 'rainbow' });
    const env = items.find((i) => i.kind === 'envelope');
    assert.ok(env.fill && env.fill !== 'none');
  });

  test('colorMode "mono" → all polygons render white, opacity scales with score', () => {
    const lo = buildTopologyRenderItems(samplePeak(5),  { colorMode: 'mono' });
    const hi = buildTopologyRenderItems(samplePeak(50), { colorMode: 'mono' });
    const loEnv = lo.find((i) => i.kind === 'envelope');
    const hiEnv = hi.find((i) => i.kind === 'envelope');
    // Both white
    assert.match(loEnv.fill, /hsl\(0,\s*0%,\s*100%\)/);
    assert.match(hiEnv.fill, /hsl\(0,\s*0%,\s*100%\)/);
    // Higher severity → higher fill opacity
    assert.ok(hiEnv.fillOpacity > loEnv.fillOpacity);
    // And higher stroke opacity
    assert.ok(hiEnv.strokeOpacity > loEnv.strokeOpacity);
  });

  test('unknown colorMode falls back to tier', () => {
    const items = buildTopologyRenderItems(samplePeak(25), { colorMode: 'plaid' });
    const env = items.find((i) => i.kind === 'envelope');
    assert.equal(env.stroke, TIER_PALETTE.heavy.stroke);
  });

  test('simplifyTolerance > 0 reduces polygon vertex count', () => {
    // A bigger blob → more vertices in the envelope. With aggressive
    // simplification the count drops noticeably.
    const grid = new Float32Array(40 * 40);
    for (let y = 8; y <= 31; y++) for (let x = 8; x <= 31; x++) grid[y * 40 + x] = 25;
    const t = buildTopology(grid, 40, 40, {}, { frame: { tile: { x: 16, y: 10, z: 5 } } });
    const full = buildTopologyRenderItems(t, { tileSize: 512, simplifyTolerance: 0 });
    const simp = buildTopologyRenderItems(t, { tileSize: 512, simplifyTolerance: 8 });
    const fullEnv = full.find((i) => i.kind === 'envelope');
    const simpEnv = simp.find((i) => i.kind === 'envelope');
    const countL = (d) => (d.match(/L /g) || []).length;
    assert.ok(countL(simpEnv.d) < countL(fullEnv.d), `simplified ${countL(simpEnv.d)} >= full ${countL(fullEnv.d)}`);
  });

  test('simplifyTolerance is a no-op when polygon already has ≤ 3 vertices', () => {
    const t = {
      frame: { grid: { width: 10, height: 10 } },
      thresholds: { rainMmPerHour: [0.5] },
      clouds: [{
        id: 'c001',
        severity: { tier: 'light', score: 0.1, drivers: {} },
        centroid: [5, 5],
        levels: [{ thresholdMmPerHour: 0.5, polygons: [[[1, 1], [3, 1], [3, 3]]] }],
      }],
    };
    const items = buildTopologyRenderItems(t, { simplifyTolerance: 100 });
    const env = items.find((i) => i.kind === 'envelope');
    // Path still has its 3 segments — simplification skipped tiny polygons
    const countL = (env.d.match(/L /g) || []).length;
    assert.ok(countL >= 2, `expected at least 2 L segments, got ${countL}`);
  });

  test('falls back gracefully when cloud has unknown tier', () => {
    // Hand-craft a topology with a tier the palette doesn't know about
    const t = {
      frame: { grid: { width: 10, height: 10 } },
      thresholds: { rainMmPerHour: [0.5, 2] },
      clouds: [{
        id: 'c001',
        severity: { tier: 'unknown', score: 0.5, drivers: {} },
        centroid: [5, 5],
        levels: [{ thresholdMmPerHour: 0.5, polygons: [[[1, 1], [3, 1], [3, 3], [1, 3]]] }],
      }],
    };
    const items = buildTopologyRenderItems(t);
    const env = items.find((i) => i.kind === 'envelope');
    // Falls back to the light palette
    assert.equal(env.stroke, TIER_PALETTE.light.stroke);
  });

  test('skips polygons with fewer than 3 vertices', () => {
    const t = {
      frame: { grid: { width: 10, height: 10 } },
      thresholds: { rainMmPerHour: [0.5] },
      clouds: [{
        id: 'c001',
        severity: { tier: 'light', score: 0.1, drivers: {} },
        centroid: [5, 5],
        levels: [{
          thresholdMmPerHour: 0.5,
          polygons: [[[1, 1]], [[1, 1], [2, 2]], 'not an array', [[3, 3], [4, 3], [4, 4]]],
        }],
      }],
    };
    const items = buildTopologyRenderItems(t);
    const polys = items.filter((i) => i.type === 'polygon');
    assert.equal(polys.length, 1);
  });

  test('omits label when cloud has no centroid even at high tier', () => {
    const t = {
      frame: { grid: { width: 10, height: 10 } },
      thresholds: { rainMmPerHour: [0.5] },
      clouds: [{
        id: 'c001',
        severity: { tier: 'severe', score: 0.9, drivers: {} },
        centroid: null,
        levels: [{ thresholdMmPerHour: 0.5, polygons: [[[1, 1], [3, 1], [3, 3], [1, 3]]] }],
      }],
    };
    const items = buildTopologyRenderItems(t);
    const labels = items.filter((i) => i.type === 'label');
    assert.equal(labels.length, 0);
  });

  test('thunderstorm cloud produces dashed envelope', () => {
    const grid = mkGrid(20, 20, (x, y) => (x >= 5 && x <= 9 && y >= 5 && y <= 9 ? 50 : 0));
    const cape = { width: 20, height: 20, grid: new Float32Array(400).fill(1500) };
    const conv = { width: 20, height: 20, grid: new Float32Array(400) };
    for (let y = 6; y <= 8; y++) for (let x = 6; x <= 8; x++) conv.grid[y * 20 + x] = 1;
    const tscore = { width: 20, height: 20, grid: new Float32Array(400) };
    for (let y = 6; y <= 8; y++) for (let x = 6; x <= 8; x++) tscore.grid[y * 20 + x] = 0.7;
    const t = buildTopology(grid, 20, 20, { cape, convective: conv, thunderscore: tscore }, {
      frame: { tile: { x: 16, y: 10, z: 5 } },
    });
    const items = buildTopologyRenderItems(t);
    const env = items.find((i) => i.kind === 'envelope');
    assert.equal(env.dashed, true);
    assert.equal(env.tier, 'thunderstorm');
  });
});
