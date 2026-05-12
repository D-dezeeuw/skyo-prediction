import { addAsync, appState, bindDOM, computed, defineFn, setValue, watch } from 'spektrum';
import { initialState, readyState } from './state.js';
import { fetchManifest, loadHistory } from './radar.js';
import { mountMap, DEFAULT_VIEW } from './map.js';
import { createLayerRegistry } from './layers.js';
import { clampIdx, formatFrameTime, nextIdx, FRAME_INTERVAL_MS } from './timeline.js';

const RADAR_LAYER_ID = 'radar-history';
const HISTORY_FRAME_COUNT = 12;

const layers = createLayerRegistry([
  { id: RADAR_LAYER_ID, name: 'Historical radar', visible: true, opacity: 0.8 },
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

computed('frameCount', ['radarHistory.data'], (s) =>
  s.radarHistory?.data?.frames ? s.radarHistory.data.frames.length : 0,
);

computed('currentFrameTime', ['radarHistory.data', 'playheadIdx'], (s) => {
  const frames = s.radarHistory?.data?.frames;
  if (!frames || frames.length === 0) return '';
  const idx = clampIdx(s.playheadIdx, frames.length);
  return formatFrameTime(frames[idx].time);
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
  }
}
/* node:coverage enable */
