/**
 * RainViewer ingestion. Pure helpers for manifest parsing, frame selection,
 * and tile-URL construction; browser-side fetchManifest / loadFrame wrappers
 * use the platform fetch + Image APIs.
 *
 * The manifest shape we parse comes from
 *   https://api.rainviewer.com/public/weather-maps.json
 * which returns { version, host, radar: { past: [{time, path}], nowcast: [...] } }.
 */

import { decodeRgbaToRainRate } from './palette.js';

export const RAINVIEWER_MANIFEST_URL =
  'https://api.rainviewer.com/public/weather-maps.json';

const DEFAULT_FRAME_OPTIONS = Object.freeze({
  size: 256,
  zoom: 5,
  x: 16,
  y: 10,
  colorScheme: 2,
  smooth: 1,
  snow: 0,
});

export function parseManifest(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new Error('parseManifest: manifest must be an object');
  }
  if (typeof raw.host !== 'string' || raw.host.length === 0) {
    throw new Error('parseManifest: manifest.host missing');
  }
  const radar = raw.radar ?? {};
  return {
    host: raw.host,
    version: raw.version ?? null,
    generated: typeof raw.generated === 'number' ? raw.generated : null,
    past: normalizeFrames(radar.past),
    nowcast: normalizeFrames(radar.nowcast),
  };
}

function normalizeFrames(frames) {
  if (!Array.isArray(frames)) return [];
  return frames
    .filter((f) => f && typeof f.time === 'number' && typeof f.path === 'string')
    .map((f) => ({ time: f.time, path: f.path }))
    .sort((a, b) => a.time - b.time);
}

export function selectRecentFrames(manifest, count) {
  if (!manifest || !Array.isArray(manifest.past)) return [];
  if (!Number.isInteger(count) || count <= 0) return [];
  return manifest.past.slice(-count);
}

export function buildFrameUrl(host, frame, options = {}) {
  if (typeof host !== 'string' || host.length === 0) {
    throw new Error('buildFrameUrl: host required');
  }
  if (!frame || typeof frame.path !== 'string') {
    throw new Error('buildFrameUrl: frame.path required');
  }
  const opts = { ...DEFAULT_FRAME_OPTIONS, ...options };
  const { size, zoom, x, y, colorScheme, smooth, snow } = opts;
  return `${host}${frame.path}/${size}/${zoom}/${x}/${y}/${colorScheme}/${smooth}_${snow}.png`;
}

/**
 * Produce a Leaflet-compatible tile URL template containing {z}/{x}/{y}
 * placeholders. Lets a single tileLayer cover any zoom and pan, instead
 * of being pinned to one tile coordinate.
 */
export function buildTileUrlTemplate(host, frame, options = {}) {
  if (typeof host !== 'string' || host.length === 0) {
    throw new Error('buildTileUrlTemplate: host required');
  }
  if (!frame || typeof frame.path !== 'string') {
    throw new Error('buildTileUrlTemplate: frame.path required');
  }
  const { size = DEFAULT_FRAME_OPTIONS.size, colorScheme = DEFAULT_FRAME_OPTIONS.colorScheme, smooth = DEFAULT_FRAME_OPTIONS.smooth, snow = DEFAULT_FRAME_OPTIONS.snow } = options;
  return `${host}${frame.path}/${size}/{z}/{x}/{y}/${colorScheme}/${smooth}_${snow}.png`;
}

export async function fetchManifest({ fetchImpl = globalThis.fetch, url = RAINVIEWER_MANIFEST_URL } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchManifest: no fetch implementation available');
  }
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`fetchManifest: HTTP ${res.status} ${res.statusText}`);
  }
  const json = await res.json();
  return parseManifest(json);
}

/* node:coverage disable */
function makeCanvas(size) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

/**
 * Browser-only: fetch a tile PNG, decode via canvas, return a rain-rate grid.
 * Untestable from Node without bringing in jsdom/canvas (forbidden by the
 * zero-deps rule). Verified through manual browser smoke each story.
 */
export async function loadFrame(url, { size = 256 } = {}) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  const loaded = new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`loadFrame: failed to load ${url}`));
  });
  img.src = url;
  await loaded;

  const canvas = makeCanvas(size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);
  return {
    width: size,
    height: size,
    grid: decodeRgbaToRainRate(data, size, size),
  };
}

/**
 * Decode up to `count` recent frames. Failures are logged but don't reject
 * the whole batch — callers downstream of decode (flow, advect) gate on
 * `decoded.length >= 2` and so degrade gracefully.
 */
export async function loadHistory(manifest, count = 12, frameOptions) {
  const frames = selectRecentFrames(manifest, count);
  const settled = await Promise.allSettled(
    frames.map(async (frame) => ({
      time: frame.time,
      ...(await loadFrame(buildFrameUrl(manifest.host, frame, frameOptions), {
        size: frameOptions?.size ?? DEFAULT_FRAME_OPTIONS.size,
      })),
    })),
  );
  const decoded = [];
  for (let i = 0; i < settled.length; i++) {
    if (settled[i].status === 'fulfilled') {
      decoded.push(settled[i].value);
    } else {
      console.warn(`[skyo-prediction] decode failed for frame ${i}:`, settled[i].reason);
    }
  }
  return decoded;
}
/* node:coverage enable */
