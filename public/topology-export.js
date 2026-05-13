/**
 * Pure helpers that prepare downloadable artefacts from the cloud-
 * topology data product. The DOM-mutating part (creating an anchor,
 * clicking it, revoking the object URL) lives in app.js where it
 * belongs; this module is unit-testable in plain Node.
 *
 *   prepareTopologyExport(topology) → { filename, content, mimeType }
 *   prepareTopologyTimelineExport(topologies, opts) →
 *     { filename, content, mimeType }
 *
 * `content` is a JSON string with 2-space indent so consumers (and
 * humans) can diff the file directly. `filename` is built from the
 * frame timestamp so multiple exports from one session don't collide.
 */

import { toGeoJSON, toGeoJSONTimeline } from './topology-geojson.js';

export const MIME_TYPE = 'application/geo+json';
export const TIMELINE_MIME_TYPE = 'application/json';

export function prepareTopologyExport(topology, options = {}) {
  if (!topology || !topology.frame) {
    throw new Error('prepareTopologyExport: topology with frame required');
  }
  const fc = toGeoJSON(topology, options);
  return {
    filename: formatFrameFilename(topology.frame.time, topology.frame.kind),
    content: JSON.stringify(fc, null, 2),
    mimeType: MIME_TYPE,
  };
}

export function prepareTopologyTimelineExport(topologies, options = {}) {
  if (!Array.isArray(topologies)) {
    throw new Error('prepareTopologyTimelineExport: topologies must be an array');
  }
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const wrapper = toGeoJSONTimeline(topologies, { ...options, generatedAt });
  return {
    filename: formatTimelineFilename(generatedAt),
    content: JSON.stringify(wrapper, null, 2),
    mimeType: TIMELINE_MIME_TYPE,
  };
}

export function formatFrameFilename(frameTime, kind = 'observed') {
  const stamp = sanitizeStamp(frameTime ?? new Date().toISOString());
  const kindTag = kind === 'forecast' ? 'forecast-' : kind === 'interpolated' ? 'interp-' : '';
  return `skyo-topology-${kindTag}${stamp}.geojson`;
}

export function formatTimelineFilename(generatedAt) {
  const stamp = sanitizeStamp(generatedAt);
  return `skyo-topology-timeline-${stamp}.json`;
}

function sanitizeStamp(stamp) {
  return String(stamp).replace(/[:.]/g, '-').replace(/[^0-9A-Za-z_-]/g, '_');
}
