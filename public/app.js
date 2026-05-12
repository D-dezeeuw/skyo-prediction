import { bindDOM, setValue } from 'spektrum';
import { initialState, readyState } from './state.js';

function applyState(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    setValue(key, value);
  }
}

applyState(initialState());
bindDOM(document.getElementById('app'));
applyState(readyState());
