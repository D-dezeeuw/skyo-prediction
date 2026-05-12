/**
 * Browser-only Leaflet wrapper. Mounts a map at a target element and
 * exposes a tiny imperative handle for the rest of the app:
 *   - setHistory(framesMeta): pre-create one tileLayer per radar frame
 *   - showFrame(idx): swap which frame is opaque
 *   - setOpacity(opacity): adjust the radar overlay opacity
 *   - setVisible(visible): toggle the radar overlay
 *
 * Pure helpers (URL construction, frame-index clamping) live elsewhere
 * (radar.js, layers.js) and are unit-tested.
 */

import { buildTileUrlTemplate } from './radar.js';

const LEAFLET_VERSION = '1.9.4';
const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
const LEAFLET_JS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet-src.esm.js`;

export const DEFAULT_VIEW = Object.freeze({ lat: 52.1, lon: 5.3, zoom: 6 });

const BASE_STYLES = {
  dark: {
    url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 19,
  },
};

/* node:coverage disable */
let leafletModule = null;

async function ensureLeaflet() {
  if (leafletModule) return leafletModule;
  if (!document.querySelector(`link[href="${LEAFLET_CSS}"]`)) {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = LEAFLET_CSS;
    document.head.appendChild(css);
  }
  const mod = await import(LEAFLET_JS);
  leafletModule = mod.default ?? mod;
  return leafletModule;
}

export async function mountMap(el, { view = DEFAULT_VIEW, host, frameOptions } = {}) {
  const L = await ensureLeaflet();

  const map = L.map(el, {
    zoomControl: true,
    attributionControl: true,
    minZoom: 3,
    maxZoom: 12,
    worldCopyJump: true,
  }).setView([view.lat, view.lon], view.zoom);

  const baseCfg = BASE_STYLES.dark;
  L.tileLayer(baseCfg.url, baseCfg).addTo(map);

  let radarLayers = [];
  let currentIdx = -1;
  let visible = true;
  let opacity = 0.8;

  const applyOpacity = () => {
    if (currentIdx < 0 || !radarLayers[currentIdx]) return;
    radarLayers[currentIdx].setOpacity(visible ? opacity : 0);
  };

  return {
    setHistory(framesMeta) {
      for (const layer of radarLayers) map.removeLayer(layer);
      radarLayers = framesMeta.map((frame) =>
        L.tileLayer(buildTileUrlTemplate(host, frame, frameOptions), {
          opacity: 0,
          maxNativeZoom: 7,
          maxZoom: 12,
          attribution:
            'Radar &copy; <a href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a>',
        }).addTo(map),
      );
      currentIdx = -1;
    },
    showFrame(idx) {
      if (idx === currentIdx) {
        applyOpacity();
        return;
      }
      if (currentIdx >= 0 && radarLayers[currentIdx]) {
        radarLayers[currentIdx].setOpacity(0);
      }
      currentIdx = idx;
      applyOpacity();
    },
    setOpacity(v) {
      opacity = Math.max(0, Math.min(1, v));
      applyOpacity();
    },
    setVisible(v) {
      visible = Boolean(v);
      applyOpacity();
    },
    destroy() {
      map.remove();
      radarLayers = [];
    },
  };
}
/* node:coverage enable */
