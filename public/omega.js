/**
 * 850 hPa vertical velocity (omega) ingest from Open-Meteo.
 *
 * Synoptic-scale rising air (negative omega) → moist convergence →
 * cloud growth. Sinking air (positive omega) → drying → cloud decay.
 * Combined with the radar-history trend (Story 8) this gives the
 * forecast both an empirical signal ("cells have been growing here
 * for 30 min") and a physical one ("the larger pressure system has
 * a rising column here").
 *
 * Open-Meteo's API supports multi-point queries; we sample a small
 * (5×5 default) grid spanning the tile bounds, fetch in one HTTP
 * call, then bilinear-upsample to the radar grid resolution. omega
 * varies on synoptic scales (~100–1000 km) so a coarse grid is
 * plenty — over our ~1000-km tile, 5×5 gives ~250 km between samples.
 *
 * Pure helpers + a thin browser-only fetcher.
 */

import { bilinearSample } from './advect.js';

export const OMEGA_API_BASE = 'https://api.open-meteo.com/v1/forecast';
export const OMEGA_GRID_DIM = 5;

export function buildSampleGrid(bounds, dim = OMEGA_GRID_DIM) {
  if (!bounds) throw new Error('buildSampleGrid: bounds required');
  if (!Number.isInteger(dim) || dim < 2) {
    throw new Error('buildSampleGrid: dim must be an integer >= 2');
  }
  const lats = [];
  const lons = [];
  for (let row = 0; row < dim; row++) {
    // row 0 = latTop (north), row dim-1 = latBottom (south)
    const t = row / (dim - 1);
    const lat = bounds.latTop + t * (bounds.latBottom - bounds.latTop);
    for (let col = 0; col < dim; col++) {
      const s = col / (dim - 1);
      const lon = bounds.lonLeft + s * (bounds.lonRight - bounds.lonLeft);
      lats.push(lat);
      lons.push(lon);
    }
  }
  return { lats, lons, dim };
}

export function buildOmegaUrl(sampleGrid) {
  if (!sampleGrid || !Array.isArray(sampleGrid.lats) || !Array.isArray(sampleGrid.lons)) {
    throw new Error('buildOmegaUrl: sampleGrid with lats[] and lons[] required');
  }
  const latStr = sampleGrid.lats.map((v) => v.toFixed(3)).join(',');
  const lonStr = sampleGrid.lons.map((v) => v.toFixed(3)).join(',');
  return `${OMEGA_API_BASE}?latitude=${latStr}&longitude=${lonStr}&hourly=vertical_velocity_850hPa&forecast_days=1`;
}

/**
 * Parse Open-Meteo's multi-location response into a Float32Array of
 * omega values, one per sample point, in row-major order matching
 * buildSampleGrid's emit order. Picks the hour matching `currentHourIso`
 * (e.g. "2026-05-13T10") or falls back to the first hour.
 */
export function parseOmegaResponse(data, dim, currentHourIso = null) {
  if (!Array.isArray(data)) {
    throw new Error('parseOmegaResponse: response must be an array of locations');
  }
  if (!Number.isInteger(dim) || dim < 2) {
    throw new Error('parseOmegaResponse: dim must be an integer >= 2');
  }
  const expected = dim * dim;
  if (data.length !== expected) {
    throw new Error(`parseOmegaResponse: expected ${expected} locations, got ${data.length}`);
  }
  const grid = new Float32Array(expected);
  for (let i = 0; i < data.length; i++) {
    const loc = data[i] ?? {};
    const times = loc.hourly?.time ?? [];
    const values = loc.hourly?.vertical_velocity_850hPa ?? [];
    let idx = 0;
    if (currentHourIso) {
      const matchIdx = times.findIndex((t) => typeof t === 'string' && t.startsWith(currentHourIso));
      if (matchIdx >= 0) idx = matchIdx;
    }
    const v = values[idx];
    grid[i] = Number.isFinite(v) ? v : 0;
  }
  return { width: dim, height: dim, grid };
}

/**
 * Bilinear upsample a coarse field (e.g. 5×5 omega) onto a target
 * resolution (e.g. 512×512 radar grid).
 */
export function upsampleOmegaField(lowRes, targetWidth, targetHeight) {
  if (!lowRes?.grid || !lowRes.width || !lowRes.height) {
    throw new Error('upsampleOmegaField: lowRes must shape as { width, height, grid }');
  }
  if (!Number.isInteger(targetWidth) || targetWidth <= 0 || !Number.isInteger(targetHeight) || targetHeight <= 0) {
    throw new Error('upsampleOmegaField: target dimensions must be positive integers');
  }
  const out = new Float32Array(targetWidth * targetHeight);
  const xScale = lowRes.width - 1;
  const yScale = lowRes.height - 1;
  for (let py = 0; py < targetHeight; py++) {
    const gy = (py / (targetHeight - 1)) * yScale;
    for (let px = 0; px < targetWidth; px++) {
      const gx = (px / (targetWidth - 1)) * xScale;
      out[py * targetWidth + px] = bilinearSample(lowRes.grid, lowRes.width, lowRes.height, gx, gy);
    }
  }
  return { width: targetWidth, height: targetHeight, grid: out };
}

/* node:coverage disable */
export async function fetchOmegaField(bounds, options = {}) {
  const {
    dim = OMEGA_GRID_DIM,
    fetchImpl = globalThis.fetch,
    nowDate = new Date(),
  } = options;
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchOmegaField: no fetch implementation available');
  }
  const sampleGrid = buildSampleGrid(bounds, dim);
  const url = buildOmegaUrl(sampleGrid);
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`fetchOmegaField: HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  const hourIso = nowDate.toISOString().slice(0, 13);
  return parseOmegaResponse(data, dim, hourIso);
}
/* node:coverage enable */

/**
 * Encode omega as a green↔purple diverging heatmap.
 *   negative omega (rising air, cloud growth) → green
 *   positive omega (sinking air, cloud decay) → purple
 *   near-zero → transparent
 * Different hue family from the radar-history trend so the user can
 * layer both and tell them apart visually.
 */
export const DEFAULT_OMEGA_SCALE = 0.3;
export const DEFAULT_OMEGA_MAX_ALPHA = 180;

export function encodeOmegaToRgba(grid, width, height, options = {}) {
  const { scale = DEFAULT_OMEGA_SCALE, maxAlpha = DEFAULT_OMEGA_MAX_ALPHA } = options;
  if (!(scale > 0)) throw new Error('encodeOmegaToRgba: scale must be positive');
  const expected = width * height;
  if (grid.length !== expected) {
    throw new Error(`encodeOmegaToRgba: grid length ${grid.length} != width*height ${expected}`);
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const epsilon = 0.02;
  for (let p = 0, i = 0; p < grid.length; p++, i += 4) {
    const v = grid[p];
    if (!Number.isFinite(v)) continue;
    let t = v / scale;
    if (t > 1) t = 1;
    if (t < -1) t = -1;
    if (Math.abs(t) < epsilon) continue;
    if (t < 0) {
      // Rising / growth — green
      out[i] = 60; out[i + 1] = 200; out[i + 2] = 90;
      out[i + 3] = -t * maxAlpha;
    } else {
      // Sinking / decay — purple
      out[i] = 160; out[i + 1] = 80; out[i + 2] = 220;
      out[i + 3] = t * maxAlpha;
    }
  }
  return out;
}
