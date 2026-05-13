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

/**
 * Encode a rain-rate grid (Float32Array, mm/h) back into an RGBA pixel
 * buffer for canvas rendering. Inverse of decodeRgbaToRainRate. Zero
 * mm/h → transparent black. Anything else → snapped to the nearest
 * palette stop (so output looks like RainViewer's own coloured tiles).
 */
export function encodeRainRateToRgba(grid, width, height) {
  const expected = width * height;
  if (grid.length !== expected) {
    throw new Error(
      `encodeRainRateToRgba: grid length ${grid.length} does not match width*height = ${expected}`,
    );
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0, i = 0; p < grid.length; p++, i += 4) {
    const mm = grid[p];
    if (!(mm > 0)) {
      // RGBA already zero-initialised → transparent black for no-rain
      continue;
    }
    const dbz = rainRateToDbz(mm);
    const [r, g, b] = dbzToRgb(dbz);
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = 255;
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
