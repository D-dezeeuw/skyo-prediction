/**
 * Confidence cone via two-member ensemble forecasting.
 *
 * Idea (pysteps STEPS-style, lite): run the same advection scheme with
 * two different flow-smoothing recipes — a conservative one (heavy
 * smoothing, slow to react, stable) and an aggressive one (light
 * smoothing, recent-bias). Where the two predictions agree the
 * forecast is high-confidence; where they diverge the system is
 * accelerating / changing direction and the uncertainty is real.
 *
 * `ensembleConfidence(framesA, framesB, w, h)` returns a per-cell
 * time-weighted RMS difference between the two forecasts. Later
 * forecast steps weigh more (uncertainty grows with lead time, so
 * cells that disagree far ahead matter more than cells that disagree
 * one step in).
 *
 * `encodeConfidenceToRgba` is the diverging-yellow-to-red colormap
 * used to render the field as a Leaflet imageOverlay.
 *
 * Pure functions only.
 */

/** Default magnitude where the colormap saturates (mm/h of RMS spread). */
export const DEFAULT_CONFIDENCE_SCALE = 2.0;
/** Max alpha (0..255) for the warmest pixels — keeps underlying radar
 *  partly readable through the overlay. */
export const DEFAULT_CONFIDENCE_MAX_ALPHA = 180;

export function ensembleConfidence(framesA, framesB, width, height) {
  if (!Array.isArray(framesA) || !Array.isArray(framesB)) {
    throw new Error('ensembleConfidence: framesA and framesB must be arrays of Float32Array');
  }
  if (framesA.length !== framesB.length) {
    throw new Error(`ensembleConfidence: framesA.length ${framesA.length} != framesB.length ${framesB.length}`);
  }
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('ensembleConfidence: width and height must be positive integers');
  }
  if (framesA.length === 0) return { width, height, grid: new Float32Array(width * height) };

  const n = width * height;
  const grid = new Float32Array(n);

  let totalWeight = 0;
  for (let i = 0; i < framesA.length; i++) {
    const a = framesA[i];
    const b = framesB[i];
    if (a.length !== n || b.length !== n) {
      throw new Error(`ensembleConfidence: frame ${i} length mismatch (a=${a.length}, b=${b.length}, expected ${n})`);
    }
    // Later steps weigh more (uncertainty compounds with lead time).
    const w = i + 1;
    totalWeight += w;
    for (let p = 0; p < n; p++) {
      const d = a[p] - b[p];
      grid[p] += w * d * d;
    }
  }

  for (let p = 0; p < n; p++) {
    grid[p] = Math.sqrt(grid[p] / totalWeight);
  }
  return { width, height, grid };
}

/**
 * Sequential colormap: low spread = transparent, high spread → warm.
 * Uses a single hue ramp (yellow → orange → red) since the quantity is
 * unsigned (it's an RMS, always ≥ 0). Returns an RGBA Uint8ClampedArray.
 */
export function encodeConfidenceToRgba(grid, width, height, options = {}) {
  const {
    scale = DEFAULT_CONFIDENCE_SCALE,
    maxAlpha = DEFAULT_CONFIDENCE_MAX_ALPHA,
  } = options;
  if (!(scale > 0)) throw new Error('encodeConfidenceToRgba: scale must be positive');
  const expected = width * height;
  if (grid.length !== expected) {
    throw new Error(`encodeConfidenceToRgba: grid length ${grid.length} != width*height ${expected}`);
  }
  const out = new Uint8ClampedArray(width * height * 4);
  const epsilon = 0.02;
  for (let p = 0, i = 0; p < grid.length; p++, i += 4) {
    const v = grid[p];
    if (!Number.isFinite(v) || v < epsilon) continue;
    let t = v / scale;
    if (t > 1) t = 1;
    // Yellow (low) → red (high) ramp. Pick (R, G, B):
    //   t = 0 → (255, 230, 80)   yellow
    //   t = 1 → (220, 30, 30)    red
    out[i] = 255 - 35 * t;
    out[i + 1] = 230 - 200 * t;
    out[i + 2] = 80 - 50 * t;
    out[i + 3] = t * maxAlpha;
  }
  return out;
}
