import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { APP_TITLE, initialState, readyState } from '../public/state.js';

describe('state', () => {
  test('APP_TITLE is the project name', () => {
    assert.equal(APP_TITLE, 'skyo-prediction');
  });

  test('initialState exposes title and a non-ready status', () => {
    const s = initialState();
    assert.equal(s.title, APP_TITLE);
    assert.equal(s.status, 'Booting');
  });

  test('initialState returns a fresh object on each call', () => {
    const a = initialState();
    const b = initialState();
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
  });

  test('readyState returns the Ready status', () => {
    assert.deepEqual(readyState(), { status: 'Ready' });
  });

  test('readyState returns a fresh object on each call', () => {
    assert.notEqual(readyState(), readyState());
  });
});
