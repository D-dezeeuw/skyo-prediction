/**
 * Convective Available Potential Energy (CAPE) ingest from Open-Meteo.
 *
 * CAPE is the canonical "thunderstorms possible?" predictor — it
 * measures the energy available for vertical convection. Rough
 * meteorological thresholds:
 *   <  500 J/kg  : weak, isolated showers at most
 *   <  1000      : marginal — limited convection
 *     1000–2500  : moderate — thunderstorms likely if triggered
 *   >  2500      : severe convection possible
 *
 * Same multi-point fetch pattern as omega.js (5×5 grid → bilinear
 * upsample) since CAPE also varies on synoptic scales.
 */

import {
  OMEGA_GRID_DIM,
  buildSampleGrid,
  buildOpenMeteoUrl,
  parseOpenMeteoResponse,
  upsampleOmegaField,
} from './omega.js';

const CAPE_VARIABLE = 'cape';
/** Default upper end of the colormap (J/kg). Anything beyond saturates. */
export const DEFAULT_CAPE_SCALE = 2500;
export const DEFAULT_CAPE_MAX_ALPHA = 180;

export function buildCapeUrl(sampleGrid) {
  return buildOpenMeteoUrl(sampleGrid, CAPE_VARIABLE);
}

export function parseCapeResponse(data, dim, currentHourIso = null) {
  return parseOpenMeteoResponse(data, dim, CAPE_VARIABLE, currentHourIso);
}

/* node:coverage disable */
export async function fetchCapeField(bounds, options = {}) {
  const {
    dim = OMEGA_GRID_DIM,
    fetchImpl = globalThis.fetch,
    nowDate = new Date(),
  } = options;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchCapeField: no fetch implementation available');
  }
  const sampleGrid = buildSampleGrid(bounds, dim);
  const url = buildCapeUrl(sampleGrid);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`fetchCapeField: HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  const hourIso = nowDate.toISOString().slice(0, 13);
  return parseCapeResponse(data, dim, hourIso);
}
/* node:coverage enable */

export function upsampleCapeField(lowRes, targetWidth, targetHeight) {
  return upsampleOmegaField(lowRes, targetWidth, targetHeight);
}

/**
 * Sequential transparent → orange → red colormap. Below ~200 J/kg
 * (light stippling) → transparent; saturates at scale.
 */
export function encodeCapeToRgba(grid, width, height, options = {}) {
  const { scale = DEFAULT_CAPE_SCALE, maxAlpha = DEFAULT_CAPE_MAX_ALPHA } = options;
  if (!(scale > 0)) throw new Error('encodeCapeToRgba: scale must be positive');
  const expected = width * height;
  if (grid.length !== expected) {
    throw new Error(`encodeCapeToRgba: grid length ${grid.length} != width*height ${expected}`);
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const epsilon = 0.05; // ~125 J/kg at scale 2500 — below the "marginal" line
  for (let p = 0, i = 0; p < grid.length; p++, i += 4) {
    const v = grid[p];
    if (!Number.isFinite(v) || v <= 0) continue;
    let t = v / scale;
    if (t > 1) t = 1;
    if (t < epsilon) continue;
    // 0 → light orange (255, 200, 100), 1 → deep red (200, 30, 30)
    out[i] = 255 - 55 * t;
    out[i + 1] = 200 - 170 * t;
    out[i + 2] = 100 - 70 * t;
    out[i + 3] = t * maxAlpha;
  }
  return out;
}
