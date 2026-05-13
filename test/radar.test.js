import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  RAINVIEWER_MANIFEST_URL,
  parseManifest,
  selectRecentFrames,
  buildFrameUrl,
  buildTileUrlTemplate,
  fetchManifest,
} from '../public/radar.js';

const SAMPLE_MANIFEST = {
  version: '2.0',
  generated: 1620000000,
  host: 'https://tilecache.rainviewer.com',
  radar: {
    past: [
      { time: 1619993400, path: '/v2/radar/1619993400' },
      { time: 1619994000, path: '/v2/radar/1619994000' },
      { time: 1619994600, path: '/v2/radar/1619994600' },
    ],
    nowcast: [
      { time: 1620000600, path: '/v2/radar/nowcast_1620000600' },
    ],
  },
};

describe('RAINVIEWER_MANIFEST_URL', () => {
  test('points at the public weather-maps endpoint', () => {
    assert.equal(RAINVIEWER_MANIFEST_URL, 'https://api.rainviewer.com/public/weather-maps.json');
  });
});

describe('parseManifest', () => {
  test('parses a well-formed manifest', () => {
    const m = parseManifest(SAMPLE_MANIFEST);
    assert.equal(m.host, 'https://tilecache.rainviewer.com');
    assert.equal(m.version, '2.0');
    assert.equal(m.generated, 1620000000);
    assert.equal(m.past.length, 3);
    assert.equal(m.nowcast.length, 1);
  });

  test('sorts past frames ascending by time', () => {
    const shuffled = {
      ...SAMPLE_MANIFEST,
      radar: {
        ...SAMPLE_MANIFEST.radar,
        past: [
          SAMPLE_MANIFEST.radar.past[2],
          SAMPLE_MANIFEST.radar.past[0],
          SAMPLE_MANIFEST.radar.past[1],
        ],
      },
    };
    const m = parseManifest(shuffled);
    assert.deepEqual(m.past.map((f) => f.time), [1619993400, 1619994000, 1619994600]);
  });

  test('drops malformed frame entries', () => {
    const noisy = {
      ...SAMPLE_MANIFEST,
      radar: {
        past: [
          { time: 1619993400, path: '/ok' },
          { time: 'not-a-number', path: '/bad' },
          { path: '/missing-time' },
          null,
          { time: 1619994600, path: '/ok2' },
        ],
        nowcast: [],
      },
    };
    const m = parseManifest(noisy);
    assert.equal(m.past.length, 2);
    assert.deepEqual(m.past.map((f) => f.path), ['/ok', '/ok2']);
  });

  test('coerces missing nowcast / past arrays to empty arrays', () => {
    const sparse = { host: 'https://x', radar: {} };
    const m = parseManifest(sparse);
    assert.deepEqual(m.past, []);
    assert.deepEqual(m.nowcast, []);
  });

  test('handles missing radar key entirely', () => {
    const m = parseManifest({ host: 'https://x' });
    assert.deepEqual(m.past, []);
    assert.deepEqual(m.nowcast, []);
  });

  test('throws on null / non-object input', () => {
    assert.throws(() => parseManifest(null), /must be an object/);
    assert.throws(() => parseManifest('not-an-object'), /must be an object/);
  });

  test('throws when host is missing or empty', () => {
    assert.throws(() => parseManifest({}), /host missing/);
    assert.throws(() => parseManifest({ host: '' }), /host missing/);
    assert.throws(() => parseManifest({ host: 42 }), /host missing/);
  });

  test('preserves null version/generated when absent', () => {
    const m = parseManifest({ host: 'https://x' });
    assert.equal(m.version, null);
    assert.equal(m.generated, null);
  });
});

describe('selectRecentFrames', () => {
  test('returns the last N frames in chronological order', () => {
    const m = parseManifest(SAMPLE_MANIFEST);
    const sel = selectRecentFrames(m, 2);
    assert.equal(sel.length, 2);
    assert.equal(sel[0].time, 1619994000);
    assert.equal(sel[1].time, 1619994600);
  });

  test('returns all frames when count exceeds available', () => {
    const m = parseManifest(SAMPLE_MANIFEST);
    assert.equal(selectRecentFrames(m, 100).length, 3);
  });

  test('returns [] for invalid count', () => {
    const m = parseManifest(SAMPLE_MANIFEST);
    assert.deepEqual(selectRecentFrames(m, 0), []);
    assert.deepEqual(selectRecentFrames(m, -3), []);
    assert.deepEqual(selectRecentFrames(m, 1.5), []);
    assert.deepEqual(selectRecentFrames(m, 'two'), []);
  });

  test('returns [] when manifest is missing or malformed', () => {
    assert.deepEqual(selectRecentFrames(null, 5), []);
    assert.deepEqual(selectRecentFrames({}, 5), []);
    assert.deepEqual(selectRecentFrames({ past: 'nope' }, 5), []);
  });
});

describe('buildFrameUrl', () => {
  const host = 'https://tilecache.rainviewer.com';
  const frame = { path: '/v2/radar/1619994600' };

  test('builds the canonical RainViewer tile URL with defaults', () => {
    const url = buildFrameUrl(host, frame);
    assert.equal(url, `${host}/v2/radar/1619994600/512/5/16/10/2/1_0.png`);
  });

  test('respects overridden options', () => {
    const url = buildFrameUrl(host, frame, {
      size: 512,
      zoom: 6,
      x: 33,
      y: 21,
      colorScheme: 4,
      smooth: 0,
      snow: 1,
    });
    assert.equal(url, `${host}/v2/radar/1619994600/512/6/33/21/4/0_1.png`);
  });

  test('partial option overrides preserve other defaults', () => {
    const url = buildFrameUrl(host, frame, { zoom: 7 });
    assert.equal(url, `${host}/v2/radar/1619994600/512/7/16/10/2/1_0.png`);
  });

  test('throws on missing host', () => {
    assert.throws(() => buildFrameUrl('', frame), /host required/);
    assert.throws(() => buildFrameUrl(undefined, frame), /host required/);
  });

  test('throws on missing frame.path', () => {
    assert.throws(() => buildFrameUrl(host, {}), /frame\.path required/);
    assert.throws(() => buildFrameUrl(host, null), /frame\.path required/);
  });
});

describe('buildTileUrlTemplate', () => {
  const host = 'https://tilecache.rainviewer.com';
  const frame = { path: '/v2/radar/1619994600' };

  test('produces a Leaflet-compatible {z}/{x}/{y} template with defaults', () => {
    const tpl = buildTileUrlTemplate(host, frame);
    assert.equal(tpl, `${host}/v2/radar/1619994600/512/{z}/{x}/{y}/2/1_0.png`);
  });

  test('respects size, colorScheme, smooth, snow overrides', () => {
    const tpl = buildTileUrlTemplate(host, frame, {
      size: 512,
      colorScheme: 4,
      smooth: 0,
      snow: 1,
    });
    assert.equal(tpl, `${host}/v2/radar/1619994600/512/{z}/{x}/{y}/4/0_1.png`);
  });

  test('throws on missing host', () => {
    assert.throws(() => buildTileUrlTemplate('', frame), /host required/);
  });

  test('throws on missing frame.path', () => {
    assert.throws(() => buildTileUrlTemplate(host, null), /frame\.path required/);
    assert.throws(() => buildTileUrlTemplate(host, {}), /frame\.path required/);
  });
});

describe('fetchManifest', () => {
  function stubFetch({ ok = true, status = 200, statusText = 'OK', body }) {
    return async (url) => ({
      ok,
      status,
      statusText,
      url,
      async json() {
        return body;
      },
    });
  }

  test('returns a parsed manifest on 200 OK', async () => {
    const m = await fetchManifest({ fetchImpl: stubFetch({ body: SAMPLE_MANIFEST }) });
    assert.equal(m.host, 'https://tilecache.rainviewer.com');
    assert.equal(m.past.length, 3);
  });

  test('passes the configured URL to the fetch implementation', async () => {
    let seenUrl = null;
    const fetchImpl = async (url) => {
      seenUrl = url;
      return { ok: true, async json() { return SAMPLE_MANIFEST; } };
    };
    await fetchManifest({ fetchImpl, url: 'https://example.test/manifest.json' });
    assert.equal(seenUrl, 'https://example.test/manifest.json');
  });

  test('defaults to RAINVIEWER_MANIFEST_URL when url is omitted', async () => {
    let seenUrl = null;
    const fetchImpl = async (url) => {
      seenUrl = url;
      return { ok: true, async json() { return SAMPLE_MANIFEST; } };
    };
    await fetchManifest({ fetchImpl });
    assert.equal(seenUrl, RAINVIEWER_MANIFEST_URL);
  });

  test('rejects on HTTP error response', async () => {
    await assert.rejects(
      fetchManifest({
        fetchImpl: stubFetch({ ok: false, status: 503, statusText: 'Service Unavailable' }),
      }),
      /HTTP 503 Service Unavailable/,
    );
  });

  test('throws when no fetch implementation is available', async () => {
    await assert.rejects(
      fetchManifest({ fetchImpl: null }),
      /no fetch implementation/,
    );
  });
});
