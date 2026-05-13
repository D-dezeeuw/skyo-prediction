/**
 * RainViewer color-palette decoding and Z-R (reflectivity → rain rate) math.
 *
 * Pure functions only. Browser-only image decoding lives in radar.js.
 *
 * The palette stops below approximate RainViewer's "Universal Blue" colour
 * scheme (palette index 2). They are anchor points; rgbToDbz() snaps an input
 * pixel to the nearest stop in RGB space. Stops will be tuned against real
 * RainViewer pixels in a later story; the structure is what matters now.
 */

export const TRANSPARENT_DBZ = -Infinity;
export const NO_RAIN_RGB = Object.freeze([0, 0, 0]);

/** Ordered low → high dBZ. */
export const PALETTE_STOPS = Object.freeze([
  { rgb: Object.freeze([0, 0, 0]), dbz: TRANSPARENT_DBZ },
  { rgb: Object.freeze([0, 236, 236]), dbz: 5 },
  { rgb: Object.freeze([1, 160, 246]), dbz: 10 },
  { rgb: Object.freeze([0, 0, 246]), dbz: 15 },
  { rgb: Object.freeze([0, 255, 0]), dbz: 20 },
  { rgb: Object.freeze([0, 200, 0]), dbz: 25 },
  { rgb: Object.freeze([0, 144, 0]), dbz: 30 },
  { rgb: Object.freeze([255, 255, 0]), dbz: 35 },
  { rgb: Object.freeze([231, 192, 0]), dbz: 40 },
  { rgb: Object.freeze([255, 144, 0]), dbz: 45 },
  { rgb: Object.freeze([255, 0, 0]), dbz: 50 },
  { rgb: Object.freeze([214, 0, 0]), dbz: 55 },
  { rgb: Object.freeze([192, 0, 0]), dbz: 60 },
  { rgb: Object.freeze([255, 0, 255]), dbz: 65 },
  { rgb: Object.freeze([153, 85, 201]), dbz: 70 },
]);

/** Marshall–Palmer: Z = 200 * R^1.6, with R in mm/h, Z in mm^6/m^3. */
export function dbzToRainRate(dbz) {
  if (!Number.isFinite(dbz)) return 0;
  const z = 10 ** (dbz / 10);
  return (z / 200) ** (1 / 1.6);
}

export function rainRateToDbz(mmPerHour) {
  if (!(mmPerHour > 0)) return TRANSPARENT_DBZ;
  const z = 200 * mmPerHour ** 1.6;
  return 10 * Math.log10(z);
}

function squaredDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

/**
 * Snap an (r,g,b) pixel to the nearest palette stop and return its dBZ.
 * Fully-transparent pixels (alpha=0) decode to TRANSPARENT_DBZ regardless
 * of colour channels — matches RainViewer where empty cells are alpha 0.
 */
export function rgbToDbz(r, g, b, a = 255) {
  if (a === 0) return TRANSPARENT_DBZ;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < PALETTE_STOPS.length; i++) {
    const d = squaredDistance([r, g, b], PALETTE_STOPS[i].rgb);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return PALETTE_STOPS[bestIdx].dbz;
}

/** Inverse: pick the palette colour closest to a dBZ value.
 *  Any value below the lowest finite rain stop (or non-finite) decodes to
 *  the no-rain anchor — i.e. "below detection threshold" reads as empty. */
export function dbzToRgb(dbz) {
  const rainStops = PALETTE_STOPS.filter((s) => Number.isFinite(s.dbz));
  if (!Number.isFinite(dbz) || dbz < rainStops[0].dbz) {
    return PALETTE_STOPS[0].rgb;
  }
  let best = rainStops[0];
  let bestDist = Math.abs(best.dbz - dbz);
  for (let i = 1; i < rainStops.length; i++) {
    const d = Math.abs(rainStops[i].dbz - dbz);
    if (d < bestDist) {
      bestDist = d;
      best = rainStops[i];
    }
  }
  return best.rgb;
}

const SORTED_RAIN_STOPS = PALETTE_STOPS
  .filter((s) => Number.isFinite(s.dbz))
  .sort((a, b) => a.dbz - b.dbz);

/**
 * Smooth-interpolated variant of dbzToRgb. Finds the two palette stops
 * that bracket the input dBZ and linearly interpolates the RGB channels
 * between them. Used by the radar render path to give a continuous
 * heatmap look (no banded plateaus at palette boundaries) without
 * abandoning the established RainViewer palette.
 *
 * Below the lowest rain stop → null (caller treats as transparent).
 * At or above the highest stop → the highest stop's RGB unchanged.
 */
export function dbzToRgbSmooth(dbz) {
  if (!Number.isFinite(dbz) || dbz < SORTED_RAIN_STOPS[0].dbz) return null;
  const last = SORTED_RAIN_STOPS[SORTED_RAIN_STOPS.length - 1];
  if (dbz >= last.dbz) return [last.rgb[0], last.rgb[1], last.rgb[2]];
  for (let i = 0; i < SORTED_RAIN_STOPS.length - 1; i++) {
    const lo = SORTED_RAIN_STOPS[i];
    const hi = SORTED_RAIN_STOPS[i + 1];
    if (dbz >= lo.dbz && dbz <= hi.dbz) {
      const t = (dbz - lo.dbz) / (hi.dbz - lo.dbz);
      return [
        lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * t,
        lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * t,
        lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * t,
      ];
    }
  }
  return null;
}

/** Lowest dBZ stop in the rain ramp — below this, alpha fades to zero
 *  rather than snapping, so cloud edges blend into the basemap instead
 *  of producing a hard rim of opaque cyan around very light rain. */
export const RAIN_FADE_FLOOR_DBZ = SORTED_RAIN_STOPS[0].dbz;
/** dBZ at which the rain alpha reaches full opacity (top of the fade-in
 *  ramp). Tuned to coincide with the second palette stop. */
export const RAIN_FADE_CEILING_DBZ = SORTED_RAIN_STOPS[1]?.dbz ?? (RAIN_FADE_FLOOR_DBZ + 5);

/**
 * Encode a rain-rate grid (Float32Array, mm/h) back into an RGBA pixel
 * buffer for canvas rendering. Uses smooth palette interpolation
 * (`dbzToRgbSmooth`) so adjacent rain bands blend into a continuous
 * heatmap instead of banding at palette boundaries — and fades the
 * alpha in over the first dBZ band so very light rain reads as a soft
 * halo rather than a hard rim of opaque cyan.
 */
export function encodeRainRateToRgba(grid, width, height) {
  const expected = width * height;
  if (grid.length !== expected) {
    throw new Error(
      `encodeRainRateToRgba: grid length ${grid.length} does not match width*height = ${expected}`,
    );
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const fadeFloor = RAIN_FADE_FLOOR_DBZ;
  const fadeCeil = RAIN_FADE_CEILING_DBZ;
  const fadeSpan = Math.max(1e-6, fadeCeil - fadeFloor);
  for (let p = 0, i = 0; p < grid.length; p++, i += 4) {
    const mm = grid[p];
    if (!(mm > 0)) continue;
    const dbz = rainRateToDbz(mm);
    const rgb = dbzToRgbSmooth(dbz);
    if (!rgb) continue;
    // Fade-in alpha across the first band so cloud edges feather softly
    // into the basemap instead of producing a hard cyan rim.
    let alpha = 255;
    if (dbz < fadeCeil) {
      const t = Math.max(0, (dbz - fadeFloor) / fadeSpan);
      alpha = Math.round(t * 255);
    }
    out[i] = rgb[0];
    out[i + 1] = rgb[1];
    out[i + 2] = rgb[2];
    out[i + 3] = alpha;
  }
  return out;
}

/**
 * Decode an RGBA pixel buffer (Uint8ClampedArray, length = width*height*4)
 * into a Float32Array of rain rates (mm/h). Transparent / sub-threshold
 * pixels become 0 mm/h.
 */
export function decodeRgbaToRainRate(rgba, width, height) {
  const expected = width * height * 4;
  if (rgba.length !== expected) {
    throw new Error(
      `decodeRgbaToRainRate: rgba length ${rgba.length} does not match width*height*4 = ${expected}`,
    );
  }
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    const dbz = rgbToDbz(rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]);
    out[p] = Number.isFinite(dbz) ? dbzToRainRate(dbz) : 0;
  }
  return out;
}
