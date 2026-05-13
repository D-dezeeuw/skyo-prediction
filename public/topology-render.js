/**
 * Pure helpers for rendering a Topology object as SVG items on the
 * Leaflet map's tile-pixel viewBox.
 *
 *   buildTopologyRenderItems(topology, { tileSize, showLabels }) →
 *     array of { type: 'polygon' | 'label', ... }
 *
 * Each cloud's polygons in grid-pixel coords are projected to
 * tile-pixel coords (the SVG viewBox is 0..tileSize on each axis).
 * The renderer caller in map.js iterates this list and creates
 * `<path>` and `<text>` elements — keeping the DOM construction out
 * of this module so it stays unit-testable in plain Node.
 *
 * Visual conventions:
 *   envelope  — outer (lightest) threshold; stroked + filled at low alpha
 *   core      — inner threshold; stroked only, weight scales with threshold
 *   label     — centroid badge for tiers ≥ heavy (and ≥ a min size)
 *   tier hue  — light blue → moderate green → heavy orange → severe red
 *               → thunderstorm magenta with `dashed: true`
 */

export const DEFAULT_TILE_SIZE = 256;
export const DEFAULT_LABEL_TIER_THRESHOLD = 'heavy';

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
    showLabels = true,
    labelTierMin = DEFAULT_LABEL_TIER_THRESHOLD,
  } = options;

  const { width: gW, height: gH } = topology.frame.grid;
  if (!gW || !gH || gW < 2 || gH < 2) return [];

  const sx = tileSize / (gW - 1);
  const sy = tileSize / (gH - 1);
  const project = ([px, py]) => [px * sx, py * sy];

  const baseThreshold = topology.thresholds?.rainMmPerHour?.[0] ?? null;
  const items = [];

  for (const cloud of topology.clouds) {
    const palette = TIER_PALETTE[cloud.severity?.tier] ?? TIER_PALETTE.light;

    for (const level of cloud.levels) {
      const isEnvelope = level.thresholdMmPerHour === baseThreshold;
      for (const poly of level.polygons) {
        if (!Array.isArray(poly) || poly.length < 3) continue;
        const projected = poly.map(project);
        const d = polygonToPath(projected);
        items.push({
          type: 'polygon',
          cloudId: cloud.id,
          tier: cloud.severity.tier,
          kind: isEnvelope ? 'envelope' : 'core',
          threshold: level.thresholdMmPerHour,
          d,
          stroke: palette.stroke,
          strokeWidth: palette.strokeWidth + (isEnvelope ? 0 : 0.4),
          fill: isEnvelope ? palette.fill : 'none',
          fillOpacity: isEnvelope ? palette.fillOpacity : 0,
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
        stroke: palette.stroke,
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
