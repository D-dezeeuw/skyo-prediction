import { addAsync, appState, bindDOM, computed, defineFn, setValue, watch } from 'spektrum';
import { initialState, readyState } from './state.js';
import { fetchManifest, loadHistory } from './radar.js';
import { mountMap, DEFAULT_VIEW } from './map.js';
import { createLayerRegistry } from './layers.js';
import { clampIdx, formatFrameTime, nextIdx, FRAME_INTERVAL_MS } from './timeline.js';
import { flowFromHistory } from './flow.js';
import { buildArrows, COLOR_MODES } from './vectors.js';

const RADAR_LAYER_ID = 'radar-history';
const VECTORS_LAYER_ID = 'motion-vectors';
const HISTORY_FRAME_COUNT = 12;
const TILE_SIZE = 256;

const layers = createLayerRegistry([
  { id: RADAR_LAYER_ID, name: 'Historical radar', visible: true, opacity: 0.8 },
  { id: VECTORS_LAYER_ID, name: 'Motion vectors', visible: true, opacity: 0.9 },
]);

function syncLayersToState() {
  setValue('layers', layers.list());
}

applyInitialState();
bindDOM(document.getElementById('app'));
applyState(readyState());
syncLayersToState();

/* node:coverage disable */
let mapHandle = null;
let installedFrames = null;
let autoSeekDone = false;

mountMap(document.getElementById('map'), {
  view: DEFAULT_VIEW,
  host: 'https://tilecache.rainviewer.com',
}).then((handle) => {
  mapHandle = handle;
  syncMapWithState();
});
/* node:coverage enable */

// Two-stage radar pipeline so the visual overlay never depends on the
// (much-more-failure-prone) PNG decode step.
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

const refetchFlow = addAsync('flowField', async () => {
  const decoded = appState.radarGrids?.data;
  if (!decoded || decoded.length < 2) return null;
  // Yield once before crunching ~200ms of SSDs so the UI thread can
  // render the "computing" state.
  await Promise.resolve();
  const t0 = performance.now();
  const field = flowFromHistory(decoded);
  return field ? { ...field, computeMs: performance.now() - t0 } : null;
});

setValue('playheadIdx', 0);
setValue('playing', false);
setValue('vectorColorMode', 'speed');

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
  if (f.data) return `ready: ${f.data.width}×${f.data.height} field in ${f.data.computeMs.toFixed(0)} ms`;
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

// Stage 1: frames arrive → install tile overlay + auto-seek + kick off decode.
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

// Stage 2: decoded grids arrive → kick off flow.
watch(['radarGrids.data'], () => {
  /* node:coverage disable */
  if ((appState.radarGrids?.data?.length ?? 0) >= 2) refetchFlow();
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
  const flow = appState.flowField?.data;
  if (!flow) {
    mapHandle.setVectors([]);
    return;
  }
  const decoded = appState.radarGrids?.data;
  const frame = decoded?.[clampIdx(appState.playheadIdx, decoded?.length ?? 0)];
  const arrows = buildArrows(flow, {
    tileSize: TILE_SIZE,
    colorMode: appState.vectorColorMode,
    radarGrid: frame?.grid ?? null,
    radarWidth: frame?.width ?? 0,
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

defineFn('togglePlay', () => setValue('playing', !appState.playing));

defineFn('seekPlayhead', (e) => {
  const v = Number(e.target.value);
  setValue('playing', false);
  setValue('playheadIdx', Number.isFinite(v) ? Math.floor(v) : 0);
});

defineFn('toggleLayer', (e, ctx) => {
  const id = ctx?.item?.id;
  if (!id) return;
  layers.setVisible(id, !layers.get(id).visible);
  syncLayersToState();
});

defineFn('setLayerOpacity', (e, ctx) => {
  const id = ctx?.item?.id;
  if (!id) return;
  const v = Number(e.target.value);
  layers.setOpacity(id, Number.isFinite(v) ? v / 100 : 0);
  syncLayersToState();
});

defineFn('setColorMode', (e) => {
  const mode = e.target.value;
  if (COLOR_MODES.includes(mode)) setValue('vectorColorMode', mode);
});

if (typeof window !== 'undefined') {
  window.appState = appState;
}

function applyInitialState() {
  applyState(initialState());
  setValue('layers', []);
}

function applyState(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    setValue(key, value);
  }
}

/* node:coverage disable */
/**
 * Idempotently push current appState into the map handle: install the
 * radar history if frames are new, swap to the current playhead frame,
 * and apply each layer's visibility/opacity. Called both when the map
 * finishes mounting and when radarHistory.data settles — whichever wins
 * the race.
 */
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
  for (const layer of layers.list()) applyLayerToMap(layer);
}

function applyLayerToMap(layer) {
  if (!mapHandle || !layer) return;
  if (layer.id === RADAR_LAYER_ID) {
    mapHandle.setVisible(layer.visible);
    mapHandle.setOpacity(layer.opacity);
  } else if (layer.id === VECTORS_LAYER_ID) {
    mapHandle.setVectorsVisible(layer.visible);
    mapHandle.setVectorsOpacity(layer.opacity);
  }
}
/* node:coverage enable */
