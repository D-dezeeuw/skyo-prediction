/**
 * GeoJSON adapter for the cloud Topology object.
 *
 *   toGeoJSON(topology, { generatedAt?, bbox? }) → FeatureCollection
 *   fromGeoJSON(fc) → Topology  (strict schema check)
 *   toGeoJSONTimeline(topologies, { tile?, bbox?, generatedAt? }) →
 *     { schema: 'skyo.cloud-topology-timeline/1', frames: [...] }
 *
 * One Cloud emits multiple Features sharing `properties.cloudId`:
 *   - one envelope Polygon per polygon at the lowest threshold (full
 *     driver metadata, score, tier, areaKm2)
 *   - zero or more core Polygons at higher thresholds (minimal metadata)
 *   - one centroid Point with motion (bearingDegrees + speedKmPerHour)
 *
 * Coordinates are `[lng, lat]` per GeoJSON spec; rings are closed
 * (first vertex repeated as last); area uses the spherical-excess
 * formula so it's correct at any latitude.
 *
 * The timeline wrapper preserves each frame as a standalone GeoJSON
 * FeatureCollection — tools that don't know about the timeline can
 * still render any individual frame.
 *
 * Pure functions only.
 */

import { polygonToLatLng } from './contour.js';

export const SCHEMA = 'skyo.cloud-topology/1';
export const TIMELINE_SCHEMA = 'skyo.cloud-topology-timeline/1';
export const TIERS = Object.freeze(['light', 'moderate', 'heavy', 'severe', 'thunderstorm']);
const EARTH_RADIUS_KM = 6371.0088;

export function toGeoJSON(topology, options = {}) {
  if (!topology || !topology.frame || !Array.isArray(topology.clouds) || !topology.thresholds) {
    throw new Error('toGeoJSON: invalid topology');
  }
  const { tile, grid: gridDims } = topology.frame;
  if (!tile || !Number.isInteger(tile.x) || !Number.isInteger(tile.y) || !Number.isInteger(tile.z)) {
    throw new Error('toGeoJSON: topology.frame.tile must be { x, y, z } integers');
  }
  if (!gridDims || !Number.isInteger(gridDims.width) || !Number.isInteger(gridDims.height)) {
    throw new Error('toGeoJSON: topology.frame.grid must be { width, height } integers');
  }
  const { generatedAt = new Date().toISOString(), bbox = null } = options;
  const baseThreshold = topology.thresholds.rainMmPerHour[0];

  const features = [];
  for (const cloud of topology.clouds) {
    const envLevel = cloud.levels.find((l) => l.thresholdMmPerHour === baseThreshold) ?? cloud.levels[0];

    if (envLevel) {
      for (let i = 0; i < envLevel.polygons.length; i++) {
        const polyLL = projectAndClose(envLevel.polygons[i], tile, gridDims);
        if (!polyLL) continue;
        features.push({
          type: 'Feature',
          id: `${cloud.id}__envelope${i ? `_${i}` : ''}`,
          geometry: { type: 'Polygon', coordinates: [polyLL] },
          properties: {
            kind: 'envelope',
            cloudId: cloud.id,
            thresholdMmPerHour: envLevel.thresholdMmPerHour,
            tier: cloud.severity.tier,
            score: cloud.severity.score,
            areaKm2: ringAreaKm2(polyLL),
            drivers: { ...cloud.severity.drivers },
          },
        });
      }
    }

    for (const level of cloud.levels) {
      if (envLevel && level.thresholdMmPerHour === envLevel.thresholdMmPerHour) continue;
      for (let i = 0; i < level.polygons.length; i++) {
        const polyLL = projectAndClose(level.polygons[i], tile, gridDims);
        if (!polyLL) continue;
        features.push({
          type: 'Feature',
          id: `${cloud.id}__core_${level.thresholdMmPerHour}${i ? `_${i}` : ''}`,
          geometry: { type: 'Polygon', coordinates: [polyLL] },
          properties: {
            kind: 'core',
            cloudId: cloud.id,
            thresholdMmPerHour: level.thresholdMmPerHour,
            tier: cloud.severity.tier,
          },
        });
      }
    }

    const [centroidLng, centroidLat] = polygonToLatLng([cloud.centroid], tile, gridDims.width, gridDims.height)[0];
    const motionProps = motionToProps(cloud.motion, centroidLat, gridDims, tile, topology.frame.intervalMinutes);
    features.push({
      type: 'Feature',
      id: `${cloud.id}__centroid`,
      geometry: { type: 'Point', coordinates: [centroidLng, centroidLat] },
      properties: {
        kind: 'centroid',
        cloudId: cloud.id,
        tier: cloud.severity.tier,
        ...motionProps,
      },
    });
  }

  const skyo = {
    schema: SCHEMA,
    generatedAt,
    frame: cloneFrame(topology.frame),
    thresholds: { rainMmPerHour: [...topology.thresholds.rainMmPerHour], minAreaCells: topology.thresholds.minAreaCells },
    tiers: [...TIERS],
  };
  if (bbox) skyo.bbox = { ...bbox };

  return { type: 'FeatureCollection', skyo, features };
}

export function fromGeoJSON(fc) {
  if (!fc || fc.type !== 'FeatureCollection' || !fc.skyo) {
    throw new Error('fromGeoJSON: not a FeatureCollection with a skyo extension');
  }
  if (fc.skyo.schema !== SCHEMA) {
    throw new Error(`fromGeoJSON: schema mismatch (expected ${SCHEMA}, got ${fc.skyo.schema})`);
  }
  if (!Array.isArray(fc.features)) {
    throw new Error('fromGeoJSON: features must be an array');
  }

  const byCloudId = new Map();
  for (const f of fc.features) {
    const cid = f?.properties?.cloudId;
    if (!cid) throw new Error('fromGeoJSON: feature missing properties.cloudId');
    if (!byCloudId.has(cid)) byCloudId.set(cid, []);
    byCloudId.get(cid).push(f);
  }

  const clouds = [];
  for (const [id, feats] of byCloudId) {
    const levelsMap = new Map();
    let centroid = null;
    let severity = null;
    let motion = null;
    for (const f of feats) {
      const kind = f.properties.kind;
      if (kind === 'envelope' || kind === 'core') {
        const t = f.properties.thresholdMmPerHour;
        if (!levelsMap.has(t)) levelsMap.set(t, []);
        const ring = stripClosingVertex(f.geometry.coordinates[0]);
        levelsMap.get(t).push(ring.map(([x, y]) => [x, y]));
        if (kind === 'envelope' && !severity) {
          severity = {
            tier: f.properties.tier,
            score: f.properties.score,
            drivers: { ...(f.properties.drivers || {}) },
          };
        }
      } else if (kind === 'centroid') {
        centroid = [f.geometry.coordinates[0], f.geometry.coordinates[1]];
        if (Number.isFinite(f.properties.bearingDegrees)) {
          motion = {
            bearingDegrees: f.properties.bearingDegrees,
            speedKmPerHour: f.properties.speedKmPerHour ?? null,
          };
        }
      }
    }
    const levels = [...levelsMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, polygons]) => ({ thresholdMmPerHour: t, polygons }));
    clouds.push({ id, levels, centroid, severity, motion });
  }

  return {
    frame: cloneFrame(fc.skyo.frame),
    thresholds: {
      rainMmPerHour: [...fc.skyo.thresholds.rainMmPerHour],
      minAreaCells: fc.skyo.thresholds.minAreaCells,
    },
    clouds,
  };
}

export function toGeoJSONTimeline(topologies, options = {}) {
  if (!Array.isArray(topologies)) {
    throw new Error('toGeoJSONTimeline: topologies must be an array');
  }
  const { generatedAt = new Date().toISOString(), tile = null, bbox = null } = options;
  const out = {
    schema: TIMELINE_SCHEMA,
    generatedAt,
    frames: topologies.map((t) => toGeoJSON(t, { generatedAt, bbox })),
  };
  if (tile) out.tile = { ...tile };
  if (bbox) out.bbox = { ...bbox };
  return out;
}

function projectAndClose(polygon, tile, gridDims) {
  if (!Array.isArray(polygon) || polygon.length < 3) return null;
  const ring = polygonToLatLng(polygon, tile, gridDims.width, gridDims.height);
  if (ring.length === 0) return null;
  ring.push([ring[0][0], ring[0][1]]);
  return ring;
}

function stripClosingVertex(ring) {
  if (!Array.isArray(ring) || ring.length < 2) return ring;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  if (fx === lx && fy === ly) return ring.slice(0, -1);
  return ring;
}

/**
 * Spherical-excess area for a small polygon ring on the WGS84 sphere.
 * Adequate for radar-tile-sized polygons (< 1° per side); accurate to
 * better than 0.1% well past city scale.
 */
function ringAreaKm2(ring) {
  if (!Array.isArray(ring) || ring.length < 4) return 0;
  // Standard spherical-excess area (Bevis & Cambareri, 1987):
  //   A = R² · |Σ (λ_{i+1} - λ_{i-1}) · sin(φ_i)| / 2
  let total = 0;
  const m = ring.length - 1; // last is duplicate of first
  for (let i = 0; i < m; i++) {
    const prev = ring[(i - 1 + m) % m];
    const next = ring[(i + 1) % m];
    const lon1 = (prev[0] * Math.PI) / 180;
    const lon2 = (next[0] * Math.PI) / 180;
    const lat = (ring[i][1] * Math.PI) / 180;
    total += (lon2 - lon1) * Math.sin(lat);
  }
  return Math.abs((total * EARTH_RADIUS_KM * EARTH_RADIUS_KM) / 2);
}

function motionToProps(motion, centroidLat, gridDims, tile, intervalMinutes) {
  if (!motion || !Number.isFinite(motion.vx) || !Number.isFinite(motion.vy)) return {};
  // Bearing: 0 = North, 90 = East, 180 = South, 270 = West.
  // Grid +x = east, grid +y = south. So bearing = atan2(vx, -vy).
  let bearing = (Math.atan2(motion.vx, -motion.vy) * 180) / Math.PI;
  if (bearing < 0) bearing += 360;
  // Speed: convert pixels-per-interval → km-per-hour using the tile's
  // longitude span at the centroid's latitude.
  const lonSpanDeg = (360 / 2 ** tile.z);
  const kmPerLngDegAtLat = 111.32 * Math.cos((centroidLat * Math.PI) / 180);
  const kmPerPixel = (lonSpanDeg / (gridDims.width - 1)) * kmPerLngDegAtLat;
  const speedPxPerInterval = Math.hypot(motion.vx, motion.vy);
  const intervalsPerHour = 60 / (Number.isFinite(intervalMinutes) && intervalMinutes > 0 ? intervalMinutes : 10);
  const speedKmPerHour = speedPxPerInterval * kmPerPixel * intervalsPerHour;
  return {
    bearingDegrees: bearing,
    speedKmPerHour,
  };
}

function cloneFrame(frame) {
  return {
    time: frame.time ?? null,
    kind: frame.kind ?? 'observed',
    leadMinutes: Number.isFinite(frame.leadMinutes) ? frame.leadMinutes : 0,
    intervalMinutes: Number.isFinite(frame.intervalMinutes) ? frame.intervalMinutes : 10,
    tile: { x: frame.tile.x, y: frame.tile.y, z: frame.tile.z },
    grid: { width: frame.grid.width, height: frame.grid.height },
  };
}
