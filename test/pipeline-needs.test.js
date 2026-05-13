import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { STAGE_DEPENDENCIES, computeStageNeeds } from '../public/pipeline-needs.js';

const STAGES = Object.keys(STAGE_DEPENDENCIES);

const visible = (id) => ({ id, visible: true });
const hidden  = (id) => ({ id, visible: false });

describe('STAGE_DEPENDENCIES', () => {
  test('every stage maps to a non-empty array of layer ids', () => {
    for (const stage of STAGES) {
      const deps = STAGE_DEPENDENCIES[stage];
      assert.ok(Array.isArray(deps) && deps.length > 0, `${stage} has no deps`);
    }
  });

  test('topology layer is its own dependency for the topology stage', () => {
    assert.ok(STAGE_DEPENDENCIES.topology.includes('topology'));
  });

  test('Cloud topology layer needs every other stage (it fuses all signals)', () => {
    // For every stage other than the leaf ones, topology should be listed
    const heavyStages = ['flowField', 'trend', 'cape', 'thunderstorm', 'ensemble', 'interpolated', 'forecast'];
    for (const s of heavyStages) {
      assert.ok(STAGE_DEPENDENCIES[s].includes('topology'), `${s} should depend on topology`);
    }
  });
});

describe('computeStageNeeds', () => {
  test('no layers visible → no stages needed', () => {
    const needs = computeStageNeeds([]);
    for (const s of STAGES) assert.equal(needs[s], false);
  });

  test('null / non-array input → all stages skipped (defensive)', () => {
    const needs = computeStageNeeds(null);
    for (const s of STAGES) assert.equal(needs[s], false);
  });

  test('every key in the result is a known stage', () => {
    const needs = computeStageNeeds([]);
    assert.deepEqual(Object.keys(needs).sort(), [...STAGES].sort());
  });

  test('only Motion vectors visible → only flowField is needed', () => {
    const needs = computeStageNeeds([visible('motion-vectors'), hidden('topology'), hidden('thunderstorm')]);
    assert.equal(needs.flowField, true);
    assert.equal(needs.trend, false);
    assert.equal(needs.cape, false);
    assert.equal(needs.thunderstorm, false);
    assert.equal(needs.ensemble, false);
    assert.equal(needs.topology, false);
  });

  test('only Historical radar visible → flowField/trend/omega/interp/forecast needed (for future frames + smooth playback) but NOT topology / thunderstorm / ensemble', () => {
    const needs = computeStageNeeds([visible('radar-history'), hidden('topology'), hidden('thunderstorm'), hidden('motion-vectors')]);
    // Stages the radar layer needs (for forecast + interpolation):
    assert.equal(needs.flowField, true);
    assert.equal(needs.trend, true);
    assert.equal(needs.omega, true);
    assert.equal(needs.interpolated, true);
    assert.equal(needs.forecast, true);
    // Stages the radar layer does NOT need:
    assert.equal(needs.cape, false);
    assert.equal(needs.thunderstorm, false);
    assert.equal(needs.ensemble, false);
    assert.equal(needs.confidence, false);
    assert.equal(needs.topology, false);
  });

  test('only Cloud topology visible → all stages topology consumes are needed', () => {
    const needs = computeStageNeeds([visible('topology')]);
    // Topology directly consumes trend, cape, thunderscore, probability,
    // flow, and depends on interpolated + forecast for the full unified
    // timeline. Omega is only used via the forecast trend (optional);
    // confidence is consumed only by its own layer.
    assert.equal(needs.flowField, true);
    assert.equal(needs.trend, true);
    assert.equal(needs.cape, true);
    assert.equal(needs.thunderstorm, true);
    assert.equal(needs.ensemble, true);
    assert.equal(needs.interpolated, true);
    assert.equal(needs.forecast, true);
    assert.equal(needs.topology, true);
    // Optional / not consumed directly:
    assert.equal(needs.omega, false);
    assert.equal(needs.confidence, false);
  });

  test('only Thunderstorm risk visible → trend + cape + thunderstorm + topology=false', () => {
    const needs = computeStageNeeds([visible('thunderstorm')]);
    assert.equal(needs.trend, true);
    assert.equal(needs.cape, true);
    assert.equal(needs.thunderstorm, true);
    assert.equal(needs.flowField, false);
    assert.equal(needs.ensemble, false);
    assert.equal(needs.confidence, false);
    assert.equal(needs.topology, false);
  });

  test('only Probability layer → flowField + ensemble (no thunderstorm/cape)', () => {
    const needs = computeStageNeeds([visible('probability')]);
    assert.equal(needs.flowField, true);
    assert.equal(needs.ensemble, true);
    assert.equal(needs.cape, false);
    assert.equal(needs.thunderstorm, false);
    assert.equal(needs.topology, false);
  });

  test('only Forecast uncertainty (confidence) → flowField + confidence', () => {
    const needs = computeStageNeeds([visible('confidence')]);
    assert.equal(needs.flowField, true);
    assert.equal(needs.confidence, true);
    assert.equal(needs.trend, false);
    assert.equal(needs.ensemble, false);
    assert.equal(needs.topology, false);
  });

  test('hidden layers do not contribute to needs', () => {
    const needs = computeStageNeeds([hidden('topology'), hidden('thunderstorm'), hidden('motion-vectors')]);
    for (const s of STAGES) assert.equal(needs[s], false);
  });

  test('layers without an id or with unknown id are silently ignored', () => {
    const needs = computeStageNeeds([{ visible: true }, { id: 'mystery', visible: true }]);
    for (const s of STAGES) assert.equal(needs[s], false);
  });
});
