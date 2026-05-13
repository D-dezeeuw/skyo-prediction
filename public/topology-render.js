/**
 * Pure helpers for rendering a Topology object as SVG items on the
 * Leaflet map's tile-pixel viewBox.
 *
 *   buildTopologyRenderItems(topology, options) →
 *     array of { type: 'polygon' | 'label', ... }
 *
 * Each cloud's polygons in grid-pixel coords are projected to
 * tile-pixel coords (the SVG viewBox is 0..tileSize on each axis).
 * The renderer caller in map.js iterates this list and creates
 * `<path>` and `<text>` elements — keeping the DOM construction out
 * of this module so it stays unit-testable in plain Node.
 *
 * Configurable per call:
 *   tileSize           — SVG viewBox edge length (default 256)
 *   showLabels         — emit tier badges (SEVERE, T-STORM) on centroids
 *                        for tiers ≥ labelTierMin (default OFF)
 *   labelTierMin       — minimum tier for labels (default 'heavy')
 *   renderMode         — 'fill' | 'line' | 'fill+line' (default 'fill+line')
 *                        Controls whether polygons render with fill,
 *                        stroke, or both.
 *   colorMode          — 'tier' | 'mono' (default 'tier')
 *                        'tier' → severity-coloured palette
 *                        'mono' → white, opacity scales with severity score
 *   simplifyTolerance  — Douglas–Peucker tolerance in tile pixels
 *                        (default 0 = no simplification). Higher values
 *                        produce more abstract / generalised shapes.
 */

import { simplifyPolygon } from './contour.js';

export const DEFAULT_TILE_SIZE = 256;
export const DEFAULT_LABEL_TIER_THRESHOLD = 'heavy';
export const RENDER_MODES = Object.freeze(['fill', 'line', 'fill+line']);
export const COLOR_MODES = Object.freeze(['tier', 'mono']);

/** Tier → palette entry. Hue stays consistent across modes. */
export const TIER_PALETTE = Object.freeze({
  light:        { stroke: 'hsl(220, 80%, 65%)', fill: 'hsl(220, 80%, 60%)', fillOpacity: 0.10, strokeWidth: 1.0, dashed: false },
  moderate:     { stroke: 'hsl(140, 70%, 50%)', fill: 'hsl(140, 70%, 45%)', fillOpacity: 0.14, strokeWidth: 1.2, dashed: false },
  heavy:        { stroke: 'hsl(30,  90%, 55%)', fill: 'hsl(30,  90%, 50%)', fillOpacity: 0.18, strokeWidth: 1.4, dashed: false },
  severe:       { stroke: 'hsl(0,   90%, 55%)', fill: 'hsl(0,   90%, 50%)', fillOpacity: 0.20, strokeWidth: 1.7, dashed: false },
  thunderstorm: { stroke: 'hsl(305, 95%, 60%)', fill: 'hsl(305, 95%, 55%)', fillOpacity: 0.22, strokeWidth: 1.9, dashed: true  },
});

const TIER_RANK = Object.freeze({ light: 0, moderate: 1, heavy: 2, severe: 3, thunderstorm: 4 });

const TIER_LABEL = Object.freeze({
  light: 'LIGHT',
  moderate: 'MODERATE',
  heavy: 'HEAVY',
  severe: 'SEVERE',
  thunderstorm: 'T-STORM',
});

export function buildTopologyRenderItems(topology, options = {}) {
  if (!topology || !Array.isArray(topology.clouds) || !topology.frame?.grid) {
    return [];
  }
  const {
    tileSize = DEFAULT_TILE_SIZE,
    showLabels = false,
    labelTierMin = DEFAULT_LABEL_TIER_THRESHOLD,
    renderMode = 'fill+line',
    colorMode = 'tier',
    simplifyTolerance = 0,
  } = options;

  const mode = RENDER_MODES.includes(renderMode) ? renderMode : 'fill+line';
  const colour = COLOR_MODES.includes(colorMode) ? colorMode : 'tier';
  const tolerance = Number.isFinite(simplifyTolerance) && simplifyTolerance > 0
    ? simplifyTolerance
    : 0;

  const { width: gW, height: gH } = topology.frame.grid;
  if (!gW || !gH || gW < 2 || gH < 2) return [];

  const sx = tileSize / (gW - 1);
  const sy = tileSize / (gH - 1);
  const project = ([px, py]) => [px * sx, py * sy];

  const baseThreshold = topology.thresholds?.rainMmPerHour?.[0] ?? null;
  const items = [];

  for (const cloud of topology.clouds) {
    const palette = TIER_PALETTE[cloud.severity?.tier] ?? TIER_PALETTE.light;
    const score = clamp01(cloud.severity?.score ?? 0);

    // Resolve colours for this cloud per the chosen colorMode.
    // mono: white with severity-driven opacity so all tiers read the same
    // shape language; severity is communicated by intensity alone.
    const tierStroke = colour === 'tier' ? palette.stroke : 'hsl(0, 0%, 100%)';
    const tierFill   = colour === 'tier' ? palette.fill   : 'hsl(0, 0%, 100%)';
    const tierFillOpacity = colour === 'tier'
      ? palette.fillOpacity
      : 0.08 + 0.32 * score;        // 0.08..0.40 across the score range
    const tierStrokeOpacity = colour === 'tier'
      ? 1
      : 0.25 + 0.65 * score;        // 0.25..0.90 — heavy enough to read

    const hasFill = mode === 'fill' || mode === 'fill+line';
    const hasStroke = mode === 'line' || mode === 'fill+line';

    for (const level of cloud.levels) {
      const isEnvelope = level.thresholdMmPerHour === baseThreshold;
      for (const poly of level.polygons) {
        if (!Array.isArray(poly) || poly.length < 3) continue;
        let projected = poly.map(project);
        if (tolerance > 0 && projected.length > 3) {
          // Douglas–Peucker simplification on the projected (tile-pixel)
          // coordinates so the tolerance is in screen units, not in
          // grid units — same tolerance reads consistently across zooms.
          // Close the ring before simplifying so the algorithm sees the
          // first vertex as a fixed anchor, then strip the closing dup.
          const closed = [...projected, projected[0]];
          const simplified = simplifyPolygon(closed, tolerance);
          if (simplified.length >= 4) {
            simplified.pop();
            projected = simplified;
          }
        }
        const d = polygonToPath(projected);
        items.push({
          type: 'polygon',
          cloudId: cloud.id,
          tier: cloud.severity.tier,
          kind: isEnvelope ? 'envelope' : 'core',
          threshold: level.thresholdMmPerHour,
          d,
          stroke: hasStroke ? tierStroke : 'none',
          strokeWidth: hasStroke ? palette.strokeWidth + (isEnvelope ? 0 : 0.4) : 0,
          strokeOpacity: hasStroke ? tierStrokeOpacity : 0,
          // Only the envelope gets a fill — cores are stroked-only by
          // convention so the nested-isobar look survives any colorMode.
          fill: hasFill && isEnvelope ? tierFill : 'none',
          fillOpacity: hasFill && isEnvelope ? tierFillOpacity : 0,
          dashed: palette.dashed,
        });
      }
    }

    const tierRank = TIER_RANK[cloud.severity.tier] ?? 0;
    const minRank = TIER_RANK[labelTierMin] ?? TIER_RANK.heavy;
    if (showLabels && tierRank >= minRank && cloud.centroid) {
      const [cx, cy] = project(cloud.centroid);
      items.push({
        type: 'label',
        cloudId: cloud.id,
        tier: cloud.severity.tier,
        x: cx,
        y: cy,
        text: TIER_LABEL[cloud.severity.tier] ?? cloud.severity.tier.toUpperCase(),
        stroke: colour === 'tier' ? palette.stroke : 'hsl(0, 0%, 100%)',
      });
    }
  }

  return items;
}

function polygonToPath(points) {
  if (points.length === 0) return '';
  let d = `M ${fmt(points[0][0])} ${fmt(points[0][1])}`;
  for (let i = 1; i < points.length; i++) {
    d += ` L ${fmt(points[i][0])} ${fmt(points[i][1])}`;
  }
  d += ' Z';
  return d;
}

function fmt(n) {
  return Number(n.toFixed(2));
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
