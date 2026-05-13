import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildTopology } from '../public/topology.js';
import { SCHEMA, TIMELINE_SCHEMA, fromGeoJSON } from '../public/topology-geojson.js';
import {
  MIME_TYPE,
  TIMELINE_MIME_TYPE,
  formatFrameFilename,
  formatTimelineFilename,
  prepareTopologyExport,
  prepareTopologyTimelineExport,
} from '../public/topology-export.js';

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
  test('mime types are correct', () => {
    assert.equal(MIME_TYPE, 'application/geo+json');
    assert.equal(TIMELINE_MIME_TYPE, 'application/json');
  });
});

describe('formatFrameFilename', () => {
  test('uses frame.time and includes the .geojson extension', () => {
    const f = formatFrameFilename('2026-05-13T14:30:00Z');
    assert.match(f, /^skyo-topology-/);
    assert.match(f, /\.geojson$/);
    // Colons are filesystem-hostile; should be replaced
    assert.equal(f.includes(':'), false);
  });

  test('forecast frames get a "forecast-" tag in the filename', () => {
    const f = formatFrameFilename('2026-05-13T14:30:00Z', 'forecast');
    assert.match(f, /forecast-/);
  });

  test('interpolated frames get an "interp-" tag', () => {
    const f = formatFrameFilename('2026-05-13T14:30:00Z', 'interpolated');
    assert.match(f, /interp-/);
  });

  test('observed frames have no kind tag', () => {
    const f = formatFrameFilename('2026-05-13T14:30:00Z', 'observed');
    assert.equal(/forecast-|interp-/.test(f), false);
  });

  test('falls back to the current time when frameTime is missing', () => {
    const f = formatFrameFilename(undefined);
    assert.match(f, /^skyo-topology-/);
    assert.match(f, /\.geojson$/);
  });
});

describe('formatTimelineFilename', () => {
  test('uses generatedAt and includes the .json extension', () => {
    const f = formatTimelineFilename('2026-05-13T14:30:12Z');
    assert.match(f, /^skyo-topology-timeline-/);
    assert.match(f, /\.json$/);
    assert.equal(f.includes(':'), false);
  });
});

describe('prepareTopologyExport', () => {
  test('emits parseable JSON that validates as the topology schema', () => {
    const t = sampleTopology();
    const out = prepareTopologyExport(t);
    assert.equal(out.mimeType, MIME_TYPE);
    const parsed = JSON.parse(out.content);
    assert.equal(parsed.type, 'FeatureCollection');
    assert.equal(parsed.skyo.schema, SCHEMA);
  });

  test('round-trips losslessly through fromGeoJSON', () => {
    const t = sampleTopology();
    const out = prepareTopologyExport(t);
    const fc = JSON.parse(out.content);
    const back = fromGeoJSON(fc);
    assert.equal(back.clouds.length, t.clouds.length);
    assert.equal(back.frame.tile.x, t.frame.tile.x);
  });

  test('content is pretty-printed (multi-line, 2-space indent)', () => {
    const t = sampleTopology();
    const out = prepareTopologyExport(t);
    assert.ok(out.content.includes('\n  '), 'expected indented JSON');
  });

  test('filename derives from frame.time', () => {
    const t = sampleTopology();
    const out = prepareTopologyExport(t);
    assert.match(out.filename, /^skyo-topology-/);
    assert.match(out.filename, /\.geojson$/);
  });

  test('throws on missing topology / missing frame', () => {
    assert.throws(() => prepareTopologyExport(null), /topology/);
    assert.throws(() => prepareTopologyExport({}), /topology/);
  });
});

describe('prepareTopologyTimelineExport', () => {
  test('emits parseable JSON validating as the timeline schema with one frame per topology', () => {
    const a = sampleTopology({ leadMinutes: -10 });
    const b = sampleTopology({ kind: 'forecast', leadMinutes: 60, time: '2026-05-13T15:30:00Z' });
    const out = prepareTopologyTimelineExport([a, b]);
    assert.equal(out.mimeType, TIMELINE_MIME_TYPE);
    const parsed = JSON.parse(out.content);
    assert.equal(parsed.schema, TIMELINE_SCHEMA);
    assert.equal(parsed.frames.length, 2);
    for (const fc of parsed.frames) {
      assert.equal(fc.type, 'FeatureCollection');
      assert.equal(fc.skyo.schema, SCHEMA);
    }
  });

  test('uses the supplied generatedAt timestamp in the filename', () => {
    const out = prepareTopologyTimelineExport([], { generatedAt: '2026-05-13T15:00:00Z' });
    assert.match(out.filename, /2026-05-13T15-00-00Z/);
  });

  test('empty array produces a valid wrapper with empty frames', () => {
    const out = prepareTopologyTimelineExport([]);
    const parsed = JSON.parse(out.content);
    assert.deepEqual(parsed.frames, []);
  });

  test('throws on non-array input', () => {
    assert.throws(() => prepareTopologyTimelineExport('nope'), /array/);
  });
});
