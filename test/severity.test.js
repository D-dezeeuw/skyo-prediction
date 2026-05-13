import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TIERS_ORDER,
  TIER_PEAK_MODERATE,
  TIER_PEAK_HEAVY,
  TIER_PEAK_SEVERE,
  SEVERE_TREND_MIN,
  THUNDERSTORM_CAPE_MIN,
  THUNDERSTORM_SCORE_MIN,
  SCORE_PEAK_REF,
  SCORE_THUNDER_REF,
  scoreCloud,
} from '../public/severity.js';

const mkBlob = (peak, cells = [0, 1, 2, 3, 4]) => ({
  id: 1,
  cells,
  peak,
  mean: peak * 0.5,
  sum: peak * 0.5 * cells.length,
  bbox: { minX: 0, maxX: 0, minY: 0, maxY: 0 },
});

const mkField = (n, fill = 0) => ({ width: n, height: 1, grid: new Float32Array(n).fill(fill) });

describe('exports', () => {
  test('tier order matches the plan', () => {
    assert.deepEqual([...TIERS_ORDER], ['light', 'moderate', 'heavy', 'severe', 'thunderstorm']);
  });

  test('tier thresholds match plan defaults', () => {
    assert.equal(TIER_PEAK_MODERATE, 2);
    assert.equal(TIER_PEAK_HEAVY, 10);
    assert.equal(TIER_PEAK_SEVERE, 30);
    assert.equal(SEVERE_TREND_MIN, 5);
    assert.equal(THUNDERSTORM_CAPE_MIN, 1000);
    assert.equal(THUNDERSTORM_SCORE_MIN, 0.4);
    assert.equal(SCORE_PEAK_REF, 30);
    assert.equal(SCORE_THUNDER_REF, 5);
  });
});

describe('scoreCloud — tier rules', () => {
  test('peak < 2 mm/h → light, no supporting needed', () => {
    const out = scoreCloud(mkBlob(1.5));
    assert.equal(out.tier, 'light');
  });

  test('peak in [2, 10) → moderate', () => {
    const out = scoreCloud(mkBlob(5));
    assert.equal(out.tier, 'moderate');
  });

  test('peak in [10, 30) → heavy', () => {
    const out = scoreCloud(mkBlob(15));
    assert.equal(out.tier, 'heavy');
  });

  test('peak ≥ 30 → severe', () => {
    const out = scoreCloud(mkBlob(40));
    assert.equal(out.tier, 'severe');
  });

  test('mean trend > 5 mm/h/interval bumps to severe even with low peak', () => {
    const blob = mkBlob(5); // would be moderate by peak alone
    const trend = { width: 5, height: 1, grid: new Float32Array([6, 6, 6, 6, 6]) };
    const out = scoreCloud(blob, { trend });
    assert.equal(out.tier, 'severe');
  });

  test('thunderstorm requires all three gates: convective + CAPE + thunderscore', () => {
    const blob = mkBlob(40);
    const conv = { width: 5, height: 1, grid: new Float32Array([1, 1, 0, 0, 0]) };
    const cape = { width: 5, height: 1, grid: new Float32Array([2000, 2000, 2000, 2000, 2000]) };
    const tscore = { width: 5, height: 1, grid: new Float32Array([0.6, 0.5, 0.4, 0.3, 0.2]) };
    const out = scoreCloud(blob, { convective: conv, cape, thunderscore: tscore });
    assert.equal(out.tier, 'thunderstorm');
  });

  test('thunderstorm gate fails if no convective cells', () => {
    const blob = mkBlob(40);
    const conv = mkField(5, 0); // all zero
    const cape = { width: 5, height: 1, grid: new Float32Array([2000, 2000, 2000, 2000, 2000]) };
    const tscore = { width: 5, height: 1, grid: new Float32Array([0.6, 0.5, 0.4, 0.3, 0.2]) };
    const out = scoreCloud(blob, { convective: conv, cape, thunderscore: tscore });
    assert.equal(out.tier, 'severe'); // falls back to peak-based tier
  });

  test('thunderstorm gate fails if mean CAPE ≤ 1000', () => {
    const blob = mkBlob(40);
    const conv = { width: 5, height: 1, grid: new Float32Array([1, 1, 0, 0, 0]) };
    const cape = { width: 5, height: 1, grid: new Float32Array([500, 500, 500, 500, 500]) };
    const tscore = { width: 5, height: 1, grid: new Float32Array([0.6, 0.5, 0.4, 0.3, 0.2]) };
    const out = scoreCloud(blob, { convective: conv, cape, thunderscore: tscore });
    assert.equal(out.tier, 'severe');
  });

  test('thunderstorm gate fails if peak thunderscore ≤ 0.4', () => {
    const blob = mkBlob(40);
    const conv = { width: 5, height: 1, grid: new Float32Array([1, 1, 0, 0, 0]) };
    const cape = { width: 5, height: 1, grid: new Float32Array([2000, 2000, 2000, 2000, 2000]) };
    const tscore = { width: 5, height: 1, grid: new Float32Array([0.3, 0.3, 0.2, 0.2, 0.1]) };
    const out = scoreCloud(blob, { convective: conv, cape, thunderscore: tscore });
    assert.equal(out.tier, 'severe');
  });
});

describe('scoreCloud — score formula', () => {
  test('score is in [0, 1] for a fully-saturating blob', () => {
    const blob = mkBlob(50);
    const trend = { width: 5, height: 1, grid: new Float32Array([10, 10, 10, 10, 10]) };
    const tscore = { width: 5, height: 1, grid: new Float32Array([5, 5, 5, 5, 5]) };
    const prob = { width: 5, height: 1, grid: new Float32Array([1, 1, 1, 1, 1]) };
    const out = scoreCloud(blob, { trend, thunderscore: tscore, probability: prob });
    assert.ok(out.score >= 0 && out.score <= 1, `score=${out.score}`);
    // All four terms saturate → exactly 1
    assert.ok(Math.abs(out.score - 1) < 1e-9);
  });

  test('score = 0 when peak is 0 and no signals', () => {
    const blob = mkBlob(0);
    const out = scoreCloud(blob);
    assert.equal(out.score, 0);
  });

  test('score is monotonic in peak (more peak ⇒ higher score)', () => {
    const lo = scoreCloud(mkBlob(5));
    const hi = scoreCloud(mkBlob(25));
    assert.ok(hi.score > lo.score);
  });

  test('score is monotonic in probability', () => {
    const blob = mkBlob(5);
    const lo = scoreCloud(blob, { probability: { width: 5, height: 1, grid: new Float32Array([0.1, 0.1, 0.1, 0.1, 0.1]) } });
    const hi = scoreCloud(blob, { probability: { width: 5, height: 1, grid: new Float32Array([0.9, 0.9, 0.9, 0.9, 0.9]) } });
    assert.ok(hi.score > lo.score);
  });

  test('negative trend does not push score below 0', () => {
    const blob = mkBlob(5);
    const trend = { width: 5, height: 1, grid: new Float32Array([-10, -10, -10, -10, -10]) };
    const out = scoreCloud(blob, { trend });
    assert.ok(out.score >= 0);
  });
});

describe('scoreCloud — drivers', () => {
  test('drivers always include peak, mean, area; supporting signals omitted when absent', () => {
    const blob = mkBlob(7);
    const out = scoreCloud(blob);
    assert.equal(out.drivers.peakMmPerHour, 7);
    assert.equal(out.drivers.meanMmPerHour, 3.5);
    assert.equal(out.drivers.areaCells, 5);
    // No supporting signals → none of these keys present
    assert.equal('trendMmPerHourPerInterval' in out.drivers, false);
    assert.equal('capeJPerKg' in out.drivers, false);
    assert.equal('convectiveCoreCells' in out.drivers, false);
    assert.equal('thunderscorePeak' in out.drivers, false);
    assert.equal('probabilityOfRain' in out.drivers, false);
  });

  test('drivers include each supporting signal when present', () => {
    const blob = mkBlob(40);
    const trend = { width: 5, height: 1, grid: new Float32Array([1, 2, 3, 4, 5]) };
    const conv = { width: 5, height: 1, grid: new Float32Array([2, 0, 1, 0, 0]) };
    const cape = { width: 5, height: 1, grid: new Float32Array([1500, 1500, 1500, 1500, 1500]) };
    const tscore = { width: 5, height: 1, grid: new Float32Array([0.5, 0.6, 0.4, 0.3, 0.2]) };
    const prob = { width: 5, height: 1, grid: new Float32Array([0.7, 0.8, 0.6, 0.5, 0.4]) };
    const out = scoreCloud(blob, { trend, convective: conv, cape, thunderscore: tscore, probability: prob });
    assert.ok(Math.abs(out.drivers.trendMmPerHourPerInterval - 3) < 1e-6);
    assert.equal(out.drivers.convectiveCoreCells, 2);
    assert.ok(Math.abs(out.drivers.capeJPerKg - 1500) < 1e-6);
    assert.ok(Math.abs(out.drivers.thunderscorePeak - 0.6) < 1e-6);
    assert.ok(Math.abs(out.drivers.probabilityOfRain - 0.8) < 1e-6);
  });

  test('NaN entries in supporting fields are skipped, not propagated', () => {
    const blob = mkBlob(40);
    const trend = { width: 5, height: 1, grid: new Float32Array([NaN, NaN, 6, 6, 6]) };
    const out = scoreCloud(blob, { trend });
    // mean trend over the three valid cells is 6
    assert.ok(Math.abs(out.drivers.trendMmPerHourPerInterval - 6) < 1e-6);
  });

  test('all-NaN supporting field is treated as absent', () => {
    const blob = mkBlob(7);
    const trend = { width: 5, height: 1, grid: new Float32Array([NaN, NaN, NaN, NaN, NaN]) };
    const out = scoreCloud(blob, { trend });
    assert.equal('trendMmPerHourPerInterval' in out.drivers, false);
  });
});

describe('scoreCloud — error handling', () => {
  test('throws on missing or empty blob', () => {
    assert.throws(() => scoreCloud(null), /blob/);
    assert.throws(() => scoreCloud({}), /blob/);
    assert.throws(() => scoreCloud({ cells: [], peak: 5 }), /blob/);
  });

  test('throws on non-finite peak', () => {
    assert.throws(() => scoreCloud({ cells: [0], peak: NaN }), /peak/);
    assert.throws(() => scoreCloud({ cells: [0], peak: Infinity }), /peak/);
  });

  test('throws when supporting fields have mismatched dimensions', () => {
    const blob = mkBlob(40);
    const trend = mkField(5, 1);
    const cape = mkField(8, 1500);
    assert.throws(() => scoreCloud(blob, { trend, cape }), /dimensions/);
  });
});
