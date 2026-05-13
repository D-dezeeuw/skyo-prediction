import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTopology } from '../public/topology.js';
import {
  SCHEMA,
  TIMELINE_SCHEMA,
  TIERS,
  toGeoJSON,
  fromGeoJSON,
  toGeoJSONTimeline,
} from '../public/topology-geojson.js';

const mkGrid = (w, h, fn) => {
  const g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * w + x] = fn(x, y);
  return g;
};

const sampleTopology = (overrides = {}) => {
  const grid = mkGrid(20, 20, (x, y) => (x >= 5 && x <= 9 && y >= 5 && y <= 9 ? 25 : 0));
  return buildTopology(grid, 20, 20, {}, {
    frame: {
      time: '2026-05-13T14:30:00Z',
      kind: 'observed',
      leadMinutes: 0,
      intervalMinutes: 10,
      tile: { x: 16, y: 10, z: 5 },
      ...overrides,
    },
  });
};

describe('exports', () => {
  test('schemas are versioned and stable', () => {
    assert.equal(SCHEMA, 'skyo.cloud-topology/1');
    assert.equal(TIMELINE_SCHEMA, 'skyo.cloud-topology-timeline/1');
    assert.deepEqual([...TIERS], ['light', 'moderate', 'heavy', 'severe', 'thunderstorm']);
  });
});

describe('toGeoJSON — structure', () => {
  test('returns a valid FeatureCollection with the skyo extension', () => {
    const t = sampleTopology();
    const fc = toGeoJSON(t);
    assert.equal(fc.type, 'FeatureCollection');
    assert.equal(fc.skyo.schema, SCHEMA);
    assert.deepEqual(fc.skyo.tiers, ['light', 'moderate', 'heavy', 'severe', 'thunderstorm']);
    assert.deepEqual(fc.skyo.thresholds.rainMmPerHour, [0.5, 2, 10, 30]);
    assert.deepEqual(fc.skyo.frame.tile, { x: 16, y: 10, z: 5 });
  });

  test('every feature carries cloudId and a recognised kind', () => {
    const t = sampleTopology();
    const fc = toGeoJSON(t);
    assert.ok(fc.features.length > 0);
    const recognised = new Set(['envelope', 'core', 'centroid']);
    for (const f of fc.features) {
      assert.ok(f.properties.cloudId, 'cloudId missing');
      assert.ok(recognised.has(f.properties.kind), `kind=${f.properties.kind}`);
    }
  });

  test('emits one envelope, zero+ cores, and one centroid per cloud', () => {
    const t = sampleTopology();
    const fc = toGeoJSON(t);
    const byCloud = new Map();
    for (const f of fc.features) {
      const cid = f.properties.cloudId;
      if (!byCloud.has(cid)) byCloud.set(cid, { envelope: 0, core: 0, centroid: 0 });
      byCloud.get(cid)[f.properties.kind]++;
    }
    for (const counts of byCloud.values()) {
      assert.ok(counts.envelope >= 1, 'expected at least one envelope');
      assert.equal(counts.centroid, 1, 'expected exactly one centroid');
    }
  });

  test('envelope features carry full driver metadata; cores carry minimal', () => {
    const t = sampleTopology();
    const fc = toGeoJSON(t);
    const env = fc.features.find((f) => f.properties.kind === 'envelope');
    const core = fc.features.find((f) => f.properties.kind === 'core');
    assert.ok(env);
    assert.ok(env.properties.tier);
    assert.ok('score' in env.properties);
    assert.ok('areaKm2' in env.properties);
    assert.ok(env.properties.drivers);
    assert.ok('peakMmPerHour' in env.properties.drivers);
    if (core) {
      assert.ok(core.properties.thresholdMmPerHour > env.properties.thresholdMmPerHour);
      assert.equal('drivers' in core.properties, false, 'core should not carry drivers');
    }
  });

  test('rings are closed (first vertex repeated as last)', () => {
    const t = sampleTopology();
    const fc = toGeoJSON(t);
    for (const f of fc.features) {
      if (f.geometry.type !== 'Polygon') continue;
      const ring = f.geometry.coordinates[0];
      const [fx, fy] = ring[0];
      const [lx, ly] = ring[ring.length - 1];
      assert.equal(fx, lx, 'lng start/end mismatch');
      assert.equal(fy, ly, 'lat start/end mismatch');
    }
  });

  test('empty topology → still a valid FeatureCollection (no features)', () => {
    const grid = new Float32Array(64);
    const t = buildTopology(grid, 8, 8, {}, {
      frame: { tile: { x: 16, y: 10, z: 5 } },
    });
    const fc = toGeoJSON(t);
    assert.equal(fc.type, 'FeatureCollection');
    assert.equal(fc.features.length, 0);
    assert.equal(fc.skyo.schema, SCHEMA);
  });

  test('preserves the frame.kind / leadMinutes (forecast vs observed)', () => {
    const t = sampleTopology({ kind: 'forecast', leadMinutes: 60 });
    const fc = toGeoJSON(t);
    assert.equal(fc.skyo.frame.kind, 'forecast');
    assert.equal(fc.skyo.frame.leadMinutes, 60);
  });
});

describe('toGeoJSON — projection & area', () => {
  test('all polygon vertices land inside the tile bbox', () => {
    const t = sampleTopology();
    const fc = toGeoJSON(t);
    // Tile (16, 10, 5): lon ∈ [0, 11.25], lat ∈ ~[48.9, 55.8]
    for (const f of fc.features) {
      if (f.geometry.type !== 'Polygon') continue;
      for (const [lng, lat] of f.geometry.coordinates[0]) {
        assert.ok(lng >= 0 && lng <= 11.25, `lng ${lng} out of tile`);
        assert.ok(lat > 48 && lat < 56, `lat ${lat} out of tile`);
      }
    }
  });

  test('areaKm2 is positive and on the right order of magnitude', () => {
    const t = sampleTopology();
    const fc = toGeoJSON(t);
    const env = fc.features.find((f) => f.properties.kind === 'envelope');
    // 5×5 cells in a 20×20 grid covering ~11.25° lon (a tile at zoom 5).
    // At lat ~48° N: tile ~ 11.25 * 111.32 * cos(48°) ≈ 836 km wide.
    // 5/19 of that ≈ 220 km on a side → area ~ 48000 km². Use loose bounds.
    assert.ok(env.properties.areaKm2 > 1000, `areaKm2 too small: ${env.properties.areaKm2}`);
    assert.ok(env.properties.areaKm2 < 200000, `areaKm2 too big: ${env.properties.areaKm2}`);
  });
});

describe('toGeoJSON — motion', () => {
  test('centroid feature carries bearingDegrees + speedKmPerHour when motion is set', () => {
    const grid = mkGrid(20, 20, (x, y) => (x >= 5 && x <= 9 && y >= 5 && y <= 9 ? 30 : 0));
    const flow = { width: 5, height: 5, blockSize: 4, data: new Float32Array(50) };
    for (let i = 0; i < 25; i++) { flow.data[i * 2] = 2; flow.data[i * 2 + 1] = 0; }
    const t = buildTopology(grid, 20, 20, { flow }, { frame: { tile: { x: 16, y: 10, z: 5 } } });
    const fc = toGeoJSON(t);
    const c = fc.features.find((f) => f.properties.kind === 'centroid');
    // vx>0, vy=0 → bearing 90° (East)
    assert.ok(Math.abs(c.properties.bearingDegrees - 90) < 1e-6);
    assert.ok(c.properties.speedKmPerHour > 0);
  });

  test('centroid omits motion props when motion is null', () => {
    const t = sampleTopology(); // no flow → motion null
    const fc = toGeoJSON(t);
    const c = fc.features.find((f) => f.properties.kind === 'centroid');
    assert.equal('bearingDegrees' in c.properties, false);
    assert.equal('speedKmPerHour' in c.properties, false);
  });
});

describe('toGeoJSON — input validation', () => {
  test('throws on missing topology, frame, clouds, or thresholds', () => {
    assert.throws(() => toGeoJSON(null), /invalid topology/);
    assert.throws(() => toGeoJSON({}), /invalid topology/);
    assert.throws(() => toGeoJSON({ frame: {}, clouds: [] }), /invalid topology/);
  });

  test('throws on missing or invalid tile', () => {
    const t = sampleTopology();
    t.frame.tile = null;
    assert.throws(() => toGeoJSON(t), /tile/);
  });

  test('throws on missing or invalid grid dims', () => {
    const t = sampleTopology();
    t.frame.grid = null;
    assert.throws(() => toGeoJSON(t), /grid/);
  });
});

describe('fromGeoJSON — round-trip', () => {
  test('toGeoJSON → fromGeoJSON preserves clouds, levels, severity, frame', () => {
    const t = sampleTopology();
    const fc = toGeoJSON(t);
    const back = fromGeoJSON(fc);
    assert.equal(back.clouds.length, t.clouds.length);
    assert.deepEqual(back.thresholds.rainMmPerHour, t.thresholds.rainMmPerHour);
    assert.equal(back.frame.kind, t.frame.kind);
    assert.equal(back.frame.tile.x, t.frame.tile.x);
    for (let i = 0; i < t.clouds.length; i++) {
      assert.equal(back.clouds[i].id, t.clouds[i].id);
      assert.equal(back.clouds[i].severity.tier, t.clouds[i].severity.tier);
      assert.equal(back.clouds[i].levels.length, t.clouds[i].levels.length);
    }
  });

  test('round-trip preserves the closing-vertex behaviour (no duplication)', () => {
    const t = sampleTopology();
    const fc = toGeoJSON(t);
    const back = fromGeoJSON(fc);
    for (const c of back.clouds) {
      for (const lvl of c.levels) {
        for (const poly of lvl.polygons) {
          // After fromGeoJSON the closing vertex has been stripped
          if (poly.length >= 2) {
            const first = poly[0];
            const last = poly[poly.length - 1];
            assert.ok(first[0] !== last[0] || first[1] !== last[1], 'closing vertex should be stripped');
          }
        }
      }
    }
  });

  test('round-trip preserves motion (bearingDegrees + speedKmPerHour)', () => {
    const grid = mkGrid(20, 20, (x, y) => (x >= 5 && x <= 9 && y >= 5 && y <= 9 ? 30 : 0));
    const flow = { width: 5, height: 5, blockSize: 4, data: new Float32Array(50) };
    for (let i = 0; i < 25; i++) { flow.data[i * 2] = 2; flow.data[i * 2 + 1] = 0; }
    const t = buildTopology(grid, 20, 20, { flow }, { frame: { tile: { x: 16, y: 10, z: 5 } } });
    const fc = toGeoJSON(t);
    const back = fromGeoJSON(fc);
    const c = back.clouds[0];
    assert.ok(c.motion, 'expected motion to round-trip');
    assert.ok(Math.abs(c.motion.bearingDegrees - 90) < 1e-6);
    assert.ok(c.motion.speedKmPerHour > 0);
  });

  test('fromGeoJSON tolerates rings that are already non-closed (no closing vertex)', () => {
    const t = sampleTopology();
    const fc = toGeoJSON(t);
    // Strip the closing vertex from one polygon ring and confirm fromGeoJSON
    // still reconstructs it cleanly (the no-op branch in stripClosingVertex)
    const env = fc.features.find((f) => f.geometry.type === 'Polygon');
    env.geometry.coordinates[0].pop();
    const back = fromGeoJSON(fc);
    assert.ok(back.clouds.length > 0);
  });

  test('throws on wrong schema, missing skyo, or non-FeatureCollection', () => {
    assert.throws(() => fromGeoJSON(null), /not a FeatureCollection/);
    assert.throws(() => fromGeoJSON({ type: 'Feature' }), /not a FeatureCollection/);
    assert.throws(() => fromGeoJSON({ type: 'FeatureCollection', features: [] }), /not a FeatureCollection/);
    assert.throws(
      () => fromGeoJSON({ type: 'FeatureCollection', skyo: { schema: 'something/2' }, features: [] }),
      /schema mismatch/,
    );
  });

  test('throws when a feature has no cloudId', () => {
    const t = sampleTopology();
    const fc = toGeoJSON(t);
    fc.features[0].properties.cloudId = null;
    assert.throws(() => fromGeoJSON(fc), /cloudId/);
  });

  test('throws when features is not an array', () => {
    const t = sampleTopology();
    const fc = toGeoJSON(t);
    fc.features = 'nope';
    assert.throws(() => fromGeoJSON(fc), /features/);
  });
});

describe('toGeoJSONTimeline', () => {
  test('emits the timeline schema with one FeatureCollection per topology', () => {
    const a = sampleTopology({ leadMinutes: -10 });
    const b = sampleTopology({ kind: 'forecast', leadMinutes: 30 });
    const out = toGeoJSONTimeline([a, b]);
    assert.equal(out.schema, TIMELINE_SCHEMA);
    assert.equal(out.frames.length, 2);
    for (const fc of out.frames) {
      assert.equal(fc.type, 'FeatureCollection');
      assert.equal(fc.skyo.schema, SCHEMA);
    }
    // Frame.kind / leadMinutes preserved per slot
    assert.equal(out.frames[0].skyo.frame.leadMinutes, -10);
    assert.equal(out.frames[1].skyo.frame.kind, 'forecast');
  });

  test('forwards optional tile + bbox to the wrapper', () => {
    const a = sampleTopology();
    const out = toGeoJSONTimeline([a], {
      tile: { x: 16, y: 10, z: 5 },
      bbox: { north: 50, south: 49, west: 5, east: 6 },
    });
    assert.deepEqual(out.tile, { x: 16, y: 10, z: 5 });
    assert.deepEqual(out.bbox, { north: 50, south: 49, west: 5, east: 6 });
  });

  test('throws on non-array input', () => {
    assert.throws(() => toGeoJSONTimeline('nope'), /array/);
  });

  test('empty array → empty frames list, valid wrapper', () => {
    const out = toGeoJSONTimeline([]);
    assert.equal(out.schema, TIMELINE_SCHEMA);
    assert.deepEqual(out.frames, []);
  });
});
