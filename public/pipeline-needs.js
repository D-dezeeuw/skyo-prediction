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
  // the radar layer, forecast (advection), ensemble, confidence, and
  // topology (motion vectors per cloud).
  flowField:    ['motion-vectors', 'radar-history', 'probability', 'confidence', 'topology'],
  // trend goes into the forecast growth/decay (so radar future frames
  // need it), into thunderstorm fusion, and into topology severity.
  trend:        ['trend', 'radar-history', 'thunderstorm', 'topology'],
  // omega is folded into the forecast trend; otherwise only the omega layer.
  omega:        ['omega', 'radar-history'],
  // cape is consumed by thunderstorm fusion + topology severity.
  cape:         ['cape', 'thunderstorm', 'topology'],
  // thunderstorm score feeds its own layer + topology severity.
  thunderstorm: ['thunderstorm', 'topology'],
  // ensemble feeds the probability-of-rain layer + topology probability driver.
  ensemble:     ['probability', 'topology'],
  // confidence is consumed only by its own layer.
  confidence:   ['confidence'],
  // interpolated makes the radar scrubber smooth. Topology computes per
  // unified-timeline slot so also depends on it.
  interpolated: ['radar-history', 'topology'],
  // forecast extends the radar into the next 2 h. Topology covers
  // forecast slots, so it needs forecast too.
  forecast:     ['radar-history', 'topology'],
  // topology is the cloud-shape layer.
  topology:     ['topology'],
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
