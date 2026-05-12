import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLayerRegistry, DEFAULT_OPACITY } from '../public/layers.js';

const sample = (overrides = {}) => ({
  id: 'radar-history',
  name: 'Historical radar',
  ...overrides,
});

describe('createLayerRegistry', () => {
  test('starts empty when no initial layers given', () => {
    const r = createLayerRegistry();
    assert.equal(r.size(), 0);
    assert.deepEqual(r.list(), []);
  });

  test('registers initial layers in order', () => {
    const r = createLayerRegistry([
      sample({ id: 'a', name: 'A' }),
      sample({ id: 'b', name: 'B' }),
    ]);
    assert.equal(r.size(), 2);
    assert.deepEqual(r.list().map((l) => l.id), ['a', 'b']);
  });

  test('default opacity is DEFAULT_OPACITY when omitted', () => {
    const r = createLayerRegistry([sample()]);
    assert.equal(r.get('radar-history').opacity, DEFAULT_OPACITY);
  });

  test('default visible is true when omitted', () => {
    const r = createLayerRegistry([sample()]);
    assert.equal(r.get('radar-history').visible, true);
  });

  test('explicit visible:false is preserved', () => {
    const r = createLayerRegistry([sample({ visible: false })]);
    assert.equal(r.get('radar-history').visible, false);
  });

  test('register throws when id missing', () => {
    const r = createLayerRegistry();
    assert.throws(() => r.register({ name: 'No ID' }), /id required/);
    assert.throws(() => r.register({ id: '', name: 'Empty' }), /id required/);
  });

  test('register throws when name missing', () => {
    const r = createLayerRegistry();
    assert.throws(() => r.register({ id: 'x' }), /name required/);
    assert.throws(() => r.register({ id: 'x', name: '' }), /name required/);
  });

  test('register returns a frozen snapshot', () => {
    const r = createLayerRegistry();
    const snap = r.register(sample());
    assert.ok(Object.isFrozen(snap));
    assert.throws(() => { snap.opacity = 0; });
  });

  test('register replaces an existing layer with the same id', () => {
    const r = createLayerRegistry([sample({ name: 'Original' })]);
    r.register(sample({ name: 'Replaced' }));
    assert.equal(r.size(), 1);
    assert.equal(r.get('radar-history').name, 'Replaced');
  });

  test('list returns frozen snapshots, not internal state', () => {
    const r = createLayerRegistry([sample()]);
    const snap = r.list()[0];
    assert.throws(() => { snap.visible = false; });
    // Mutating the returned array doesn't affect the registry
    r.list().pop();
    assert.equal(r.size(), 1);
  });

  test('get returns null for unknown id', () => {
    const r = createLayerRegistry();
    assert.equal(r.get('nope'), null);
  });

  test('has reflects presence', () => {
    const r = createLayerRegistry([sample()]);
    assert.equal(r.has('radar-history'), true);
    assert.equal(r.has('missing'), false);
  });

  test('update merges patch and clamps opacity to [0,1]', () => {
    const r = createLayerRegistry([sample()]);
    r.update('radar-history', { opacity: 1.5 });
    assert.equal(r.get('radar-history').opacity, 1);
    r.update('radar-history', { opacity: -0.2 });
    assert.equal(r.get('radar-history').opacity, 0);
  });

  test('update preserves id even if patch tries to change it', () => {
    const r = createLayerRegistry([sample()]);
    r.update('radar-history', { id: 'evil' });
    assert.equal(r.get('radar-history').id, 'radar-history');
    assert.equal(r.has('evil'), false);
  });

  test('update throws on unknown id', () => {
    const r = createLayerRegistry();
    assert.throws(() => r.update('nope', { visible: false }), /unknown layer "nope"/);
  });

  test('setVisible coerces to boolean', () => {
    const r = createLayerRegistry([sample()]);
    r.setVisible('radar-history', 0);
    assert.equal(r.get('radar-history').visible, false);
    r.setVisible('radar-history', 'truthy');
    assert.equal(r.get('radar-history').visible, true);
  });

  test('setOpacity clamps non-numeric input to default', () => {
    const r = createLayerRegistry([sample()]);
    r.setOpacity('radar-history', 'half');
    assert.equal(r.get('radar-history').opacity, DEFAULT_OPACITY);
  });

  test('setOpacity treats NaN as default', () => {
    const r = createLayerRegistry([sample()]);
    r.setOpacity('radar-history', NaN);
    assert.equal(r.get('radar-history').opacity, DEFAULT_OPACITY);
  });

  test('remove deletes the layer and returns true; false when absent', () => {
    const r = createLayerRegistry([sample()]);
    assert.equal(r.remove('radar-history'), true);
    assert.equal(r.size(), 0);
    assert.equal(r.remove('radar-history'), false);
  });

  test('register accepts and stores a meta object', () => {
    const r = createLayerRegistry();
    r.register(sample({ meta: { kind: 'tile' } }));
    assert.deepEqual(r.get('radar-history').meta, { kind: 'tile' });
  });
});
