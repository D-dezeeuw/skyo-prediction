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
import { encodeRainRateToRgba, bilinearUpsample } from './palette.js';

/** Factor by which the radar grid is bilinearly upsampled before
 *  encoding to the canvas. 2× turns a 512² source grid into a
 *  1024² canvas, so the PNG → Leaflet image-overlay path doesn't
 *  show source pixel structure at close map zooms. */
const RADAR_UPSAMPLE_FACTOR = 2;
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
    // Map-wide kill-switch for tile fade animation. Per-tileLayer
    // fadeAnimation:false isn't enough — Leaflet still applies CSS
    // opacity transitions to individual tile <img> elements during
    // setUrl swaps, which produces the visible "two frames at offset
    // positions" ghosting the user reported on the Precipitation layer.
    fadeAnimation: false,
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

  // RainViewer source tile overlay — raw tiles straight from their CDN,
  // no decode, no smoothing, no upsampling. ONE persistent tileLayer
  // for the lifetime of the map; setUrl swaps the URL template per
  // frame. fadeAnimation:false avoids Leaflet's cross-fade between
  // the old + new tile sets (which produced visible duplicate cells
  // offset by 10-min motion during the transition). updateWhenIdle:
  // false so each setUrl triggers an immediate reload, not deferred.
  // A transparent 1×1 PNG placeholder template means the layer can be
  // created up front and we just swap URLs.
  const transparentTileTemplate = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    return c.toDataURL('image/png');
  })();
  const sourceTileLayer = L.tileLayer(transparentTileTemplate, {
    attribution: 'Radar &copy; <a href="https://www.rainviewer.com" target="_blank" rel="noopener">RainViewer</a>',
    opacity: 0,
    bounds: latLngBounds,
    tileSize: 256,
    crossOrigin: true,
    fadeAnimation: false,
    keepBuffer: 0,
    updateWhenIdle: false,
  }).addTo(map);
  let sourceVisible = false;
  let sourceOpacity = 0.85;
  let sourceCurrentUrl = null;

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
  const applySourceOpacity = () => {
    // When URL is the transparent placeholder, force opacity 0 too —
    // so we don't render a stale frame at low alpha behind the canvas.
    const hasRealTiles = sourceCurrentUrl && sourceCurrentUrl !== transparentTileTemplate;
    sourceTileLayer.setOpacity(sourceVisible && hasRealTiles ? sourceOpacity : 0);
  };
  const swapSourceTileUrl = (urlTemplate) => {
    const next = urlTemplate || transparentTileTemplate;
    if (next === sourceCurrentUrl) return;
    sourceTileLayer.setUrl(next, /* noRedraw */ false);
    sourceCurrentUrl = next;
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
      // 2× bilinear upsample before encoding gives the canvas 4× more
      // pixels than the source grid, so the PNG → image-overlay → CSS-
      // scaled rendering doesn't show source pixel structure at close
      // map zooms. ~10 ms for a 512²→1024² upsample at full alpha.
      const W = width * RADAR_UPSAMPLE_FACTOR;
      const H = height * RADAR_UPSAMPLE_FACTOR;
      const upsampled = RADAR_UPSAMPLE_FACTOR === 1
        ? grid
        : bilinearUpsample(grid, width, height, RADAR_UPSAMPLE_FACTOR);
      if (W !== radarCanvas.width || H !== radarCanvas.height) {
        radarCanvas.width = W;
        radarCanvas.height = H;
      }
      const ctx = radarCanvas.getContext('2d');
      const imageData = ctx.createImageData(W, H);
      imageData.data.set(encodeRainRateToRgba(upsampled, W, H));
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
      if (!grid) {
        // Clear: callers pass null/undefined when the playhead is on a
        // non-forecast slot (the past) so the layer doesn't bleed stale
        // values into observed frames.
        if (confidenceKey !== null) {
          confidenceOverlay.setUrl(transparentPng);
          confidenceKey = null;
        }
        applyConfidenceOpacity();
        return;
      }
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
      if (!grid) {
        // Clear when scrubbing past the forecast window — keeps the
        // probability layer aligned with the playhead instead of
        // bleeding the last-rendered frame into observed slots.
        if (probabilityKey !== null) {
          probabilityOverlay.setUrl(transparentPng);
          probabilityKey = null;
        }
        applyProbabilityOpacity();
        return;
      }
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
    /** Point the source-tile layer at a new URL template (or null to
     *  clear it — used for forecast slots RainViewer doesn't publish).
     *  Same URL twice in a row is a no-op. Uses setUrl + fadeAnimation:
     *  false on the persistent tileLayer instead of remove/add, so old
     *  + new tiles never overlap during a swap. */
    setSourceFrame(urlTemplate) {
      swapSourceTileUrl(urlTemplate);
      applySourceOpacity();
    },
    setSourceOpacity(v) {
      sourceOpacity = Math.max(0, Math.min(1, v));
      applySourceOpacity();
    },
    setSourceVisible(v) {
      sourceVisible = Boolean(v);
      applySourceOpacity();
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
