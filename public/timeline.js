/**
 * Pure timeline math used by the playhead scrubber and the play-loop.
 * Kept separate from app.js so it's testable without Spektrum.
 */

export const FRAME_INTERVAL_MS = 650;

export function clampIdx(idx, length) {
  if (!Number.isFinite(idx) || !Number.isInteger(length) || length <= 0) return 0;
  const i = Math.floor(idx);
  if (i < 0) return 0;
  if (i >= length) return length - 1;
  return i;
}

/** Wrap-around increment for the play loop. */
export function nextIdx(idx, length) {
  if (!Number.isInteger(length) || length <= 0) return 0;
  const clamped = clampIdx(idx, length);
  return (clamped + 1) % length;
}

/** Format a unix-seconds timestamp as HH:MM in the user's local time. */
export function formatFrameTime(unixSeconds, formatter = defaultFormatter()) {
  if (!Number.isFinite(unixSeconds)) return '';
  return formatter.format(new Date(unixSeconds * 1000));
}

let cached = null;
function defaultFormatter() {
  if (cached) return cached;
  cached = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return cached;
}
