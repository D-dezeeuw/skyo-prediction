/**
 * Pure layer registry. Tracks the set of map overlays the user can toggle
 * and dim independently. Holds plain data only — DOM/Leaflet effects are
 * applied by map.js subscribing to a snapshot of this state.
 *
 * Each layer: { id, name, visible: boolean, opacity: number in [0,1], meta }
 */

export const DEFAULT_OPACITY = 0.8;

function clampOpacity(v) {
  if (typeof v !== 'number' || Number.isNaN(v)) return DEFAULT_OPACITY;
  return Math.max(0, Math.min(1, v));
}

function freezeLayer(layer) {
  return Object.freeze({ ...layer });
}

export function createLayerRegistry(initial = []) {
  const layers = new Map();

  for (const layer of initial) registerInto(layers, layer);

  return {
    list() {
      return [...layers.values()].map(freezeLayer);
    },
    get(id) {
      const layer = layers.get(id);
      return layer ? freezeLayer(layer) : null;
    },
    has(id) {
      return layers.has(id);
    },
    register(layer) {
      registerInto(layers, layer);
      return this.get(layer.id);
    },
    update(id, patch) {
      const existing = layers.get(id);
      if (!existing) throw new Error(`update: unknown layer "${id}"`);
      const next = { ...existing, ...patch, id, opacity: clampOpacity(patch.opacity ?? existing.opacity) };
      layers.set(id, next);
      return freezeLayer(next);
    },
    setVisible(id, visible) {
      return this.update(id, { visible: Boolean(visible) });
    },
    setOpacity(id, opacity) {
      return this.update(id, { opacity });
    },
    remove(id) {
      return layers.delete(id);
    },
    size() {
      return layers.size;
    },
  };
}

function registerInto(layers, layer) {
  if (!layer || typeof layer.id !== 'string' || layer.id.length === 0) {
    throw new Error('register: layer.id required');
  }
  if (typeof layer.name !== 'string' || layer.name.length === 0) {
    throw new Error('register: layer.name required');
  }
  layers.set(
    layer.id,
    {
      id: layer.id,
      name: layer.name,
      visible: layer.visible !== false,
      opacity: clampOpacity(layer.opacity ?? DEFAULT_OPACITY),
      meta: layer.meta ?? null,
    },
  );
}
