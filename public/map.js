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
import { encodeTrendToRgba } from './trend.js';
import { encodeConfidenceToRgba } from './confidence.js';
import { encodeOmegaToRgba } from './omega.js';
import { encodeCapeToRgba } from './cape.js';
import { encodeThunderstormToRgba } from './thunderstorm.js';
import { encodeProbabilityToRgba } from './ensemble.js';

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

  // Trend overlay (diverging-colour heatmap). Same canvas-render-to-
  // data-URL approach as the radar; lives between radar and vectors
  // in z-order so the rain still reads through.
  const trendCanvas = document.createElement('canvas');
  trendCanvas.width = tileSize;
  trendCanvas.height = tileSize;
  const trendOverlay = L.imageOverlay(transparentPng, latLngBounds, {
    opacity: 0,
    interactive: false,
  }).addTo(map);
  let trendVisible = false;
  let trendOpacity = 0.65;
  let trendKey = null;

  // Confidence overlay (yellow→red heatmap of two-member forecast
  // disagreement). Stacks above trend, below vectors.
  const confidenceCanvas = document.createElement('canvas');
  confidenceCanvas.width = tileSize;
  confidenceCanvas.height = tileSize;
  const confidenceOverlay = L.imageOverlay(transparentPng, latLngBounds, {
    opacity: 0,
    interactive: false,
  }).addTo(map);
  let confidenceVisible = false;
  let confidenceOpacity = 0.7;
  let confidenceKey = null;

  // Omega overlay (synoptic 850-hPa vertical-velocity field, green for
  // rising / purple for sinking). Stacks above trend, below confidence.
  const omegaCanvas = document.createElement('canvas');
  omegaCanvas.width = tileSize;
  omegaCanvas.height = tileSize;
  const omegaOverlay = L.imageOverlay(transparentPng, latLngBounds, {
    opacity: 0,
    interactive: false,
  }).addTo(map);
  let omegaVisible = false;
  let omegaOpacity = 0.65;
  let omegaKey = null;

  // CAPE overlay (sequential orange→red for instability magnitude).
  const capeCanvas = document.createElement('canvas');
  capeCanvas.width = tileSize;
  capeCanvas.height = tileSize;
  const capeOverlay = L.imageOverlay(transparentPng, latLngBounds, {
    opacity: 0,
    interactive: false,
  }).addTo(map);
  let capeVisible = false;
  let capeOpacity = 0.65;
  let capeKey = null;

  // Thunderstorm-risk overlay (pinky-red — the strongest visual cue;
  // sits on top of the data overlays, below vectors).
  const thunderCanvas = document.createElement('canvas');
  thunderCanvas.width = tileSize;
  thunderCanvas.height = tileSize;
  const thunderOverlay = L.imageOverlay(transparentPng, latLngBounds, {
    opacity: 0,
    interactive: false,
  }).addTo(map);
  let thunderVisible = false;
  let thunderOpacity = 0.75;
  let thunderKey = null;

  // Probability-of-rain overlay (sequential blue→cyan→yellow). Lives
  // just below vectors so it can dominate when toggled on.
  const probabilityCanvas = document.createElement('canvas');
  probabilityCanvas.width = tileSize;
  probabilityCanvas.height = tileSize;
  const probabilityOverlay = L.imageOverlay(transparentPng, latLngBounds, {
    opacity: 0,
    interactive: false,
  }).addTo(map);
  let probabilityVisible = false;
  let probabilityOpacity = 0.7;
  let probabilityKey = null;

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

  // Cloud topology overlay (SVG polygons + tier badges). Sits on top
  // of the radar / data overlays — the whole point of vector polygons
  // is they read at a glance over whatever heatmap is below.
  const topologySvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  topologySvg.setAttribute('viewBox', `0 0 ${tileSize} ${tileSize}`);
  topologySvg.setAttribute('preserveAspectRatio', 'none');
  topologySvg.style.pointerEvents = 'none';
  const topologyOverlay = L.svgOverlay(topologySvg, latLngBounds, {
    opacity: 0,
    interactive: false,
  }).addTo(map);
  let topologyVisible = true;
  let topologyOpacity = 0.85;

  const applyRadarOpacity = () => {
    radarOverlay.setOpacity(radarVisible ? radarOpacity : 0);
  };
  const applyTrendOpacity = () => {
    trendOverlay.setOpacity(trendVisible ? trendOpacity : 0);
  };
  const applyConfidenceOpacity = () => {
    confidenceOverlay.setOpacity(confidenceVisible ? confidenceOpacity : 0);
  };
  const applyOmegaOpacity = () => {
    omegaOverlay.setOpacity(omegaVisible ? omegaOpacity : 0);
  };
  const applyCapeOpacity = () => {
    capeOverlay.setOpacity(capeVisible ? capeOpacity : 0);
  };
  const applyThunderOpacity = () => {
    thunderOverlay.setOpacity(thunderVisible ? thunderOpacity : 0);
  };
  const applyProbabilityOpacity = () => {
    probabilityOverlay.setOpacity(probabilityVisible ? probabilityOpacity : 0);
  };
  const applyVectorsOpacity = () => {
    vectorsOverlay.setOpacity(vectorsVisible ? vectorsOpacity : 0);
  };
  const applyTopologyOpacity = () => {
    topologyOverlay.setOpacity(topologyVisible ? topologyOpacity : 0);
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
    /**
     * Render a Float32 trend grid (mm/h per frame-interval) into the
     * trend overlay. Same dedupe-by-key pattern as renderFrame.
     */
    renderTrend(grid, width, height, key = null) {
      if (!grid) return;
      if (key !== null && key === trendKey) {
        applyTrendOpacity();
        return;
      }
      if (width !== trendCanvas.width || height !== trendCanvas.height) {
        trendCanvas.width = width;
        trendCanvas.height = height;
      }
      const ctx = trendCanvas.getContext('2d');
      const imageData = ctx.createImageData(width, height);
      imageData.data.set(encodeTrendToRgba(grid, width, height));
      ctx.putImageData(imageData, 0, 0);
      trendOverlay.setUrl(trendCanvas.toDataURL('image/png'));
      trendKey = key;
      applyTrendOpacity();
    },
    setTrendOpacity(v) {
      trendOpacity = Math.max(0, Math.min(1, v));
      applyTrendOpacity();
    },
    setTrendVisible(v) {
      trendVisible = Boolean(v);
      applyTrendOpacity();
    },
    /** Render the forecast-disagreement field. Same key dedupe pattern. */
    renderConfidence(grid, width, height, key = null) {
      if (!grid) return;
      if (key !== null && key === confidenceKey) {
        applyConfidenceOpacity();
        return;
      }
      if (width !== confidenceCanvas.width || height !== confidenceCanvas.height) {
        confidenceCanvas.width = width;
        confidenceCanvas.height = height;
      }
      const ctx = confidenceCanvas.getContext('2d');
      const imageData = ctx.createImageData(width, height);
      imageData.data.set(encodeConfidenceToRgba(grid, width, height));
      ctx.putImageData(imageData, 0, 0);
      confidenceOverlay.setUrl(confidenceCanvas.toDataURL('image/png'));
      confidenceKey = key;
      applyConfidenceOpacity();
    },
    setConfidenceOpacity(v) {
      confidenceOpacity = Math.max(0, Math.min(1, v));
      applyConfidenceOpacity();
    },
    setConfidenceVisible(v) {
      confidenceVisible = Boolean(v);
      applyConfidenceOpacity();
    },
    /** Render the synoptic omega field. Same key dedupe pattern. */
    renderOmega(grid, width, height, key = null) {
      if (!grid) return;
      if (key !== null && key === omegaKey) {
        applyOmegaOpacity();
        return;
      }
      if (width !== omegaCanvas.width || height !== omegaCanvas.height) {
        omegaCanvas.width = width;
        omegaCanvas.height = height;
      }
      const ctx = omegaCanvas.getContext('2d');
      const imageData = ctx.createImageData(width, height);
      imageData.data.set(encodeOmegaToRgba(grid, width, height));
      ctx.putImageData(imageData, 0, 0);
      omegaOverlay.setUrl(omegaCanvas.toDataURL('image/png'));
      omegaKey = key;
      applyOmegaOpacity();
    },
    setOmegaOpacity(v) {
      omegaOpacity = Math.max(0, Math.min(1, v));
      applyOmegaOpacity();
    },
    setOmegaVisible(v) {
      omegaVisible = Boolean(v);
      applyOmegaOpacity();
    },
    renderCape(grid, width, height, key = null) {
      if (!grid) return;
      if (key !== null && key === capeKey) {
        applyCapeOpacity();
        return;
      }
      if (width !== capeCanvas.width || height !== capeCanvas.height) {
        capeCanvas.width = width;
        capeCanvas.height = height;
      }
      const ctx = capeCanvas.getContext('2d');
      const imageData = ctx.createImageData(width, height);
      imageData.data.set(encodeCapeToRgba(grid, width, height));
      ctx.putImageData(imageData, 0, 0);
      capeOverlay.setUrl(capeCanvas.toDataURL('image/png'));
      capeKey = key;
      applyCapeOpacity();
    },
    setCapeOpacity(v) {
      capeOpacity = Math.max(0, Math.min(1, v));
      applyCapeOpacity();
    },
    setCapeVisible(v) {
      capeVisible = Boolean(v);
      applyCapeOpacity();
    },
    renderThunder(grid, width, height, key = null) {
      if (!grid) return;
      if (key !== null && key === thunderKey) {
        applyThunderOpacity();
        return;
      }
      if (width !== thunderCanvas.width || height !== thunderCanvas.height) {
        thunderCanvas.width = width;
        thunderCanvas.height = height;
      }
      const ctx = thunderCanvas.getContext('2d');
      const imageData = ctx.createImageData(width, height);
      imageData.data.set(encodeThunderstormToRgba(grid, width, height));
      ctx.putImageData(imageData, 0, 0);
      thunderOverlay.setUrl(thunderCanvas.toDataURL('image/png'));
      thunderKey = key;
      applyThunderOpacity();
    },
    setThunderOpacity(v) {
      thunderOpacity = Math.max(0, Math.min(1, v));
      applyThunderOpacity();
    },
    setThunderVisible(v) {
      thunderVisible = Boolean(v);
      applyThunderOpacity();
    },
    renderProbability(grid, width, height, key = null) {
      if (!grid) return;
      if (key !== null && key === probabilityKey) {
        applyProbabilityOpacity();
        return;
      }
      if (width !== probabilityCanvas.width || height !== probabilityCanvas.height) {
        probabilityCanvas.width = width;
        probabilityCanvas.height = height;
      }
      const ctx = probabilityCanvas.getContext('2d');
      const imageData = ctx.createImageData(width, height);
      imageData.data.set(encodeProbabilityToRgba(grid, width, height));
      ctx.putImageData(imageData, 0, 0);
      probabilityOverlay.setUrl(probabilityCanvas.toDataURL('image/png'));
      probabilityKey = key;
      applyProbabilityOpacity();
    },
    setProbabilityOpacity(v) {
      probabilityOpacity = Math.max(0, Math.min(1, v));
      applyProbabilityOpacity();
    },
    setProbabilityVisible(v) {
      probabilityVisible = Boolean(v);
      applyProbabilityOpacity();
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
    setTopology(items) {
      while (topologySvg.firstChild) topologySvg.removeChild(topologySvg.firstChild);
      if (!items || items.length === 0) {
        applyTopologyOpacity();
        return;
      }
      for (const item of items) {
        if (item.type === 'polygon') {
          const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          p.setAttribute('d', item.d);
          p.setAttribute('stroke', item.stroke);
          p.setAttribute('stroke-width', String(item.strokeWidth ?? 1.2));
          if (item.strokeOpacity != null && item.strokeOpacity < 1) {
            p.setAttribute('stroke-opacity', String(item.strokeOpacity));
          }
          p.setAttribute('stroke-linejoin', 'round');
          p.setAttribute('stroke-linecap', 'round');
          p.setAttribute('fill', item.fill ?? 'none');
          if (item.fill && item.fill !== 'none') {
            p.setAttribute('fill-opacity', String(item.fillOpacity ?? 0.18));
          }
          if (item.dashed) {
            p.setAttribute('stroke-dasharray', '4 3');
          }
          topologySvg.appendChild(p);
        } else if (item.type === 'label') {
          const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
          text.setAttribute('x', String(item.x));
          text.setAttribute('y', String(item.y));
          text.setAttribute('text-anchor', 'middle');
          text.setAttribute('dominant-baseline', 'middle');
          text.setAttribute('font-size', '10');
          text.setAttribute('font-weight', '700');
          text.setAttribute('font-family', 'system-ui, sans-serif');
          text.setAttribute('fill', item.stroke);
          text.setAttribute('stroke', '#0008');
          text.setAttribute('stroke-width', '0.4');
          text.setAttribute('paint-order', 'stroke');
          text.textContent = item.text;
          topologySvg.appendChild(text);
        }
      }
      applyTopologyOpacity();
    },
    setTopologyOpacity(v) {
      topologyOpacity = Math.max(0, Math.min(1, v));
      applyTopologyOpacity();
    },
    setTopologyVisible(v) {
      topologyVisible = Boolean(v);
      applyTopologyOpacity();
    },
    destroy() {
      map.remove();
    },
  };
}
/* node:coverage enable */
