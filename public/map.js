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
import { tileBounds } from './vectors.js';

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

  // Decode tile bounds drive both the map view AND the vectors overlay
  // anchor. Locking the map to these bounds is what makes "decoded
  // grids match the flow field": you can pan/zoom inside the tile but
  // never out of the area we have decoded grids for.
  const tileX = frameOptions?.x ?? 16;
  const tileY = frameOptions?.y ?? 10;
  const tileZ = frameOptions?.zoom ?? 5;
  const tileSize = frameOptions?.size ?? 256;
  const bounds = tileBounds(tileX, tileY, tileZ);
  const latLngBounds = L.latLngBounds(
    L.latLng(bounds.latBottom, bounds.lonLeft),
    L.latLng(bounds.latTop, bounds.lonRight),
  );

  const map = L.map(el, {
    zoomControl: true,
    attributionControl: true,
    minZoom: tileZ,
    maxZoom: 10,
    maxBounds: latLngBounds.pad(0.05),
    maxBoundsViscosity: 1.0,
  });
  map.fitBounds(latLngBounds);

  const baseCfg = BASE_STYLES.dark;
  L.tileLayer(baseCfg.url, baseCfg).addTo(map);

  let radarLayers = [];
  let currentIdx = -1;
  let visible = true;
  let opacity = 0.8;

  const vectorsSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  vectorsSvg.setAttribute('viewBox', `0 0 ${tileSize} ${tileSize}`);
  vectorsSvg.setAttribute('preserveAspectRatio', 'none');
  vectorsSvg.style.pointerEvents = 'none';
  const vectorsOverlay = L.svgOverlay(vectorsSvg, latLngBounds, {
    opacity: 0,
    interactive: false,
  }).addTo(map);
  let vectorsVisible = true;
  let vectorsOpacity = 0.9;

  const applyOpacity = () => {
    if (currentIdx < 0 || !radarLayers[currentIdx]) return;
    radarLayers[currentIdx].setOpacity(visible ? opacity : 0);
  };
  const applyVectorsOpacity = () => {
    vectorsOverlay.setOpacity(vectorsVisible ? vectorsOpacity : 0);
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
    setVectors(arrows) {
      while (vectorsSvg.firstChild) vectorsSvg.removeChild(vectorsSvg.firstChild);
      for (const a of arrows) {
        const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        p.setAttribute('d', a.d);
        p.setAttribute('stroke', a.color);
        p.setAttribute('stroke-width', '1.2');
        p.setAttribute('stroke-linecap', 'round');
        p.setAttribute('fill', 'none');
        vectorsSvg.appendChild(p);
      }
      applyVectorsOpacity();
    },
    setVectorsOpacity(v) {
      vectorsOpacity = Math.max(0, Math.min(1, v));
      applyVectorsOpacity();
    },
    setVectorsVisible(v) {
      vectorsVisible = Boolean(v);
      applyVectorsOpacity();
    },
    destroy() {
      map.remove();
      radarLayers = [];
    },
  };
}
/* node:coverage enable */
