import { addAsync, appState, bindDOM, computed, defineFn, run, setValue, watch } from 'spektrum';
import { initialState, readyState } from './state.js';
import { fetchManifest, loadHistory } from './radar.js';
import { mountMap, DEFAULT_VIEW } from './map.js';
import { clampIdx, formatFrameTime, nextIdx, FRAME_INTERVAL_MS } from './timeline.js';
import {
  computeFlowPairs,
  medianFilter,
  smoothFlows,
  DEFAULT_SMOOTHING_WINDOW,
  DEFAULT_FLOW_INTENSITY_THRESHOLD,
  DEFAULT_FLOW_CONFIDENCE_THRESHOLD,
} from './flow.js';
import { buildArrows, COLOR_MODES } from './vectors.js';
import { forecast as runForecast } from './advect.js';
import { interpolateHistory, DEFAULT_INTERPOLATION_FACTOR } from './interpolate.js';
import { buildUnifiedFrames, DEFAULT_FRAME_INTERVAL_SEC } from './unify.js';
import { computeTrend, DEFAULT_TREND_WINDOW } from './trend.js';

const RADAR_LAYER_ID = 'radar-history';
const VECTORS_LAYER_ID = 'motion-vectors';
const TREND_LAYER_ID = 'trend';
const HISTORY_FRAME_COUNT = 12;
// 512-px tile (RainViewer's higher-detail variant — 3.4× the PNG file
// size of 256, so real detail not just upscaling) gives us a 512×512
// rain-rate grid that stays crisp when the map zooms in to z+1. Block
// size 16 keeps the flow grid at 32×32 (1024 arrows, same visual
// density as before) and the same total SSD compute as the old setup.
const TILE_SIZE = 512;
const FLOW_BLOCK_SIZE = 16;
const FLOW_SEARCH_RADIUS = 8;
const ARROW_INTENSITY_THRESHOLD = 0.05;
const FORECAST_FRAME_COUNT = 12;
const INTERPOLATION_FACTOR = DEFAULT_INTERPOLATION_FACTOR;
// At INTERPOLATION_FACTOR=4 the playback steps 4× faster than observed
// frames; drop the per-step interval proportionally so wall-clock speed
// stays the same (~ a frame every 160ms instead of 650).
const PLAY_INTERVAL_MS = Math.max(60, Math.floor(FRAME_INTERVAL_MS / INTERPOLATION_FACTOR));

const INITIAL_LAYERS = [
  { id: RADAR_LAYER_ID, name: 'Historical radar', visible: true, opacity: 80 },
  { id: TREND_LAYER_ID, name: 'Growth / decay', visible: false, opacity: 65 },
  { id: VECTORS_LAYER_ID, name: 'Motion vectors', visible: true, opacity: 90 },
];

function applyState(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    setValue(key, value);
  }
}

// ─── 1. Initialise state ────────────────────────────────────────────────
applyState(initialState());
applyState(readyState());
setValue('layers', INITIAL_LAYERS);
setValue('playheadIdx', 0);
setValue('playing', false);
setValue('vectorColorMode', 'speed');

// ─── 2. Async pipelines ────────────────────────────────────────────────
addAsync('radarHistory', async () => {
  const manifest = await fetchManifest();
  const frames = manifest.past.slice(-HISTORY_FRAME_COUNT);
  console.info(`[skyo-prediction] manifest ok; ${frames.length} frames available`);
  return { host: manifest.host, manifest, frames };
});

const refetchGrids = addAsync('radarGrids', async () => {
  const data = appState.radarHistory?.data;
  if (!data) return null;
  /* node:coverage disable */
  const t0 = performance.now();
  const decoded = await loadHistory(data.manifest, HISTORY_FRAME_COUNT);
  console.info(`[skyo-prediction] decoded ${decoded.length} / ${data.frames.length} frames in ${(performance.now() - t0).toFixed(0)} ms`);
  return decoded;
  /* node:coverage enable */
});

// Wrap each pipeline body in logged() so the underlying error stack
// shows up in the console — Spektrum's addAsync stores only the
// stringified message, which is too thin for diagnosis.
function logged(label, fn) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[skyo-prediction] ${label} threw:`, err);
      throw err;
    }
  };
}

const refetchTrend = addAsync('trend', logged('trend', async () => {
  const decoded = appState.radarGrids?.data;
  if (!decoded || decoded.length < 2) return null;
  await Promise.resolve();
  const t0 = performance.now();
  const field = computeTrend(decoded, { window: DEFAULT_TREND_WINDOW });
  return field ? { ...field, computeMs: performance.now() - t0 } : null;
}));

const refetchInterpolated = addAsync('interpolated', logged('interpolated', async () => {
  const decoded = appState.radarGrids?.data;
  const pairs = appState.flowField?.data?.pairs;
  if (!decoded || decoded.length < 2 || !pairs || pairs.length !== decoded.length - 1) return null;
  await Promise.resolve();
  const t0 = performance.now();
  const frames = interpolateHistory(decoded, pairs, INTERPOLATION_FACTOR);
  return {
    frames,
    factor: INTERPOLATION_FACTOR,
    computeMs: performance.now() - t0,
  };
}));

const refetchForecast = addAsync('forecast', logged('forecast', async () => {
  const flow = appState.flowField?.data?.smoothed;
  const decoded = appState.radarGrids?.data;
  if (!flow || !decoded || decoded.length === 0) return null;
  const last = decoded[decoded.length - 1];
  // Phase-2: apply the per-pixel growth/decay trend during forecast
  // advection. Skill is good for ~30–60 min lead time; we damp the
  // trend so far-out forecasts don't blow up: at FORECAST_FRAME_COUNT
  // steps, trendStrength = 0.5 means the final frame's growth is half
  // what a constant-rate extrapolation would say.
  const trend = appState.trend?.data ?? null;
  await Promise.resolve();
  const t0 = performance.now();
  const frames = runForecast(last.grid, flow, FORECAST_FRAME_COUNT, last.width, last.height, {
    trend,
    trendStrength: 0.5,
  });
  return {
    frames,
    width: last.width,
    height: last.height,
    startTime: last.time,
    computeMs: performance.now() - t0,
  };
}));

const refetchFlow = addAsync('flowField', logged('flowField', async () => {
  const decoded = appState.radarGrids?.data;
  if (!decoded || decoded.length < 2) return null;
  await Promise.resolve();
  const t0 = performance.now();
  const flowOpts = {
    blockSize: FLOW_BLOCK_SIZE,
    searchRadius: FLOW_SEARCH_RADIUS,
    intensityThreshold: DEFAULT_FLOW_INTENSITY_THRESHOLD,
    confidenceThreshold: DEFAULT_FLOW_CONFIDENCE_THRESHOLD,
  };
  const rawPairs = computeFlowPairs(decoded, flowOpts);
  const pairs = rawPairs.map(medianFilter);
  const smoothed = smoothFlows(pairs.slice(-DEFAULT_SMOOTHING_WINDOW));
  return { pairs, smoothed, computeMs: performance.now() - t0 };
}));

// ─── 3. Computed selectors ─────────────────────────────────────────────
computed('playIcon', ['playing'], (s) => (s.playing ? '⏸' : '▶'));

// Unified frame array: interpolated history (observed + sub-frames) +
// forecast frames, in chronological order. The scrubber and the map
// renderer iterate this single list; the .kind tag distinguishes
// observed vs interpolated vs forecast for the UI.
computed('unifiedFrames', ['interpolated.data', 'forecast.data', 'flowField.data'], (s) =>
  buildUnifiedFrames(
    s.interpolated?.data,
    s.forecast?.data,
    {
      frameIntervalSec: DEFAULT_FRAME_INTERVAL_SEC,
      pairsLength: s.flowField?.data?.pairs?.length ?? 0,
    },
  ),
);

computed('frameCount', ['unifiedFrames'], (s) => s.unifiedFrames?.length ?? 0);

computed('currentFrameTime', ['unifiedFrames', 'playheadIdx'], (s) => {
  const frames = s.unifiedFrames;
  if (!frames || frames.length === 0) return '';
  const idx = clampIdx(s.playheadIdx, frames.length);
  return formatFrameTime(frames[idx].time);
});

computed('currentFrameKind', ['unifiedFrames', 'playheadIdx'], (s) => {
  const frames = s.unifiedFrames;
  if (!frames || frames.length === 0) return '';
  const idx = clampIdx(s.playheadIdx, frames.length);
  return frames[idx].kind; // 'observed' | 'interpolated' | 'forecast'
});

computed('observedFrameCount', ['radarGrids.data'], (s) => s.radarGrids?.data?.length ?? 0);

// Spektrum's addAsync stores `error` as the stringified message
// (`err?.message || String(err)`), NOT an Error object — so reading
// `.message` off it produces "undefined". Use the string directly.
computed('flowStatus', ['flowField'], (s) => {
  const f = s.flowField;
  if (!f) return 'idle';
  if (f.loading) return 'computing';
  if (f.error) return `error: ${f.error}`;
  if (f.data) {
    const { smoothed, pairs, computeMs } = f.data;
    return `ready: ${smoothed.width}×${smoothed.height} field, ${pairs.length} pairs in ${computeMs.toFixed(0)} ms`;
  }
  return 'idle';
});

computed('gridStatus', ['radarGrids'], (s) => {
  const g = s.radarGrids;
  if (!g) return 'idle';
  if (g.loading) return 'decoding';
  if (g.error) return `error: ${g.error}`;
  if (g.data) return `${g.data.length} grids`;
  return 'idle';
});

computed('forecastStatus', ['forecast'], (s) => {
  const f = s.forecast;
  if (!f) return 'idle';
  if (f.loading) return 'advecting';
  if (f.error) return `error: ${f.error}`;
  if (f.data) return `${f.data.frames.length} frames in ${f.data.computeMs.toFixed(0)} ms`;
  return 'idle';
});

computed('interpStatus', ['interpolated'], (s) => {
  const i = s.interpolated;
  if (!i) return 'idle';
  if (i.loading) return 'computing';
  if (i.error) return `error: ${i.error}`;
  if (i.data) return `${i.data.frames.length} frames (×${i.data.factor})`;
  return 'idle';
});

computed('trendStatus', ['trend'], (s) => {
  const t = s.trend;
  if (!t) return 'idle';
  if (t.loading) return 'computing';
  if (t.error) return `error: ${t.error}`;
  if (t.data) return `${t.data.width}×${t.data.height} over ${t.data.window} frames`;
  return 'idle';
});

// ─── 4. Map handle (lazy) + bridge between state and Leaflet ───────────
/* node:coverage disable */
let mapHandle = null;
let autoSeekDone = false;
let lastRenderedTime = NaN;

function applyLayerToMap(layer) {
  if (!mapHandle || !layer) return;
  const opacity = (layer.opacity ?? 0) / 100;
  if (layer.id === RADAR_LAYER_ID) {
    mapHandle.setVisible(layer.visible);
    mapHandle.setOpacity(opacity);
  } else if (layer.id === VECTORS_LAYER_ID) {
    mapHandle.setVectorsVisible(layer.visible);
    mapHandle.setVectorsOpacity(opacity);
  } else if (layer.id === TREND_LAYER_ID) {
    mapHandle.setTrendVisible(layer.visible);
    mapHandle.setTrendOpacity(opacity);
  }
}

function renderCurrentFrame() {
  if (!mapHandle) return;
  const frames = appState.unifiedFrames;
  if (!frames || frames.length === 0) return;
  const idx = clampIdx(appState.playheadIdx, frames.length);
  const f = frames[idx];
  // Use time as the dedupe key — same time = same frame, skip re-encode.
  if (f.time === lastRenderedTime) return;
  mapHandle.renderFrame(f.grid, f.width, f.height, f.time);
  lastRenderedTime = f.time;
}

mountMap(document.getElementById('map'), {
  view: DEFAULT_VIEW,
  frameOptions: { x: 16, y: 10, zoom: 5, size: TILE_SIZE },
}).then((handle) => {
  mapHandle = handle;
  console.info('[skyo-prediction] map mounted');
  for (const layer of appState.layers ?? []) applyLayerToMap(layer);
  renderCurrentFrame();
}).catch((err) => {
  console.error('[skyo-prediction] map mount failed:', err);
});
/* node:coverage enable */

// ─── 5. Watchers ───────────────────────────────────────────────────────
watch(['radarHistory.data'], () => {
  const frames = appState.radarHistory?.data?.frames;
  if (!frames || frames.length === 0) return;
  /* node:coverage disable */
  refetchGrids();
  /* node:coverage enable */
});

watch(['radarGrids.data'], () => {
  /* node:coverage disable */
  if ((appState.radarGrids?.data?.length ?? 0) >= 2) {
    refetchFlow();
    refetchTrend();
  }
  /* node:coverage enable */
});

// Re-run forecast + interpolation when flow OR trend updates, so the
// forecast picks up growth/decay once trend is ready.
watch(['flowField.data', 'trend.data'], () => {
  /* node:coverage disable */
  if (appState.flowField?.data?.smoothed) refetchForecast();
  if (appState.flowField?.data?.pairs) refetchInterpolated();
  /* node:coverage enable */
});

// Once unified frames materialise for the first time, seek the playhead
// to the latest observed frame (the boundary between past and forecast).
watch(['unifiedFrames'], () => {
  /* node:coverage disable */
  const frames = appState.unifiedFrames;
  if (!frames || frames.length === 0) return;
  if (!autoSeekDone) {
    let lastObservedIdx = 0;
    for (let i = frames.length - 1; i >= 0; i--) {
      if (frames[i].kind === 'observed') { lastObservedIdx = i; break; }
    }
    setValue('playheadIdx', lastObservedIdx);
    autoSeekDone = true;
  }
  renderCurrentFrame();
  /* node:coverage enable */
});

watch(['playheadIdx'], () => {
  /* node:coverage disable */
  renderCurrentFrame();
  /* node:coverage enable */
});

watch(['layers'], () => {
  /* node:coverage disable */
  if (!mapHandle) return;
  for (const layer of appState.layers ?? []) applyLayerToMap(layer);
  /* node:coverage enable */
});

watch(['trend.data'], () => {
  /* node:coverage disable */
  if (!mapHandle) return;
  const t = appState.trend?.data;
  if (!t) return;
  // Use window+timestamp as the dedupe key so we re-render exactly when
  // the trend recomputes, not on every layer toggle.
  mapHandle.renderTrend(t.grid, t.width, t.height, `${t.window}:${t.computeMs}`);
  /* node:coverage enable */
});

watch(['flowField.data', 'unifiedFrames', 'playheadIdx', 'vectorColorMode'], () => {
  /* node:coverage disable */
  if (!mapHandle) return;
  const data = appState.flowField?.data;
  const frames = appState.unifiedFrames;
  if (!data || !frames || frames.length === 0) {
    mapHandle.setVectors([]);
    return;
  }
  const idx = clampIdx(appState.playheadIdx, frames.length);
  const f = frames[idx];
  const flow = data.pairs?.[f.pairIdx] ?? data.smoothed;
  if (!flow) {
    mapHandle.setVectors([]);
    return;
  }
  const arrows = buildArrows(flow, {
    tileSize: TILE_SIZE,
    colorMode: appState.vectorColorMode,
    radarGrid: f.grid ?? null,
    radarWidth: f.width ?? 0,
    intensityThreshold: ARROW_INTENSITY_THRESHOLD,
  });
  mapHandle.setVectors(arrows);
  /* node:coverage enable */
});

let playInterval = 0;
watch(['playing'], () => {
  if (appState.playing && !playInterval) {
    playInterval = setInterval(() => {
      const frames = appState.unifiedFrames;
      if (!frames || frames.length === 0) return;
      setValue('playheadIdx', nextIdx(appState.playheadIdx ?? 0, frames.length));
    }, PLAY_INTERVAL_MS);
  } else if (!appState.playing && playInterval) {
    clearInterval(playInterval);
    playInterval = 0;
  }
});

// ─── 6. UI handlers ────────────────────────────────────────────────────
defineFn('togglePlay', () => setValue('playing', !appState.playing));

defineFn('seekPlayhead', (el) => {
  const v = Number(el.value);
  setValue('playing', false);
  setValue('playheadIdx', Number.isFinite(v) ? Math.floor(v) : 0);
});

defineFn('setColorMode', (el) => {
  const mode = el.value;
  if (COLOR_MODES.includes(mode)) setValue('vectorColorMode', mode);
});

if (typeof window !== 'undefined') {
  window.appState = appState;
}

// ─── 7. Bind DOM ───────────────────────────────────────────────────────
bindDOM(document.getElementById('app'));

// ─── 8. Start the rAF tick pump ────────────────────────────────────────
run();
