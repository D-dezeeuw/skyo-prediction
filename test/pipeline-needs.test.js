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

  test('topology stage is no longer declared (layer removed)', () => {
    assert.equal(STAGE_DEPENDENCIES.topology, undefined);
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
    const needs = computeStageNeeds([visible('motion-vectors'), hidden('thunderstorm')]);
    assert.equal(needs.flowField, true);
    assert.equal(needs.trend, false);
    assert.equal(needs.cape, false);
    assert.equal(needs.thunderstorm, false);
    assert.equal(needs.ensemble, false);
  });

  test('only Precipitation (past) visible → flowField + interpolated, but NOT forecast/trend/omega', () => {
    const needs = computeStageNeeds([visible('radar-history'), hidden('radar-forecast')]);
    assert.equal(needs.flowField, true);
    assert.equal(needs.interpolated, true);
    // Past-only doesn't need future-frame pipelines:
    assert.equal(needs.forecast, false);
    assert.equal(needs.trend, false);
    assert.equal(needs.omega, false);
    assert.equal(needs.cape, false);
    assert.equal(needs.thunderstorm, false);
    assert.equal(needs.ensemble, false);
    assert.equal(needs.confidence, false);
  });

  test('only Precipitation (forecast) visible → flowField + trend + omega + forecast', () => {
    const needs = computeStageNeeds([visible('radar-forecast'), hidden('radar-history')]);
    assert.equal(needs.flowField, true);
    assert.equal(needs.trend, true);
    assert.equal(needs.omega, true);
    assert.equal(needs.forecast, true);
    // Forecast doesn't need interpolated (which is for past smooth-scrubbing)
    assert.equal(needs.interpolated, false);
    assert.equal(needs.cape, false);
    assert.equal(needs.thunderstorm, false);
    assert.equal(needs.ensemble, false);
    assert.equal(needs.confidence, false);
  });

  test('both Precipitation layers visible → past + future stages all on', () => {
    const needs = computeStageNeeds([visible('radar-history'), visible('radar-forecast')]);
    assert.equal(needs.flowField, true);
    assert.equal(needs.interpolated, true);
    assert.equal(needs.forecast, true);
    assert.equal(needs.trend, true);
    assert.equal(needs.omega, true);
  });

  test('only Thunderstorm risk visible → trend + cape + thunderstorm', () => {
    const needs = computeStageNeeds([visible('thunderstorm')]);
    assert.equal(needs.trend, true);
    assert.equal(needs.cape, true);
    assert.equal(needs.thunderstorm, true);
    assert.equal(needs.flowField, false);
    assert.equal(needs.ensemble, false);
    assert.equal(needs.confidence, false);
  });

  test('only Probability layer → flowField + ensemble (no thunderstorm/cape)', () => {
    const needs = computeStageNeeds([visible('probability')]);
    assert.equal(needs.flowField, true);
    assert.equal(needs.ensemble, true);
    assert.equal(needs.cape, false);
    assert.equal(needs.thunderstorm, false);
  });

  test('only Forecast uncertainty (confidence) → flowField + confidence', () => {
    const needs = computeStageNeeds([visible('confidence')]);
    assert.equal(needs.flowField, true);
    assert.equal(needs.confidence, true);
    assert.equal(needs.trend, false);
    assert.equal(needs.ensemble, false);
  });

  test('hidden layers do not contribute to needs', () => {
    const needs = computeStageNeeds([hidden('thunderstorm'), hidden('motion-vectors')]);
    for (const s of STAGES) assert.equal(needs[s], false);
  });

  test('layers without an id or with unknown id are silently ignored', () => {
    const needs = computeStageNeeds([{ visible: true }, { id: 'mystery', visible: true }]);
    for (const s of STAGES) assert.equal(needs[s], false);
  });
});
