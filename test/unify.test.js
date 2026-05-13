import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FRAME_INTERVAL_SEC, buildUnifiedFrames } from '../public/unify.js';

const F = (overrides = {}) => ({
  time: 0,
  grid: new Float32Array(4),
  width: 2,
  height: 2,
  observed: true,
  ...overrides,
});

describe('DEFAULT_FRAME_INTERVAL_SEC', () => {
  test('matches RainViewer cadence (10 minutes)', () => {
    assert.equal(DEFAULT_FRAME_INTERVAL_SEC, 600);
  });
});

describe('buildUnifiedFrames', () => {
  test('returns [] for empty inputs', () => {
    assert.deepEqual(buildUnifiedFrames(null, null), []);
    assert.deepEqual(buildUnifiedFrames({ frames: [], factor: 1 }, null), []);
  });

  test('tags interpolated entries by their observed flag', () => {
    const interp = {
      frames: [
        F({ time: 0, observed: true }),
        F({ time: 150, observed: false }),
        F({ time: 300, observed: false }),
        F({ time: 450, observed: false }),
        F({ time: 600, observed: true }),
      ],
      factor: 4,
    };
    const out = buildUnifiedFrames(interp, null, { pairsLength: 1 });
    assert.equal(out.length, 5);
    assert.deepEqual(out.map((f) => f.kind), [
      'observed', 'interpolated', 'interpolated', 'interpolated', 'observed',
    ]);
  });

  test('appends forecast frames with kind = "forecast"', () => {
    const interp = {
      frames: [F({ time: 0 }), F({ time: 600 })],
      factor: 1,
    };
    const forecast = {
      frames: [new Float32Array(4), new Float32Array(4), new Float32Array(4)],
      width: 2,
      height: 2,
      startTime: 600,
    };
    const out = buildUnifiedFrames(interp, forecast, { pairsLength: 1 });
    assert.equal(out.length, 5);
    assert.deepEqual(out.slice(2).map((f) => f.kind), ['forecast', 'forecast', 'forecast']);
  });

  test('forecast timestamps step by frameIntervalSec from startTime', () => {
    const forecast = {
      frames: [new Float32Array(4), new Float32Array(4), new Float32Array(4)],
      width: 2, height: 2,
      startTime: 1000,
    };
    const out = buildUnifiedFrames(null, forecast, { frameIntervalSec: 60 });
    assert.equal(out[0].time, 1060);
    assert.equal(out[1].time, 1120);
    assert.equal(out[2].time, 1180);
  });

  test('forecast falls back to last interpolated time when startTime missing', () => {
    const interp = { frames: [F({ time: 0 }), F({ time: 600 })], factor: 1 };
    const forecast = {
      frames: [new Float32Array(4)],
      width: 2, height: 2,
      // startTime intentionally missing
    };
    const out = buildUnifiedFrames(interp, forecast, { frameIntervalSec: 60 });
    assert.equal(out[2].time, 660);
  });

  test('pairIdx for interpolated frames steps by 1 every `factor` indices', () => {
    const interp = {
      // 3 observed × factor 4 → 9 entries
      frames: [
        F({ time: 0, observed: true }),
        F({ time: 150, observed: false }),
        F({ time: 300, observed: false }),
        F({ time: 450, observed: false }),
        F({ time: 600, observed: true }),
        F({ time: 750, observed: false }),
        F({ time: 900, observed: false }),
        F({ time: 1050, observed: false }),
        F({ time: 1200, observed: true }),
      ],
      factor: 4,
    };
    const out = buildUnifiedFrames(interp, null, { pairsLength: 2 });
    // Indices 0..3 → pair 0, 4..7 → pair 1, 8 → pair 2 (clamped to lastPair=1)
    const expected = [0, 0, 0, 0, 1, 1, 1, 1, 1];
    assert.deepEqual(out.map((f) => f.pairIdx), expected);
  });

  test('pairIdx is clamped to pairs.length - 1 (never out of range)', () => {
    const interp = {
      frames: [F({ time: 0 }), F({ time: 600 })],
      factor: 1,
    };
    const out = buildUnifiedFrames(interp, null, { pairsLength: 1 });
    for (const f of out) assert.ok(f.pairIdx >= 0 && f.pairIdx <= 0);
  });

  test('forecast frames share the last pair index', () => {
    const interp = { frames: [F()], factor: 1 };
    const forecast = {
      frames: [new Float32Array(4), new Float32Array(4)],
      width: 2, height: 2,
      startTime: 0,
    };
    const out = buildUnifiedFrames(interp, forecast, { pairsLength: 5 });
    // pairsLength = 5 → lastPair = 4
    assert.equal(out[1].pairIdx, 4);
    assert.equal(out[2].pairIdx, 4);
  });

  test('handles missing pairsLength (clamps to 0)', () => {
    const interp = { frames: [F()], factor: 1 };
    const out = buildUnifiedFrames(interp, null);
    assert.equal(out[0].pairIdx, 0);
  });

  test('forecastSlots reserves N future slots even with no forecast.data', () => {
    const interp = { frames: [F({ time: 0, observed: true })], factor: 1 };
    const out = buildUnifiedFrames(interp, null, { forecastSlots: 3, frameIntervalSec: 600 });
    // 1 observed + 3 reserved forecast slots
    assert.equal(out.length, 4);
    assert.equal(out[1].kind, 'forecast');
    assert.equal(out[1].grid, null);
    assert.equal(out[1].time, 600);
    assert.equal(out[2].time, 1200);
    assert.equal(out[3].time, 1800);
  });

  test('forecastSlots gets populated by forecast.frames when available', () => {
    const interp = { frames: [F({ time: 0 })], factor: 1 };
    const forecast = {
      frames: [new Float32Array(4), new Float32Array(4)],
      width: 2, height: 2, startTime: 0,
    };
    const out = buildUnifiedFrames(interp, forecast, { forecastSlots: 4, frameIntervalSec: 60 });
    // 1 observed + 4 forecast slots; first 2 have grids, last 2 are null
    assert.equal(out.length, 5);
    assert.ok(out[1].grid instanceof Float32Array);
    assert.ok(out[2].grid instanceof Float32Array);
    assert.equal(out[3].grid, null);
    assert.equal(out[4].grid, null);
  });

  test('forecastSlots = 0 (default) keeps legacy behaviour', () => {
    const interp = { frames: [F()], factor: 1 };
    const out = buildUnifiedFrames(interp, null);
    assert.equal(out.length, 1);
  });

  test('available forecast frames beyond forecastSlots are still included', () => {
    const interp = { frames: [F({ time: 0 })], factor: 1 };
    const forecast = {
      frames: [new Float32Array(4), new Float32Array(4), new Float32Array(4)],
      width: 2, height: 2, startTime: 0,
    };
    const out = buildUnifiedFrames(interp, forecast, { forecastSlots: 1, frameIntervalSec: 60 });
    // Should include all 3 forecast frames despite forecastSlots = 1
    assert.equal(out.length, 4);
  });
});
