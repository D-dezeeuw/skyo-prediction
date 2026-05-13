/**
 * Demand-driven pipeline gating.
 *
 * Every expensive stage in the data pipeline (flowField, trend, omega,
 * cape, thunderstorm, ensemble, confidence, interpolated, forecast,
 * topology) is associated with the layers that depend on its output.
 * When NO visible layer depends on a stage, the app.js watchers skip
 * triggering it — saving CPU, memory, and network calls.
 *
 *   import { computeStageNeeds } from './pipeline-needs.js';
 *   const needs = computeStageNeeds(appState.layers);
 *   if (needs.flowField && !appState.flowField?.data) refetchFlow();
 *
 * radarHistory + radarGrids are NOT gated — they're the source of truth
 * for every layer that renders pixels and stay always-on.
 *
 * Pure data — no DOM, no Spektrum.
 */

/** Stage → array of layer ids that require it (directly or transitively). */
export const STAGE_DEPENDENCIES = Object.freeze({
  // flowField feeds: motion vectors (direct), interpolated playback for
  // the past-radar layer, forecast (advection for the future-radar layer),
  // ensemble, confidence.
  flowField:    ['motion-vectors', 'radar-history', 'radar-forecast', 'probability', 'confidence'],
  // trend goes into the forecast growth/decay (so the future-radar layer
  // needs it) and into thunderstorm fusion.
  trend:        ['trend', 'radar-forecast', 'thunderstorm'],
  // omega is folded into the forecast trend; otherwise only the omega layer.
  omega:        ['omega', 'radar-forecast'],
  // cape is consumed by thunderstorm fusion + its own layer.
  cape:         ['cape', 'thunderstorm'],
  // thunderstorm score feeds its own layer.
  thunderstorm: ['thunderstorm'],
  // ensemble feeds the probability-of-rain layer.
  ensemble:     ['probability'],
  // confidence is consumed only by its own layer.
  confidence:   ['confidence'],
  // interpolated smooths past-scrubbing through observed pairs.
  interpolated: ['radar-history'],
  // forecast extends the radar into the next 2 h.
  forecast:     ['radar-forecast'],
});

/**
 * Compute the set of "needed" stages given the current layer visibility.
 * Returns a plain object — `needs.flowField`, `needs.trend`, etc. — so
 * Spektrum stores it cleanly (no Sets in state).
 */
export function computeStageNeeds(layers) {
  const visible = new Set();
  if (Array.isArray(layers)) {
    for (const l of layers) {
      if (l && l.visible) visible.add(l.id);
    }
  }
  const out = {};
  for (const stage of Object.keys(STAGE_DEPENDENCIES)) {
    out[stage] = false;
  }
  for (const [stage, requiringLayers] of Object.entries(STAGE_DEPENDENCIES)) {
    for (const id of requiringLayers) {
      if (visible.has(id)) { out[stage] = true; break; }
    }
  }
  return out;
}
