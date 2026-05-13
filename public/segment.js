/**
 * Connected-component labeling for rain-rate grids.
 *
 * Two-pass union-find (Hoshen–Kopelman style):
 *   Pass 1 — row-major scan. Each above-threshold pixel adopts the
 *   smallest label among its already-visited 4- or 8-connected
 *   neighbours, unioning the rest. New label if none are set.
 *   Pass 2 — flatten via find-root, drop blobs below `minAreaCells`,
 *   relabel densely so output IDs are 1..N with no gaps.
 *
 * `labels[p]` is 0 for "no blob" and ≥1 for "belongs to blobs[i] where
 * blobs[i].id === labels[p]". Blob summaries carry bbox + intensity
 * stats so downstream stages (severity scoring, contour extraction)
 * don't have to re-walk the grid.
 *
 * Donuts are returned as a single blob covering only the ring; hole
 * filling is intentionally NOT done here — that's a marching-squares
 * concern (it sees holes via the contour winding order).
 *
 * Pure function — no DOM, no Spektrum.
 */

export const DEFAULT_RAIN_THRESHOLD = 0.5;
export const DEFAULT_MIN_AREA_CELLS = 5;
export const DEFAULT_CONNECTIVITY = 8;

export function labelConnectedComponents(grid, width, height, options = {}) {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('labelConnectedComponents: width and height must be positive integers');
  }
  const n = width * height;
  if (!grid || grid.length !== n) {
    throw new Error('labelConnectedComponents: grid length does not match width*height');
  }
  const {
    threshold = DEFAULT_RAIN_THRESHOLD,
    connectivity = DEFAULT_CONNECTIVITY,
    minAreaCells = DEFAULT_MIN_AREA_CELLS,
  } = options;
  if (connectivity !== 4 && connectivity !== 8) {
    throw new Error('labelConnectedComponents: connectivity must be 4 or 8');
  }
  if (!Number.isInteger(minAreaCells) || minAreaCells < 1) {
    throw new Error('labelConnectedComponents: minAreaCells must be a positive integer');
  }

  // Union-find parent table; parent[i] = i means root. Index 0 is
  // reserved for "no label", so real labels start at 1.
  const parent = [0];
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return ra;
    // Smallest-label-wins keeps the dense-ID pass deterministic.
    if (ra < rb) { parent[rb] = ra; return ra; }
    parent[ra] = rb;
    return rb;
  };

  const tmp = new Int32Array(n);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      // NaN-safe: `NaN >= threshold` is false, so NaN cells are skipped.
      if (!(grid[p] >= threshold)) continue;
      // Visited neighbours: W (row-1), N, NW, NE — last two only for 8-conn.
      let chosen = 0;
      if (x > 0) {
        const lw = tmp[p - 1];
        if (lw) chosen = chosen ? union(chosen, lw) : lw;
      }
      if (y > 0) {
        const ln = tmp[p - width];
        if (ln) chosen = chosen ? union(chosen, ln) : ln;
        if (connectivity === 8) {
          if (x > 0) {
            const lnw = tmp[p - width - 1];
            if (lnw) chosen = chosen ? union(chosen, lnw) : lnw;
          }
          if (x < width - 1) {
            const lne = tmp[p - width + 1];
            if (lne) chosen = chosen ? union(chosen, lne) : lne;
          }
        }
      }
      if (!chosen) {
        chosen = parent.length;
        parent.push(chosen);
      }
      tmp[p] = chosen;
    }
  }

  // Pre-pass: resolve every pixel to its root, count area per root.
  const roots = new Int32Array(n);
  const areaByRoot = new Map();
  for (let p = 0; p < n; p++) {
    const lab = tmp[p];
    if (!lab) continue;
    const r = find(lab);
    roots[p] = r;
    areaByRoot.set(r, (areaByRoot.get(r) || 0) + 1);
  }

  // Assign dense IDs to surviving roots in sorted order.
  const sortedRoots = [...areaByRoot.keys()].sort((a, b) => a - b);
  const denseByRoot = new Map();
  const blobs = [];
  let nextId = 1;
  for (const r of sortedRoots) {
    if (areaByRoot.get(r) < minAreaCells) continue;
    denseByRoot.set(r, nextId);
    blobs.push({
      id: nextId,
      cells: [],
      bbox: { minX: width, maxX: -1, minY: height, maxY: -1 },
      peak: 0,
      sum: 0,
      mean: 0,
    });
    nextId++;
  }

  const labels = new Int32Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const r = roots[p];
      if (!r) continue;
      const id = denseByRoot.get(r);
      if (!id) continue;
      labels[p] = id;
      const blob = blobs[id - 1];
      blob.cells.push(p);
      const v = grid[p];
      if (v > blob.peak) blob.peak = v;
      blob.sum += v;
      const bb = blob.bbox;
      if (x < bb.minX) bb.minX = x;
      if (x > bb.maxX) bb.maxX = x;
      if (y < bb.minY) bb.minY = y;
      if (y > bb.maxY) bb.maxY = y;
    }
  }

  for (const b of blobs) {
    b.mean = b.cells.length > 0 ? b.sum / b.cells.length : 0;
  }

  return { labels, blobs };
}
