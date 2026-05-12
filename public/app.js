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
mountMap(document.getElementById('map'), {
  view: DEFAULT_VIEW,
  host: 'https://tilecache.rainviewer.com',
}).then((handle) => {
  mapHandle = handle;
  applyLayerToMap(layers.get(RADAR_LAYER_ID));
});
/* node:coverage enable */

addAsync('radarHistory', async () => {
  const manifest = await fetchManifest();
  const frames = manifest.past.slice(-HISTORY_FRAME_COUNT);
  if (mapHandle) {
    mapHandle.setHistory(frames);
    setValue('playheadIdx', frames.length - 1);
  }
  return { host: manifest.host, frames, decoded: await loadHistory(manifest, HISTORY_FRAME_COUNT) };
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

const refetchFlow = addAsync('flowField', async () => {
  const decoded = appState.radarHistory?.data?.decoded;
  if (!decoded || decoded.length < 2) return null;
  // Yield once before crunching ~200ms of SSDs so the UI thread can
  // render the "computing" state.
  await Promise.resolve();
  const t0 = performance.now();
  const field = flowFromHistory(decoded);
  return field ? { ...field, computeMs: performance.now() - t0 } : null;
});

watch(['radarHistory.data'], () => {
  if (appState.radarHistory?.data?.decoded?.length >= 2) {
    /* node:coverage disable */
    refetchFlow.run?.();
    /* node:coverage enable */
  }
});

computed('flowStatus', ['flowField'], (s) => {
  const f = s.flowField;
  if (!f) return 'idle';
  if (f.loading) return 'computing';
  if (f.error) return `error: ${f.error.message}`;
  if (f.data) return `ready: ${f.data.width}×${f.data.height} field in ${f.data.computeMs.toFixed(0)} ms`;
  return 'idle';
});

watch(['radarHistory.data', 'playheadIdx'], () => {
  if (!mapHandle) return;
  const frames = appState.radarHistory?.data?.frames;
  if (!frames || frames.length === 0) return;
  mapHandle.showFrame(clampIdx(appState.playheadIdx, frames.length));
});

watch(['layers'], () => {
  if (!mapHandle) return;
  const radar = appState.layers?.find((l) => l.id === RADAR_LAYER_ID);
  if (radar) applyLayerToMap(radar);
  const vectors = appState.layers?.find((l) => l.id === VECTORS_LAYER_ID);
  if (vectors) applyLayerToMap(vectors);
});

watch(['flowField.data', 'playheadIdx', 'vectorColorMode'], () => {
  /* node:coverage disable */
  if (!mapHandle) return;
  const flow = appState.flowField?.data;
  if (!flow) {
    mapHandle.setVectors([]);
    return;
  }
  const decoded = appState.radarHistory?.data?.decoded;
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
