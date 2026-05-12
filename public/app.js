import { addAsync, appState, bindDOM, computed, setValue } from 'spektrum';
import { initialState, readyState } from './state.js';
import { fetchManifest, loadHistory } from './radar.js';

function applyState(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    setValue(key, value);
  }
}

applyState(initialState());
bindDOM(document.getElementById('app'));
applyState(readyState());

addAsync('radarHistory', async () => {
  const manifest = await fetchManifest();
  return loadHistory(manifest, 12);
});

computed('frameCount', ['radarHistory.data'], (s) =>
  s.radarHistory?.data ? s.radarHistory.data.length : 0,
);

computed('latestFrameTime', ['radarHistory.data'], (s) => {
  const data = s.radarHistory?.data;
  if (!data || data.length === 0) return '';
  const last = data[data.length - 1];
  return new Date(last.time * 1000).toISOString();
});

if (typeof window !== 'undefined') {
  window.appState = appState;
}
