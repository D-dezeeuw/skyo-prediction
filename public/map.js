/**
 * Browser-only Leaflet wrapper. Mounts a map at a target element and
 * exposes a tiny imperative handle for the rest of the app.
 *
 * The radar overlay is a SINGLE canvas-backed L.imageOverlay; the
 * caller hands us a Float32 mm/h grid via renderFrame(grid, w, h) and
 * we re-encode it via the palette + redraw on demand. One canvas, one
 * overlay, O(1) DOM. Works equally well for observed RainViewer frames,
 * interpolated in-between frames, and forecast frames advected from the
 * latest observation.
 *
 * Pure helpers (tile-bounds math) live elsewhere and are unit-tested.
 */

import { tileBounds } from './vectors.js';
import { encodeRainRateToRgba } from './palette.js';

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

export async function mountMap(el, { view = DEFAULT_VIEW, frameOptions } = {}) {
  const L = await ensureLeaflet();

  const tileX = frameOptions?.x ?? 16;
  const tileY = frameOptions?.y ?? 10;
  const tileZ = frameOptions?.zoom ?? 5;
  const tileSize = frameOptions?.size ?? 256;
  const bounds = tileBounds(tileX, tileY, tileZ);
  const latLngBounds = L.latLngBounds(
    L.latLng(bounds.latBottom, bounds.lonLeft),
    L.latLng(bounds.latTop, bounds.lonRight),
  );

  // maxZoom = tileZ + 2 keeps the radar overlay matched to the decoded
  // grid's effective resolution. At tileZ + 3 and beyond the 512-px
  // grid starts showing visible pixelation against the base-map tiles
  // (which keep loading higher-zoom detail). Cap here for visual
  // consistency between weather data and map data.
  const map = L.map(el, {
    zoomControl: true,
    attributionControl: true,
    minZoom: tileZ,
    maxZoom: tileZ + 2,
    maxBounds: latLngBounds.pad(0.05),
    maxBoundsViscosity: 1.0,
  });
  // fitBounds picks the tightest zoom that still shows the whole tile;
  // bump it by 1 so the default view sits closer in (radar detail more
  // visible, panning still stays inside maxBounds).
  const fitZoom = map.getBoundsZoom(latLngBounds);
  map.setView(latLngBounds.getCenter(), fitZoom + 1);

  L.tileLayer(BASE_STYLES.dark.url, BASE_STYLES.dark).addTo(map);

  // Canvas-backed radar overlay. One canvas, one image overlay; the
  // overlay's image src is a data URL refreshed on every renderFrame().
  const radarCanvas = document.createElement('canvas');
  radarCanvas.width = tileSize;
  radarCanvas.height = tileSize;
  const radarCtx = radarCanvas.getContext('2d');
  const radarImageData = radarCtx.createImageData(tileSize, tileSize);
  const transparentPng = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return c.toDataURL('image/png');
  })();
  const radarOverlay = L.imageOverlay(transparentPng, latLngBounds, {
    opacity: 0,
    interactive: false,
    attribution:
      'Radar &copy; <a href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a>',
  }).addTo(map);

  let radarVisible = true;
  let radarOpacity = 0.8;
  let currentFrameKey = null;

  // Vectors overlay (SVG arrows).
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

  const applyRadarOpacity = () => {
    radarOverlay.setOpacity(radarVisible ? radarOpacity : 0);
  };
  const applyVectorsOpacity = () => {
    vectorsOverlay.setOpacity(vectorsVisible ? vectorsOpacity : 0);
  };

  return {
    /**
     * Render a Float32 mm/h grid into the radar overlay. `key` is an
     * opaque identity tag — pass the same key twice in a row and the
     * second call is a no-op (cheap dedupe for the rAF tick pump).
     */
    renderFrame(grid, width, height, key = null) {
      if (!grid) return;
      if (key !== null && key === currentFrameKey) {
        applyRadarOpacity();
        return;
      }
      // Resize the working canvas if the grid dimensions differ from tile size.
      if (width !== radarCanvas.width || height !== radarCanvas.height) {
        radarCanvas.width = width;
        radarCanvas.height = height;
      }
      const ctx = radarCanvas.getContext('2d');
      const imageData = ctx.createImageData(width, height);
      imageData.data.set(encodeRainRateToRgba(grid, width, height));
      ctx.putImageData(imageData, 0, 0);
      radarOverlay.setUrl(radarCanvas.toDataURL('image/png'));
      currentFrameKey = key;
      applyRadarOpacity();
    },
    clearFrame() {
      radarOverlay.setUrl(transparentPng);
      currentFrameKey = null;
    },
    setOpacity(v) {
      radarOpacity = Math.max(0, Math.min(1, v));
      applyRadarOpacity();
    },
    setVisible(v) {
      radarVisible = Boolean(v);
      applyRadarOpacity();
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
    },
  };
}
/* node:coverage enable */
