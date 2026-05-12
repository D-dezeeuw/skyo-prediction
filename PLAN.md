# Browser-Native Precipitation Nowcasting (Spektrum)

## Context

You want a precipitation forecaster: pull a sequence of recent radar images, infer cloud motion, and extrapolate the rain field forward in time. A few-second compute budget is acceptable. The MVP runs as a standalone Spektrum app in `/Users/ddezeeuw/Projects/2026n/precipitation-prediction/` (currently empty), reusing patterns from [weather-app-spektrum](/Users/ddezeeuw/Projects/weather-app-spektrum/) — specifically RainViewer access, Leaflet mounting, and the `addAsync`/`computed`/`bindDOM` flow seen in [public/app.js](/Users/ddezeeuw/Projects/weather-app-spektrum/public/app.js) and [public/map.js](/Users/ddezeeuw/Projects/weather-app-spektrum/public/map.js).

**Hard constraint: zero server-side compute.** Everything runs from `index.html` + vanilla JS modules + CDN-loaded Spektrum, identical to Skyo. No bundler, no build-time transpilation, no backend, no ML model weights. All math (optical flow, advection, intensity decoding, thunderstorm scoring) happens client-side, using WebGL where parallelism matters and plain JS where it doesn't.

**This technique has an industry name: *optical-flow nowcasting* (also "Lagrangian persistence" or "radar echo extrapolation").** It's exactly what KNMI, the UK Met Office, MeteoSwiss, and the open-source [pysteps](https://pysteps.github.io/) library do for 0–2 hour precipitation forecasts. So your instinct is right — it's the standard approach. There are a couple of conceptual tweaks below.

## Evaluation of Your Plan — Corrections

| Your wording | What's actually true | Why it matters |
|---|---|---|
| "Create motion vectors **for each image**" | Motion vectors are computed **between two consecutive images** (image pair → one flow field). You don't get a flow field from a single image. | One flow field per *pair*, not per *frame*. |
| "Calculate the **delta** between vector fields" | You don't subtract flow fields. You **smooth/average** the last 2–3 flow fields (to denoise), then **advect** (push) the current rain field forward along that flow. | "Delta of deltas" is conceptually off. The motion field *is* the prediction engine. |
| "Predict next N images, each less accurate" | ✅ Correct. Skill drops sharply after ~60–90 min — pure advection ignores cloud **growth/decay**, which dominates beyond 1h. | Document a confidence horizon (e.g. 0–60 min usable, 60–120 min indicative, beyond that unreliable). |
| "Pressure data → stacking/thinning" | Surface pressure alone is a weak signal. The real driver is **vertical motion (omega) / horizontal convergence** at multiple altitudes. A cheaper proxy that works well: track per-cell **intensity rate-of-change** in your own radar history (a cell intensifying for 30 min is likely to keep intensifying). | Pressure helps, but in-radar growth-decay is the bigger win and easier to obtain. |

**Bottom line:** Your plan is the right shape. The corrections above just realign vocabulary with the standard pipeline (which has 30+ years of literature behind it).

---

## MVP Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. INGEST   RainViewer manifest → fetch last 12 frames (2h, 10m) │
│ 2. DECODE   PNG → ImageData → grayscale intensity Float32 grid   │
│ 3. FLOW     Block-matching (TREC) between consecutive pairs      │
│ 4. SMOOTH   Average last 2–3 flow fields → robust velocity field │
│ 5. ADVECT   Semi-Lagrangian step → next frame (repeat N times)   │
│ 6. RENDER   Leaflet image overlay, animated like Skyo's radar    │
└──────────────────────────────────────────────────────────────────┘
```

### Overlay & inspection UI (first-class requirement)

Because this is as much a tool for *understanding* a forecast as for producing one, every data layer is independently toggleable with its own opacity slider — a single "Layers" control panel, similar to Leaflet's native layer control but custom-styled. Layers planned:

| Layer | When | Visual | Toggle | Opacity |
|---|---|---|---|---|
| Historical radar | MVP | RainViewer palette | ✓ | 0–100% |
| Predicted radar | MVP | Same palette, optional "forecast" stripe overlay | ✓ | 0–100% |
| Motion vector field | MVP (debug) | Arrows, color-coded — see below | ✓ | 0–100% |
| Cell-intensity trend (growth/decay) | Phase 2 | Diverging red↔blue heatmap | ✓ | 0–100% |
| Confidence cone | Phase 3 | Semi-transparent contours | ✓ | 0–100% |
| 850 hPa divergence | Phase 4 | Diverging heatmap | ✓ | 0–100% |
| CAPE | Phase 5 | Sequential heatmap | ✓ | 0–100% |
| Thunderstorm score | Phase 5 | Red outline + filled cells | ✓ | 0–100% |
| Lightning strikes | Phase 5 (opt) | Animated dots | ✓ | 0–100% |

**Motion vector color-coding** (MVP, toggleable mode):
- **Mode A — by speed**: arrow color maps to magnitude (e.g. blue = slow, yellow = medium, red = fast).
- **Mode B — by underlying intensity**: arrow color maps to the precipitation intensity at that cell (so you can see where heavy rain is moving vs. where weak rain is moving).
- A radio toggle in the Layers panel switches modes; arrow length always encodes magnitude.

Implementation: a single Leaflet pane per overlay so z-ordering and opacity are independent. The Layers panel is a Spektrum-bound HTML section (`data-each="layers"` with `data-fn="toggle"` and a range input), so its state lives in `appState.layers` and is observable in time-travel debugging.

### How precipitation intensity is handled

Intensity isn't a separate concern from motion — **it *is* the field that flows**. The pipeline naturally handles it end-to-end:

1. **Decode**: RainViewer PNG tiles use a published color palette where each pixel color maps to a dBZ (reflectivity) value, which converts to mm/h rain rate via the Marshall–Palmer relation `R = (Z/200)^(1/1.6)`. We look up palette → dBZ → mm/h at decode time, producing a `Float32Array` per frame where every cell holds a real intensity number (not a color).
2. **Flow**: Block-matching uses the intensity field as-is. Heavier rain has stronger gradients, so it dominates the matching score — which is correct: a 40 mm/h convective core anchors its own motion, while wispy stratiform edges contribute less.
3. **Advect**: The fragment shader transports the intensity scalar along the flow. Output is again mm/h, so we never lose physical units.
4. **Render**: On the way out, we re-encode mm/h → color via the same palette, so "predicted" overlays look identical in style to RainViewer's frames.

This is also what enables thunderstorm detection (Phase 5 below): once you have a `Float32` intensity grid, you can threshold it (e.g. `>30 mm/h && cell area < 50 km²` ≈ convective core) and track those cells across time.

### Why these choices

- **RainViewer**: Free, CORS-enabled, ~10-min cadence, 2h history + their own nowcast frames (which we can use as ground truth to benchmark our own output). Already proven in [map.js](/Users/ddezeeuw/Projects/weather-app-spektrum/public/map.js).
- **Block-matching (TREC: Tracking Radar Echoes by Correlation)** instead of Farnebäck or Lucas–Kanade for the MVP:
  - Trivial to implement (~80 lines), trivially parallelizable on WebGL/WebGPU.
  - Industry-standard for radar nowcasting since the 1980s (still the basis of many operational systems).
  - Avoids shipping OpenCV.js (~10MB WASM).
  - Upgrade path to Farnebäck is clean if quality is insufficient.
- **Semi-Lagrangian advection on GPU**: One fragment shader, <5ms per forecast step at 256×256. The cheap part.
- **Spektrum patterns from Skyo**: `addAsync('radarHistory', ...)` → `addAsync('flowField', ...)` → `addAsync('forecast', ...)`, each gated on the previous via `computed()`. Animation loop reuses Skyo's 650ms-per-frame `mountMap` handle pattern.

### Critical files to create

| Path | Responsibility | Reuse |
|---|---|---|
| `public/index.html` | Shell + importmap (mirror [Skyo's](/Users/ddezeeuw/Projects/weather-app-spektrum/public/index.html#L24)) | Copy importmap block |
| `public/app.js` | Spektrum state graph + bindDOM | Pattern from [app.js](/Users/ddezeeuw/Projects/weather-app-spektrum/public/app.js#L1) |
| `public/radar.js` | RainViewer fetch, frame decode → Float32 grids | Adapt manifest fetch [map.js:45-56](/Users/ddezeeuw/Projects/weather-app-spektrum/public/map.js#L45) |
| `public/flow.js` | TREC block-matching + temporal smoothing (WebGL) | New |
| `public/advect.js` | Semi-Lagrangian advection (WebGL fragment shader) | New |
| `public/map.js` | Leaflet mount + animated image overlay for past + predicted frames | Adapt [map.js:103](/Users/ddezeeuw/Projects/weather-app-spektrum/public/map.js#L103) |
| `public/styles.css` | Minimal — borrow from Skyo | Steal subset |
| `build.js` | Copy `public/` → `dist/` | Copy [build.js](/Users/ddezeeuw/Projects/weather-app-spektrum/build.js) verbatim |
| `package.json` | `npm start` = http-server, `npm run build` = node build.js | Copy [package.json](/Users/ddezeeuw/Projects/weather-app-spektrum/package.json) |

### Spektrum state graph (concrete)

```js
addAsync('radarHistory',  () => fetchRainViewerFrames(bbox, 12));   // → Float32[][]
computed('flowRaw',     ['radarHistory'], h => trecPairs(h));        // → flow per pair
computed('flowField',   ['flowRaw'],      f => smoothLastN(f, 3));   // → robust field
addAsync('forecast',    () => advectForward(state.radarHistory.at(-1),
                                            state.flowField, 12));   // → 12 future frames
computed('allFrames',   ['radarHistory','forecast'], (h,f) => [...h, ...f]);
computed('currentFrame',['allFrames','playheadIdx'], (a,i) => a[i]);
```

Animation loop is a `setInterval(650ms)` advancing `playheadIdx`, mirroring [Skyo's frame stepper](/Users/ddezeeuw/Projects/weather-app-spektrum/public/map.js).

---

## Phased Improvements (Post-MVP)

These extend your "pressure data" idea into a fuller roadmap. Each phase is incrementally valuable; you can stop at any point.

### Phase 2 — Growth/Decay from radar history *(bigger accuracy win than pressure)*
- For each grid cell, fit a linear trend on the last 4 frames' intensity.
- Apply that trend during advection (intensify/decay along the trajectory).
- Cost: ~30 lines. Probable skill gain: meaningful at 30–90 min lead time.

### Phase 3 — Confidence cone
- Run advection at multiple smoothed flow scales (e.g. last 2 frames vs last 4 frames).
- Show divergence between forecasts as an uncertainty overlay.
- Educates the user that 5-min forecasts ≠ 90-min forecasts.

### Phase 4 — Pressure & convergence (your original step 2, refined)
- Pull surface pressure + 850/500 hPa winds from [Open-Meteo](https://open-meteo.com/) (free, CORS-friendly, already used in Skyo) — all client-side fetches.
- Compute horizontal **wind divergence** at 850 hPa: convergence zones → cloud growth multiplier; divergence → decay.
- Surface pressure trend gives a weaker but cheaper secondary signal.
- This *adds* to Phase 2's in-radar growth-decay, doesn't replace it.

### Phase 5 — Thunderstorm detection & prediction
Your hypothesis "precipitation + low pressure → thunderstorm" is in the right neighborhood but the actual physics driver is **CAPE** (Convective Available Potential Energy), which Open-Meteo publishes for free. Three signals, fused client-side:

| Signal | Source | What it tells us |
|---|---|---|
| **Convective cell detection** | Our own radar grid | Threshold: cells with intensity > 30 mm/h AND area < ~50 km² AND high local intensity gradient → likely convective core (vs. stratiform sheet) |
| **Rapid intensification** | Phase 2's growth/decay field | A cell whose intensity is rising > 5 dBZ per 10 min is actively building → thunderstorm-likely |
| **CAPE field** | Open-Meteo (`cape` hourly variable) | Background instability. CAPE > 1000 J/kg = thunderstorms possible; > 2500 J/kg = severe possible |

**Scoring**: `thunderstormScore = convectiveCellMask × intensificationRate × normalize(CAPE)`. Render as a separate red overlay on the map with a confidence value per cell.

**Prediction**: Because we already advect the intensity field, we also advect the convective-cell mask forward in time. Combined with the CAPE forecast (which extends hours ahead), we get a 0–60 min thunderstorm-risk prediction over the bbox.

**Optional add-on**: [blitzortung.org](https://www.blitzortung.org/) provides free real-time lightning strikes (WebSocket/HTTP). A strike inside a predicted convective cell = ground-truth confirmation; strikes outside detected cells = miss to investigate.

### Phase 6 — Stochastic ensemble (pysteps STEPS-style)
- Perturb the flow field with spatially-correlated noise; run 20 advections in parallel via WebGL.
- Display probability-of-rain rather than a single deterministic forecast.
- Still pure client-side compute.

---

## Verification

End-to-end smoke test (manual, in browser):

1. `cd /Users/ddezeeuw/Projects/2026n/precipitation-prediction && npm start` — runs `npx http-server public -p 3000 -c-1` (no install step needed; Spektrum loads from CDN via importmap, exactly like Skyo's [package.json](/Users/ddezeeuw/Projects/weather-app-spektrum/package.json)).
2. Confirm 12 historical RainViewer frames load and animate correctly first (rule out data-layer bugs before debugging flow).
3. Toggle a dev overlay (`?debug=flow`) that renders the flow field as arrows on the map — visually verify arrows point downwind on a moving system.
4. Compare your predicted frame at T+10min with RainViewer's own nowcast frame for that timestamp (RainViewer publishes nowcasts in the same manifest under `nowcast`). Eyeball overlap, then compute pixel-wise RMSE for a numeric baseline.
5. Run with a known stationary system (clear sky over the bbox) — predictions should be ≈ stationary, flow ≈ zero. Sanity check.
6. Run with a fast-moving frontal system — predictions should clearly translate; verify the leading edge advances at roughly the historical speed.

Acceptance: 12-frame (120-min) forecast computes in <3s on a mid-range laptop and visually tracks RainViewer's own nowcast within the first 30 minutes.

---

## Defaults assumed (override if needed)

- **Region/bbox**: configurable, defaulting to the Netherlands. Single-region (one PNG per frame) for the MVP — no tile stitching.
- **GitHub repo visibility**: public (MIT license signals open-source intent).
- **Local directory**: stays as `/Users/ddezeeuw/Projects/2026n/precipitation-prediction/`; the GitHub repo is `skyo-prediction`. Dir name ≠ repo name is fine; `package.json#name` will be `skyo-prediction`.

---

## Implementation Plan — Phases · Stories · Tasks

Each **story = one feature branch = one PR**. Main is always shippable. A story is "done" when:

1. All tasks checked off
2. Unit-test coverage ≥85% on modules added/changed in the story (enforced in CI)
3. Manual verification step passes
4. PR merged to `main`

### Testing strategy

- Test runner: Node's native `node --test` (same as Skyo).
- Coverage: `node --test --experimental-test-coverage` with a CI gate at 85% on changed files (or `c8` if native coverage lacks per-file thresholds).
- WebGL code is split into **pure-JS reference impl** (heavily unit-tested) + **WebGL kernel** (integration-tested by comparing output against the reference on synthetic inputs). This avoids needing headless-gl in CI and gives us a debuggable fallback.
- Each story has a small "verify in browser" checklist for manual visual confirmation.

### Branch workflow per story

```bash
git checkout main && git pull
git checkout -b feat/0X-short-name
# implement, commit incrementally
npm run test && npm run test:coverage
git push -u origin feat/0X-short-name
gh pr create --fill
# CI passes → manual verify → merge → delete branch
```

---

### Story 0 — Repository bootstrap *(no feature branch; main directly)*

- [ ] Create GitHub repo `skyo-prediction` (public, MIT license, no template)
- [ ] `git init` in `/Users/ddezeeuw/Projects/2026n/precipitation-prediction/`
- [ ] Add `README.md` (brief: what the project is, demo screenshot placeholder)
- [ ] Add `LICENSE` (MIT, current year, your name)
- [ ] Add `.gitignore` (node_modules, dist, .DS_Store, .env)
- [ ] Add empty `public/` and `test/` directories with `.gitkeep`
- [ ] Initial commit on `main`, push to remote, set upstream
- **Verify**: `gh repo view skyo-prediction --web` shows MIT badge and the initial commit.

---

### Phase 1 — MVP: Optical-Flow Nowcasting

#### Story 1 — Project shell & Spektrum scaffold
Branch: `feat/01-project-shell`

- [ ] `package.json`: `start`, `build`, `test`, `test:coverage` scripts (mirror [Skyo's](/Users/ddezeeuw/Projects/weather-app-spektrum/package.json)); `name: "skyo-prediction"`, `"type": "module"`
- [ ] `build.js`: copy `public/*` → `dist/*`, rewrite `index.html` paths `"/"` → `"./"` (copy from Skyo's [build.js](/Users/ddezeeuw/Projects/weather-app-spektrum/build.js))
- [ ] `public/index.html`: importmap for `spektrum`, `spektrum/persist`, `spektrum/devtools` from unpkg
- [ ] `public/app.js`: `setValue`, `defineFn`, `bindDOM` boot sequence with a "Hello" smoke
- [ ] `public/styles.css`: minimal reset + dark theme base
- [ ] `test/smoke.test.js`: import app.js with jsdom, confirm boot doesn't throw
- [ ] `.github/workflows/ci.yml`: install, `node --test`, coverage report, fail if <85%
- **Verify**: `npm start` → page loads at localhost:3000, no console errors. CI green on first push.
- **Coverage target**: 85% of `app.js`, `build.js`.

#### Story 2 — RainViewer ingestion
Branch: `feat/02-rainviewer-ingest`

- [ ] `public/radar.js`: `fetchManifest()`, `selectFrames(manifest, count)`, `frameUrl(host, path, size, zoom, lat, lon, color, smooth)` builders
- [ ] `public/palette.js`: RainViewer color palette → dBZ lookup table (constant), `dBZtoRainRate(dbz)` Marshall-Palmer, `decodePNG(imageData) → Float32Array`
- [ ] Wire into `app.js`: `addAsync('radarHistory', ...)` returns array of `{ts, grid: Float32Array, width, height}`
- [ ] `test/radar.test.js`: manifest parse fixture, frame URL construction
- [ ] `test/palette.test.js`: known color → expected dBZ; round-trip dBZ → mm/h → dBZ
- **Verify**: in browser dev console, `window._dbg = appState.radarHistory.data` shows 12 frames with Float32 grids; `frames[0].grid.reduce(max)` is plausible (e.g. <100 mm/h).
- **Coverage target**: 85% on `radar.js` + `palette.js`.

#### Story 3 — Leaflet map + Layers panel (opacity + toggle infra)
Branch: `feat/03-map-shell`

- [ ] `public/map.js`: adapt [Skyo's map.js](/Users/ddezeeuw/Projects/weather-app-spektrum/public/map.js) — Leaflet 1.9.4 ESM from unpkg, CARTO dark base, configurable bbox
- [ ] `public/layers.js`: `registerLayer({id, name, render, opacity, visible})`, `setOpacity(id, v)`, `setVisible(id, v)` — Spektrum-state-backed
- [ ] Render historical radar frames as `L.imageOverlay` per frame (lazy, swap on playhead change)
- [ ] HTML: Layers panel section with `data-each="layers"`, checkbox + range slider per layer
- [ ] Timeline scrubber: play/pause button + range input bound to `playheadIdx`
- [ ] `test/layers.test.js`: register/toggle/opacity state transitions
- **Verify**: map shows NL with animating RainViewer history; toggling "Historical radar" hides layer; opacity slider works smoothly.
- **Coverage target**: 85% on `layers.js`, pure JS in `map.js`.

#### Story 4 — TREC optical flow (CPU reference + WebGL kernel)
Branch: `feat/04-flow-trec`

- [ ] `public/flow-ref.js`: pure-JS block-matching. For each block in frame[t-1], find best-match offset in frame[t] using normalized cross-correlation; output `{vx, vy}` field
- [ ] `public/flow-gpu.js`: WebGL fragment shader doing the same — pack block-matching into a kernel
- [ ] `public/flow.js`: facade — uses GPU if available, falls back to ref
- [ ] Temporal smoothing: average last 3 flow fields
- [ ] `test/flow-ref.test.js`: synthetic shifted-grid → expected uniform flow; zero motion → zero field; rotated field → tangential flow
- [ ] `test/flow-integration.test.js`: GPU output within ε of ref on small synthetic input (skip if no WebGL in CI)
- **Verify**: feed two artificially-shifted frames → flow magnitude ≈ shift, direction correct. (Visual confirmation comes in Story 5.)
- **Coverage target**: 85% on `flow-ref.js` + `flow.js` facade.

#### Story 5 — Motion vector debug overlay (color-coded)
Branch: `feat/05-flow-overlay`

- [ ] `public/vectors.js`: render flow as SVG arrows on a dedicated Leaflet pane; subsample grid (e.g. every 16 pixels)
- [ ] Color modes: `by-magnitude` (cool→warm gradient), `by-intensity` (sample underlying radar value)
- [ ] Radio in Layers panel: "Color: speed | intensity"
- [ ] Layer toggle + opacity wired in
- [ ] `test/vectors.test.js`: vector → SVG path string, color mapping at known magnitudes
- **Verify**: live RainViewer data → arrows visually point downwind on a moving frontal system; both color modes render distinctly.
- **Coverage target**: 85% on `vectors.js`.

#### Story 5.5 — Flow-field noise filtering
Branch: `feat/05-5-flow-noise-filter`

After Story 5 the per-pair flow overlay clearly shows noise: stray vectors in low-signal regions, vectors that disagree with all their neighbours, and false motion in radar speckle. The intensity-threshold gate hides them in the *overlay*, but the underlying flow field still feeds into Stories 6 (advection) and 9 (growth/decay), so the noise propagates downstream. Filter it at source.

Three layered filters, each cheap and independently toggleable:

- [ ] **SSD-confidence filter**: `computeFlow` already finds the best SSD per block. Record the `bestSSD` alongside `(vx, vy)` in `flow.data`. In a post-pass, drop any block whose `bestSSD / blockEnergy` exceeds a threshold (the "match" was a coincidence, not a real correspondence). Replace dropped blocks with NaN or zero flow.
- [ ] **Spatial-coherence filter (vector median)**: replace each block's `(vx, vy)` with the median of its 3×3 neighbourhood. Outliers that disagree with neighbours get smoothed away; coherent fronts pass through unchanged. Pure JS, ~30 lines.
- [ ] **Intensity-weighted gate at flow time** (not just render time): exclude any block whose underlying mean intensity in either source frame is below threshold. Block-matching on flat-zero is undefined — better to mark as "no flow available" than to render an arbitrary zero vector.
- [ ] Tests on synthetic noisy fields: a uniform shift with random outliers → median filter restores it; a flat-zero region → coherence filter marks it absent; a low-confidence patch → SSD-confidence filter drops it.
- **Verify**: arrows visibly cleaner — no jittery vectors in empty sky, no contradictory directions in calm areas, fronts still resolve.
- **Coverage target**: 85% on `flow.js` (extended).

#### Story 6 — Semi-Lagrangian advection
Branch: `feat/06-advection`

- [ ] `public/advect-ref.js`: bilinear back-trace advection in pure JS — for each output cell, trace backwards along flow, sample input bilinearly
- [ ] `public/advect-gpu.js`: WebGL fragment shader equivalent
- [ ] `public/advect.js`: facade + N-step forecast generator
- [ ] `test/advect-ref.test.js`: stationary input → stationary output; uniform translation → shifted output; mass conservation within ε on closed domain
- [ ] `test/advect-integration.test.js`: GPU vs ref on synthetic input
- **Verify**: 12-step forecast on real RainViewer data renders as Leaflet overlay; visually similar to RainViewer's own nowcast.
- **Coverage target**: 85% on `advect-ref.js` + `advect.js`.

#### Story 6.5 — Inter-frame interpolation (smooth playback)
Branch: `feat/06-5-frame-interpolation`

RainViewer publishes a frame every 10 minutes. Native playback at 1 frame per playhead step gives a stuttery, choppy slideshow. Once Story 6 ships advection, we get sub-frame interpolation almost for free — just advect at fractional `dt`.

For each pair of consecutive observed frames `frame[i]` and `frame[i+1]` (with the smoothed flow `v` between them), inject N intermediate frames at `dt = 1/(N+1), 2/(N+1), ..., N/(N+1)`. Each intermediate is `advect(frame[i], v, dt)`. Result: 12 observed frames + 12·(N+1)−12 ≈ 36 to 60 displayed frames at the same total time span, played back smoothly.

- [ ] `advect.js`: extend forecast generator to support `dt < 1` (already a parameter on the back-trace step; just expose it).
- [ ] `app.js`: `addAsync('interpolated', ...)` runs after `radarGrids` settles; produces an array of `{time, grid, interpolated: bool}` interleaving observed and computed frames.
- [ ] Timeline scrubber binds against the interpolated array length, not just observed count. "Frame N / 47" instead of "N / 11".
- [ ] Visual hint: subtle border or "computed" badge on interpolated frames so the user can tell what's real radar vs. computed in-between.
- [ ] Configurable interpolation factor `N` (default 4 → 47 displayed frames from 12 observed). Slider in dev panel.
- [ ] Performance: 12 observed frames × 4 in-betweens × per-step advection cost. At ~5 ms/step on GPU (or ~50 ms on CPU), 48 steps = 240 ms / 2.4 s respectively. Within the 3 s budget.
- [ ] Tests: interpolation at `dt=0` returns input unchanged, `dt=1` returns the next observed frame within ε (since flow was *fitted* to that transition), `dt=0.5` produces a grid roughly between the two.
- **Verify**: scrubber slides smoothly through ~48 frames at 60 fps; arrows update per real-frame pair; no perceived stutter.
- **Coverage target**: 85% on `advect.js` extensions.

#### Story 7 — Forecast playback & MVP polish
Branch: `feat/07-forecast-playback`

- [ ] Unified timeline: history (T-110 → T0) + forecast (T0 → T+120) in one scrubber
- [ ] Visual distinction for predicted frames (border stripe or "FORECAST" badge near playhead)
- [ ] Performance benchmark: 12-frame forecast must complete <3s on a mid-range laptop; add `performance.mark/measure` and display in dev panel
- [ ] Numeric RMSE vs RainViewer's own nowcast (dev panel only)
- [ ] README update with screenshot
- **Verify**: full MVP smoke from the [Verification](#verification) section.
- **Coverage target**: overall project ≥85%.

---

#### Story 2.5 — Frame caching *(after Story 2 merges, only if browser HTTP cache is insufficient)*
Branch: `feat/02-5-frame-cache`

Default to relying on the browser HTTP cache: RainViewer's CDN sets `Cache-Control` on tile PNGs, frame URLs are immutable (timestamp in path), so reloads should already hit `(from disk cache)`. Verify in DevTools Network panel after Story 2 merges. Only build this story if that verification fails.

If needed:
- [ ] `public/cache.js`: `cachedFetch(url)` wrapper using the Cache API (`caches.open('skyo-prediction-radar')`); falls back to direct fetch when API unavailable
- [ ] `public/radar.js`: route `loadFrame` through `cachedFetch`
- [ ] Auto-prune on boot: walk cache, delete entries whose URL timestamp is > 24 h old
- [ ] Tests on `cachedFetch` with a stub `caches` and stub `fetchImpl` (Cache API surface is mockable)
- **Verify**: cold load fetches from network; warm reload pulls from `caches`; entries older than 24 h disappear after boot.

IndexedDB for decoded grids stays deferred until profiling flags decode as a bottleneck.

### Phase 2 — Growth/Decay  *(stories sketched; expand at start of phase)*
- Story 8: `trend.js` — per-cell intensity rate-of-change over last 4 frames
- Story 9: `advect.js` extension — apply trend during advection
- Story 10: Trend overlay (diverging heatmap, opacity slider)

### Phase 3 — Confidence cone
- Story 11: Multi-scale ensemble (forecast at 2- and 4-frame smoothing)
- Story 12: Uncertainty contour overlay

### Phase 4 — Pressure & convergence
- Story 13: Open-Meteo wind/pressure ingestion
- Story 14: 850 hPa divergence computation + overlay
- Story 15: Apply convergence as growth multiplier

### Phase 5 — Thunderstorms
- Story 16: Convective cell detection (intensity + size + gradient)
- Story 17: CAPE ingestion + overlay
- Story 18: Thunderstorm score + red overlay
- Story 19 (optional): Blitzortung lightning ingest

### Phase 6 — Stochastic ensemble
- Story 20: Multi-realization perturbed advection
- Story 21: Probability-of-rain overlay
