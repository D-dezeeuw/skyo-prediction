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

const RADAR_LAYER_ID = 'radar-history';
const VECTORS_LAYER_ID = 'motion-vectors';
const HISTORY_FRAME_COUNT = 12;
const TILE_SIZE = 256;
// Smaller blocks → denser vector field. 8-px blocks on a 256-px tile
// give a 32×32 grid (1024 arrows) instead of the previous 16×16 (256).
// Same total SSD work because per-block cost shrinks at the same rate.
const FLOW_BLOCK_SIZE = 8;
const FLOW_SEARCH_RADIUS = 8;
// Hide arrows over rain-free blocks (mm/h). Block-matching on flat zero
// returns arbitrary zero motion vectors; rendering them as arrows just
// adds visual noise. 0.05 mm/h ≈ "trace precipitation" in radar lingo.
const ARROW_INTENSITY_THRESHOLD = 0.05;
// 12 forecast frames at 10-minute intervals = 2 hours of nowcast.
const FORECAST_FRAME_COUNT = 12;

// Layers are plain state objects so the template's data-model can write
// directly to `appState.layers[i].visible` / `.opacity` — no registry
// indirection, no derived snapshots, no path-rewrite gymnastics.
// Opacity is stored as an integer 0–100 to match the range slider's
// native value; we divide by 100 only when applying to the map.
const INITIAL_LAYERS = [
  { id: RADAR_LAYER_ID, name: 'Historical radar', visible: true, opacity: 80 },
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

const refetchForecast = addAsync('forecast', async () => {
  const flow = appState.flowField?.data?.smoothed;
  const decoded = appState.radarGrids?.data;
  if (!flow || !decoded || decoded.length === 0) return null;
  const last = decoded[decoded.length - 1];
  await Promise.resolve();
  const t0 = performance.now();
  const frames = runForecast(last.grid, flow, FORECAST_FRAME_COUNT, last.width, last.height);
  return {
    frames,
    width: last.width,
    height: last.height,
    startTime: last.time,
    computeMs: performance.now() - t0,
  };
});

const refetchFlow = addAsync('flowField', async () => {
  const decoded = appState.radarGrids?.data;
  if (!decoded || decoded.length < 2) return null;
  await Promise.resolve();
  const t0 = performance.now();
  // Three layered noise filters per Story 5.5:
  //   1. intensityThreshold drops blocks with no signal in either frame
  //      (prevents the bestMatch lottery on flat-zero areas)
  //   2. confidenceThreshold drops matches whose SSD/energy is too high
  //      (the "best" candidate was still a poor fit — coincidence, not
  //       correspondence)
  //   3. medianFilter on each pair (in flowFromHistory) replaces outlier
  //      vectors with the median of their 3×3 neighbourhood — kills
  //      stray "false motion" arrows that disagree with all neighbours
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
});

// ─── 3. Computed selectors ─────────────────────────────────────────────
computed('playIcon', ['playing'], (s) => (s.playing ? '⏸' : '▶'));

computed('frameCount', ['radarHistory.data'], (s) =>
  s.radarHistory?.data?.frames ? s.radarHistory.data.frames.length : 0,
);

computed('currentFrameTime', ['radarHistory.data', 'playheadIdx'], (s) => {
  const frames = s.radarHistory?.data?.frames;
  if (!frames || frames.length === 0) return '';
  const idx = clampIdx(s.playheadIdx, frames.length);
  return formatFrameTime(frames[idx].time);
});

computed('flowStatus', ['flowField'], (s) => {
  const f = s.flowField;
  if (!f) return 'idle';
  if (f.loading) return 'computing';
  if (f.error) return `error: ${f.error.message}`;
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
  if (g.error) return `error: ${g.error.message}`;
  if (g.data) return `${g.data.length} grids`;
  return 'idle';
});

computed('forecastStatus', ['forecast'], (s) => {
  const f = s.forecast;
  if (!f) return 'idle';
  if (f.loading) return 'advecting';
  if (f.error) return `error: ${f.error.message}`;
  if (f.data) return `${f.data.frames.length} frames in ${f.data.computeMs.toFixed(0)} ms`;
  return 'idle';
});

// ─── 4. Map handle (lazy) + bridge between state and Leaflet ───────────
/* node:coverage disable */
let mapHandle = null;
let installedFrames = null;
let autoSeekDone = false;

function syncMapWithState() {
  if (!mapHandle) return;
  const frames = appState.radarHistory?.data?.frames;
  if (frames && frames !== installedFrames) {
    mapHandle.setHistory(frames);
    installedFrames = frames;
  }
  if (frames && frames.length > 0) {
    mapHandle.showFrame(clampIdx(appState.playheadIdx, frames.length));
  }
  for (const layer of appState.layers ?? []) applyLayerToMap(layer);
}

function applyLayerToMap(layer) {
  if (!mapHandle || !layer) return;
  const opacity = (layer.opacity ?? 0) / 100;
  if (layer.id === RADAR_LAYER_ID) {
    mapHandle.setVisible(layer.visible);
    mapHandle.setOpacity(opacity);
  } else if (layer.id === VECTORS_LAYER_ID) {
    mapHandle.setVectorsVisible(layer.visible);
    mapHandle.setVectorsOpacity(opacity);
  }
}

mountMap(document.getElementById('map'), {
  view: DEFAULT_VIEW,
  host: 'https://tilecache.rainviewer.com',
}).then((handle) => {
  mapHandle = handle;
  console.info('[skyo-prediction] map mounted');
  syncMapWithState();
}).catch((err) => {
  console.error('[skyo-prediction] map mount failed:', err);
});
/* node:coverage enable */

// ─── 5. Watchers ───────────────────────────────────────────────────────
watch(['radarHistory.data'], () => {
  const frames = appState.radarHistory?.data?.frames;
  if (!frames || frames.length === 0) return;
  if (!autoSeekDone) {
    setValue('playheadIdx', frames.length - 1);
    autoSeekDone = true;
  }
  syncMapWithState();
  /* node:coverage disable */
  refetchGrids();
  /* node:coverage enable */
});

watch(['radarGrids.data'], () => {
  /* node:coverage disable */
  if ((appState.radarGrids?.data?.length ?? 0) >= 2) refetchFlow();
  /* node:coverage enable */
});

// Once flow finishes, advect the latest decoded frame forward N steps.
watch(['flowField.data'], () => {
  /* node:coverage disable */
  if (appState.flowField?.data?.smoothed) refetchForecast();
  /* node:coverage enable */
});

watch(['playheadIdx'], () => {
  /* node:coverage disable */
  if (!mapHandle) return;
  const frames = appState.radarHistory?.data?.frames;
  if (!frames || frames.length === 0) return;
  mapHandle.showFrame(clampIdx(appState.playheadIdx, frames.length));
  /* node:coverage enable */
});

watch(['layers'], () => {
  /* node:coverage disable */
  if (!mapHandle) return;
  for (const layer of appState.layers ?? []) applyLayerToMap(layer);
  /* node:coverage enable */
});

watch(['flowField.data', 'playheadIdx', 'vectorColorMode'], () => {
  /* node:coverage disable */
  if (!mapHandle) return;
  const data = appState.flowField?.data;
  if (!data) {
    mapHandle.setVectors([]);
    return;
  }
  const decoded = appState.radarGrids?.data;
  const idx = clampIdx(appState.playheadIdx, decoded?.length ?? 0);
  // Pair i is the motion from frame i → frame i+1, so when *viewing*
  // frame i we show the pair that *led to* this frame: pairs[i-1].
  // Frame 0 has no preceding pair, so fall back to the smoothed field.
  const flow = idx > 0 ? data.pairs[idx - 1] : data.smoothed;
  if (!flow) {
    mapHandle.setVectors([]);
    return;
  }
  const frame = decoded?.[idx];
  const arrows = buildArrows(flow, {
    tileSize: TILE_SIZE,
    colorMode: appState.vectorColorMode,
    radarGrid: frame?.grid ?? null,
    radarWidth: frame?.width ?? 0,
    intensityThreshold: ARROW_INTENSITY_THRESHOLD,
  });
  mapHandle.setVectors(arrows);
  /* node:coverage enable */
});

let playInterval = 0;
watch(['playing'], () => {
  if (appState.playing && !playInterval) {
    playInterval = setInterval(() => {
      const frames = appState.radarHistory?.data?.frames;
      if (!frames || frames.length === 0) return;
      setValue('playheadIdx', nextIdx(appState.playheadIdx ?? 0, frames.length));
    }, FRAME_INTERVAL_MS);
  } else if (!appState.playing && playInterval) {
    clearInterval(playInterval);
    playInterval = 0;
  }
});

// ─── 6. UI handlers ────────────────────────────────────────────────────
// Spektrum handler signature: (el, state, delta, value, event).
// `el` is the DOM element; `value` is the auto-parsed input value
// (Number-coerced where possible). I had wrongly written
// `(e) => e.target.value` as if the first arg were the Event.
defineFn('togglePlay', () => setValue('playing', !appState.playing));

defineFn('seekPlayhead', (el) => {
  const v = Number(el.value);
  setValue('playing', false);
  setValue('playheadIdx', Number.isFinite(v) ? Math.floor(v) : 0);
});

// data-each rows carry the layer id via `:data-layer-id="item.id"` so
// we can identify which row was toggled without ambient context.
// (Layer toggle + opacity are wired via data-model="item.visible" and
// data-model="item.opacity.number" in the template — Spektrum updates
// appState.layers[i] directly, the layers watcher pushes to the map.)

defineFn('setColorMode', (el) => {
  const mode = el.value;
  if (COLOR_MODES.includes(mode)) setValue('vectorColorMode', mode);
});

if (typeof window !== 'undefined') {
  window.appState = appState;
}

// ─── 7. Bind DOM (must be last so all defineFn / setValue land first) ──
bindDOM(document.getElementById('app'));

// ─── 8. Start the rAF tick pump that drains the delta and propagates ──
//        state changes. Without this, every setValue writes to the
//        delta but it never commits, so the UI never updates.
run();
