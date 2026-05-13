/**
 * Per-cloud severity scoring. Fuses the supporting raster signals
 * already on the pipeline (trend, convective mask, CAPE, thunderstorm
 * score, ensemble probability) inside a single blob's footprint into
 *
 *   {
 *     tier: 'light' | 'moderate' | 'heavy' | 'severe' | 'thunderstorm',
 *     score: 0..1,
 *     drivers: { peakMmPerHour, meanMmPerHour, areaCells, ... }
 *   }
 *
 * Tier rules (in evaluation order):
 *   thunderstorm — any cell has convective > 0 AND mean CAPE > 1000 J/kg
 *                  AND peak thunderstorm score > 0.4
 *   severe       — peak ≥ 30 mm/h OR mean trend > +5 mm/h per interval
 *   heavy        — peak ≥ 10 mm/h
 *   moderate     — peak ≥ 2 mm/h
 *   light        — otherwise
 *
 * Score (always in [0, 1], monotonic in each input):
 *   0.2 · norm(peak, 30) + 0.2 · clamp(meanTrend / 5, 0, 1)
 * + 0.3 · norm(peakThunder, 5) + 0.3 · (peakProbability ?? 0)
 *
 * Drivers carry every input that contributed, omitting absent signals
 * so consumers can render tooltips like "peak 42 mm/h, CAPE 1380 J/kg,
 * 4 convective cells" without having to know which signals were on the
 * pipeline at scoring time.
 *
 * Pure function — no DOM, no Spektrum.
 */

export const TIERS_ORDER = Object.freeze(['light', 'moderate', 'heavy', 'severe', 'thunderstorm']);

export const TIER_PEAK_MODERATE = 2;   // mm/h
export const TIER_PEAK_HEAVY = 10;
export const TIER_PEAK_SEVERE = 30;
export const SEVERE_TREND_MIN = 5;     // mm/h per frame interval
export const THUNDERSTORM_CAPE_MIN = 1000;  // J/kg
export const THUNDERSTORM_SCORE_MIN = 0.4;

export const SCORE_PEAK_REF = 30;
export const SCORE_THUNDER_REF = 5;

export function scoreCloud(blob, supporting = {}) {
  if (!blob || !Array.isArray(blob.cells) || blob.cells.length === 0) {
    throw new Error('scoreCloud: blob must have a non-empty cells array');
  }
  if (!Number.isFinite(blob.peak)) {
    throw new Error('scoreCloud: blob.peak must be a finite number');
  }

  const { trend, convective, cape, thunderscore, probability } = supporting;

  // All non-null supporting fields must share dimensions (and match the
  // source grid the blob's cell indices reference). We can't validate
  // against the source grid since blob doesn't carry it, but we can
  // catch the most common mistake — supporting fields at different
  // resolutions — by cross-checking grid lengths.
  const present = [trend, convective, cape, thunderscore, probability].filter((f) => f?.grid);
  if (present.length > 1) {
    const ref = present[0].grid.length;
    for (const f of present) {
      if (f.grid.length !== ref) {
        throw new Error('scoreCloud: all supporting fields must share dimensions');
      }
    }
  }

  const cells = blob.cells;
  const aggregate = (field) => {
    if (!field?.grid) return null;
    let sum = 0;
    let peak = -Infinity;
    let count = 0;
    for (const p of cells) {
      const v = field.grid[p];
      if (!Number.isFinite(v)) continue;
      sum += v;
      if (v > peak) peak = v;
      count++;
    }
    if (count === 0) return null;
    return { mean: sum / count, peak };
  };

  const trendStat = aggregate(trend);
  const convectiveStat = aggregate(convective);
  const capeStat = aggregate(cape);
  const thunderStat = aggregate(thunderscore);
  const probStat = aggregate(probability);

  let convectiveCoreCells = 0;
  if (convective?.grid) {
    for (const p of cells) {
      const v = convective.grid[p];
      if (Number.isFinite(v) && v > 0) convectiveCoreCells++;
    }
  }

  const peak = blob.peak;
  const meanTrend = trendStat?.mean ?? 0;
  const meanCape = capeStat?.mean ?? 0;
  const peakThunder = thunderStat?.peak ?? 0;
  const peakProb = probStat?.peak ?? 0;

  // Tier — thunderstorm gates first, then intensity-based fallback.
  let tier;
  const isThunderstorm =
    convectiveCoreCells > 0 &&
    meanCape > THUNDERSTORM_CAPE_MIN &&
    peakThunder > THUNDERSTORM_SCORE_MIN;
  if (isThunderstorm) {
    tier = 'thunderstorm';
  } else if (peak >= TIER_PEAK_SEVERE || meanTrend > SEVERE_TREND_MIN) {
    tier = 'severe';
  } else if (peak >= TIER_PEAK_HEAVY) {
    tier = 'heavy';
  } else if (peak >= TIER_PEAK_MODERATE) {
    tier = 'moderate';
  } else {
    tier = 'light';
  }

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const score =
    0.2 * clamp01(peak / SCORE_PEAK_REF) +
    0.2 * clamp01(meanTrend / SEVERE_TREND_MIN) +
    0.3 * clamp01(peakThunder / SCORE_THUNDER_REF) +
    0.3 * clamp01(peakProb);

  const drivers = {
    peakMmPerHour: peak,
    meanMmPerHour: blob.mean,
    areaCells: blob.cells.length,
  };
  if (trendStat) drivers.trendMmPerHourPerInterval = trendStat.mean;
  if (capeStat) drivers.capeJPerKg = capeStat.mean;
  if (convectiveStat) drivers.convectiveCoreCells = convectiveCoreCells;
  if (thunderStat) drivers.thunderscorePeak = thunderStat.peak;
  if (probStat) drivers.probabilityOfRain = probStat.peak;

  return { tier, score, drivers };
}
