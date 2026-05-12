import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_MODES,
  DEFAULT_ARROW_HEAD,
  DEFAULT_ARROW_SCALE,
  arrowPath,
  buildArrows,
  intensityColor,
  magnitudeColor,
  tileBounds,
} from '../public/vectors.js';

describe('exports', () => {
  test('exposes both colour modes', () => {
    assert.deepEqual([...COLOR_MODES].sort(), ['intensity', 'speed']);
  });
  test('arrow scale and head defaults are sensible', () => {
    assert.equal(DEFAULT_ARROW_SCALE, 2);
    assert.equal(DEFAULT_ARROW_HEAD, 3);
  });
});

describe('tileBounds', () => {
  test('z=0 covers the whole world', () => {
    const b = tileBounds(0, 0, 0);
    assert.equal(b.lonLeft, -180);
    assert.equal(b.lonRight, 180);
    // Web Mercator caps lat at ~85.0511
    assert.ok(Math.abs(b.latTop - 85.0511) < 0.001);
    assert.ok(Math.abs(b.latBottom + 85.0511) < 0.001);
  });

  test('z=1 splits the world into 4 tiles', () => {
    const tl = tileBounds(0, 0, 1);
    const tr = tileBounds(1, 0, 1);
    assert.equal(tl.lonRight, tr.lonLeft);
    assert.equal(tl.lonLeft, -180);
    assert.equal(tr.lonRight, 180);
    assert.ok(Math.abs(tl.latBottom) < 1e-9);
  });

  test('NL-area tile (16,10,5) covers ~0..11.25 lon', () => {
    const b = tileBounds(16, 10, 5);
    assert.ok(Math.abs(b.lonLeft - 0) < 1e-9);
    assert.ok(Math.abs(b.lonRight - 11.25) < 1e-9);
    assert.ok(b.latTop > b.latBottom);
    assert.ok(b.latTop > 50 && b.latTop < 60);
  });

  test('throws on non-integer or negative inputs', () => {
    assert.throws(() => tileBounds(1.5, 0, 1), /non-negative integers/);
    assert.throws(() => tileBounds(0, -1, 1), /non-negative integers/);
    assert.throws(() => tileBounds(0, 0, -1), /non-negative integers/);
  });
});

describe('arrowPath', () => {
  test('zero-length vector collapses to a degenerate path at the origin', () => {
    assert.equal(arrowPath(10, 20, 0, 0), 'M 10 20 L 10 20');
  });

  test('horizontal +x produces a path ending to the right of the start', () => {
    const d = arrowPath(0, 0, 5, 0, 1);
    assert.match(d, /L 5 0/);
    // arrowhead wings are on the upper/lower side of the tip
    const wingMatches = d.match(/L (-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g);
    assert.ok(wingMatches.length >= 3, 'expected line + two wings');
  });

  test('vertical +y arrowhead points downward', () => {
    const d = arrowPath(10, 10, 0, 5, 1);
    // Tip at (10, 15)
    assert.match(d, /L 10 15/);
  });

  test('respects custom scale', () => {
    const d = arrowPath(0, 0, 1, 0, 4);
    assert.match(d, /L 4 0/);
  });

  test('respects custom head size', () => {
    const dSmall = arrowPath(0, 0, 5, 0, 1, 1);
    const dBig = arrowPath(0, 0, 5, 0, 1, 5);
    assert.notEqual(dSmall, dBig);
  });
});

describe('magnitudeColor', () => {
  test('zero magnitude is the cool end (blue)', () => {
    const c = magnitudeColor(0, 5);
    assert.match(c, /hsl\(240/);
  });

  test('reference magnitude is the warm end (red, hue 0)', () => {
    const c = magnitudeColor(5, 5);
    assert.match(c, /hsl\(0/);
  });

  test('half-reference magnitude is mid-spectrum (around hue 120)', () => {
    const c = magnitudeColor(2.5, 5);
    assert.match(c, /hsl\(120/);
  });

  test('clamps above reference to red', () => {
    assert.match(magnitudeColor(99, 5), /hsl\(0/);
  });

  test('handles zero/missing reference without dividing by zero', () => {
    // With ref=0 we fall back to denom=1 and clamp t to 1 → warm end.
    // The contract is "no NaN, valid hsl string" — exact hue is incidental.
    assert.match(magnitudeColor(3, 0), /^hsl\(\d+, \d+%, \d+%\)$/);
    assert.match(magnitudeColor(0, 0), /^hsl\(240/); // zero magnitude is still cool
  });
});

describe('intensityColor', () => {
  test('non-positive rain rate uses a muted neutral', () => {
    assert.equal(intensityColor(0), 'hsl(220, 30%, 65%)');
    assert.equal(intensityColor(-1), 'hsl(220, 30%, 65%)');
  });

  test('moderate rain (~3 mm/h ≈ 30 dBZ) lands in the cool half of the ramp', () => {
    const c = intensityColor(3);
    const m = c.match(/hsl\((\d+)/);
    assert.ok(m);
    const hue = Number(m[1]);
    assert.ok(hue > 120 && hue <= 240, `expected mid-cool hue, got ${hue}`);
  });

  test('heavy rain (~50 mm/h ≈ 50 dBZ) lands in the warm half', () => {
    const c = intensityColor(50);
    const m = c.match(/hsl\((\d+)/);
    const hue = Number(m[1]);
    assert.ok(hue < 120, `expected warm hue, got ${hue}`);
  });
});

describe('buildArrows', () => {
  function flowField(width, height, fill = [0, 0]) {
    const data = new Float32Array(width * height * 2);
    for (let i = 0; i < data.length; i += 2) {
      data[i] = fill[0];
      data[i + 1] = fill[1];
    }
    return { width, height, blockSize: 16, data };
  }

  test('returns [] for missing / empty field', () => {
    assert.deepEqual(buildArrows(null), []);
    assert.deepEqual(buildArrows({}), []);
  });

  test('produces width*height entries', () => {
    const arrows = buildArrows(flowField(4, 4, [1, 0]));
    assert.equal(arrows.length, 16);
  });

  test('every entry has a path string and a colour', () => {
    const arrows = buildArrows(flowField(2, 2, [1, 0]));
    for (const a of arrows) {
      assert.equal(typeof a.d, 'string');
      assert.match(a.color, /^hsl/);
      assert.equal(typeof a.magnitude, 'number');
    }
  });

  test('arrow centres are at block centres in tile-pixel space', () => {
    const arrows = buildArrows(flowField(2, 2, [0, 0]), { tileSize: 256 });
    // 2x2 grid → block size 128px → centres at 64, 192
    assert.equal(arrows[0].d, 'M 64 64 L 64 64');
    assert.equal(arrows[1].d, 'M 192 64 L 192 64');
    assert.equal(arrows[3].d, 'M 192 192 L 192 192');
  });

  test('speed mode uses the field max as the warm reference', () => {
    const f = flowField(2, 2, [3, 0]);
    f.data[0] = 6; f.data[1] = 0; // bump one block to magnitude 6
    const arrows = buildArrows(f, { colorMode: 'speed' });
    assert.match(arrows[0].color, /hsl\(0/); // hottest = red
    assert.match(arrows[1].color, /hsl\(120/); // half = mid
  });

  test('intensity mode samples the radar grid (warm where rain is)', () => {
    const f = flowField(2, 2, [1, 0]);
    const tileSize = 256;
    const radarGrid = new Float32Array(tileSize * tileSize); // all zero → muted
    // Paint the top-left quadrant with heavy rain (50 mm/h)
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        radarGrid[y * tileSize + x] = 50;
      }
    }
    const arrows = buildArrows(f, {
      tileSize,
      colorMode: 'intensity',
      radarGrid,
      radarWidth: tileSize,
    });
    // Top-left arrow centre at (64, 64) sits in the heavy-rain patch
    assert.match(arrows[0].color, /hsl\(\d+/);
    assert.notEqual(arrows[0].color, 'hsl(220, 30%, 65%)');
    // Bottom-right at (192, 192) in zero-rain area
    assert.equal(arrows[3].color, 'hsl(220, 30%, 65%)');
  });

  test('intensity mode falls back to muted when no radar grid is provided', () => {
    const arrows = buildArrows(flowField(2, 2, [1, 0]), { colorMode: 'intensity' });
    for (const a of arrows) assert.equal(a.color, 'hsl(220, 30%, 65%)');
  });

  test('unknown colour mode falls back to speed', () => {
    const arrows = buildArrows(flowField(2, 2, [1, 0]), { colorMode: 'rainbow' });
    for (const a of arrows) assert.match(a.color, /^hsl/);
  });

  test('intensityThreshold skips blocks whose radar sample is below the cutoff', () => {
    const f = flowField(2, 2, [1, 0]);
    const tileSize = 256;
    // Paint only the top-left quadrant with rain (50 mm/h). The other
    // three blocks should be culled.
    const radarGrid = new Float32Array(tileSize * tileSize);
    for (let y = 0; y < 128; y++) {
      for (let x = 0; x < 128; x++) {
        radarGrid[y * tileSize + x] = 50;
      }
    }
    const arrows = buildArrows(f, {
      tileSize,
      radarGrid,
      radarWidth: tileSize,
      intensityThreshold: 0.05,
    });
    assert.equal(arrows.length, 1, 'only the rainy block should render');
    // The kept arrow's centre should be in the top-left (64, 64)
    assert.match(arrows[0].d, /^M 64 64/);
  });

  test('intensityThreshold has no effect when radarGrid is missing', () => {
    const arrows = buildArrows(flowField(2, 2, [1, 0]), { intensityThreshold: 99 });
    assert.equal(arrows.length, 4, 'gate should be inactive without a grid');
  });

  test('intensityThreshold of 0 (default) renders every block', () => {
    const f = flowField(2, 2, [1, 0]);
    const radarGrid = new Float32Array(256 * 256); // all zero
    const arrows = buildArrows(f, {
      tileSize: 256,
      radarGrid,
      radarWidth: 256,
      intensityThreshold: 0,
    });
    assert.equal(arrows.length, 4);
  });
});
