/**
 * Combine the interpolated history (observed + sub-frames) with the
 * forecast frames into a single chronological array. The scrubber and
 * the map renderer iterate this one list; the .kind tag lets the UI
 * distinguish observed vs interpolated vs forecast frames.
 *
 * Pure function — no DOM, no Spektrum. Inputs:
 *   interpolated.frames: [{ time, grid, width, height, observed }]
 *   interpolated.factor: integer N → 1 observed + (N-1) interpolated per pair
 *   forecast:    { frames: Float32Array[], width, height, startTime }
 *   frameIntervalSec: gap between forecast steps (default 600 = 10 min)
 *
 * Output: [{ time, grid, width, height, kind, pairIdx }]
 *   kind:    'observed' | 'interpolated' | 'forecast'
 *   pairIdx: which flowField.pairs[i] to display for vectors. Clamped to
 *            valid range; forecast frames share the last pair.
 */
export const DEFAULT_FRAME_INTERVAL_SEC = 600;

export function buildUnifiedFrames(interpolated, forecast, options = {}) {
  const {
    frameIntervalSec = DEFAULT_FRAME_INTERVAL_SEC,
    pairsLength = 0,
    forecastSlots = 0,
  } = options;
  const out = [];

  const interpFrames = interpolated?.frames ?? [];
  const factor = interpolated?.factor ?? 1;
  const lastPair = Math.max(0, pairsLength - 1);

  for (let i = 0; i < interpFrames.length; i++) {
    const f = interpFrames[i];
    out.push({
      time: f.time,
      grid: f.grid,
      width: f.width,
      height: f.height,
      kind: f.observed ? 'observed' : 'interpolated',
      pairIdx: Math.min(Math.floor(i / factor), lastPair),
    });
  }

  // Forecast slots: always reserve max(forecastSlots, forecast.frames.length)
  // so the scrubber always extends into the future even when forecast hasn't
  // settled yet. Slots without grid data still carry a kind="forecast" tag
  // and a projected timestamp; the map renderer skips frames with null grids.
  const availableForecast = forecast?.frames?.length ?? 0;
  const slotCount = Math.max(forecastSlots, availableForecast);
  if (slotCount > 0) {
    const startTime = forecast?.startTime ?? interpFrames.at(-1)?.time ?? 0;
    const width = forecast?.width ?? interpFrames.at(-1)?.width ?? 0;
    const height = forecast?.height ?? interpFrames.at(-1)?.height ?? 0;
    for (let i = 0; i < slotCount; i++) {
      out.push({
        time: startTime + (i + 1) * frameIntervalSec,
        grid: forecast?.frames?.[i] ?? null,
        width,
        height,
        kind: 'forecast',
        pairIdx: lastPair,
      });
    }
  }

  return out;
}
