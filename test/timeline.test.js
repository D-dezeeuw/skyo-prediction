import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_INTERVAL_MS, clampIdx, formatFrameTime, nextIdx } from '../public/timeline.js';

describe('FRAME_INTERVAL_MS', () => {
  test('matches Skyo cadence (650 ms)', () => {
    assert.equal(FRAME_INTERVAL_MS, 650);
  });
});

describe('clampIdx', () => {
  test('returns idx when in range', () => {
    assert.equal(clampIdx(3, 10), 3);
  });

  test('clamps below 0 to 0', () => {
    assert.equal(clampIdx(-5, 10), 0);
  });

  test('clamps at or above length to length - 1', () => {
    assert.equal(clampIdx(10, 10), 9);
    assert.equal(clampIdx(99, 10), 9);
  });

  test('floors fractional indexes', () => {
    assert.equal(clampIdx(3.7, 10), 3);
  });

  test('returns 0 for invalid length', () => {
    assert.equal(clampIdx(5, 0), 0);
    assert.equal(clampIdx(5, -1), 0);
    assert.equal(clampIdx(5, 1.5), 0);
  });

  test('returns 0 for non-finite idx', () => {
    assert.equal(clampIdx(NaN, 10), 0);
    assert.equal(clampIdx(Infinity, 10), 0);
  });
});

describe('nextIdx', () => {
  test('increments by 1 within range', () => {
    assert.equal(nextIdx(3, 10), 4);
  });

  test('wraps from last to first', () => {
    assert.equal(nextIdx(9, 10), 0);
  });

  test('returns 0 for invalid length', () => {
    assert.equal(nextIdx(5, 0), 0);
    assert.equal(nextIdx(5, -3), 0);
  });

  test('clamps overflow before wrapping', () => {
    assert.equal(nextIdx(99, 10), 0);
  });
});

describe('formatFrameTime', () => {
  // Pin a UTC formatter so the test is deterministic regardless of host TZ
  const utcFormatter = new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });

  test('formats a unix-seconds timestamp as HH:MM', () => {
    // 2021-05-03T03:30:00Z = 1620012600
    assert.equal(formatFrameTime(1620012600, utcFormatter), '03:30');
  });

  test('returns empty string for non-finite input', () => {
    assert.equal(formatFrameTime(NaN), '');
    assert.equal(formatFrameTime(Infinity), '');
    assert.equal(formatFrameTime(undefined), '');
  });

  test('uses the default formatter when none provided', () => {
    // We can't pin the host TZ, but we can assert it returns *some* HH:MM-shaped string
    const out = formatFrameTime(1620012600);
    assert.match(out, /^\d{2}:\d{2}$/);
  });

  test('default formatter is cached across calls', () => {
    const a = formatFrameTime(1620012600);
    const b = formatFrameTime(1620012600);
    assert.equal(a, b);
  });
});
