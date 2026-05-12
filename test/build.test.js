import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relativizeHtml, build } from '../build.js';

describe('relativizeHtml', () => {
  test('converts absolute-root src to relative', () => {
    const input = '<script src="/app.js"></script>';
    assert.equal(relativizeHtml(input), '<script src="./app.js"></script>');
  });

  test('converts absolute-root href to relative', () => {
    const input = '<link rel="stylesheet" href="/styles.css">';
    assert.equal(relativizeHtml(input), '<link rel="stylesheet" href="./styles.css">');
  });

  test('leaves protocol-relative URLs alone', () => {
    const input = '<script src="//unpkg.com/spektrum.js"></script>';
    assert.equal(relativizeHtml(input), input);
  });

  test('leaves absolute https URLs alone', () => {
    const input = '<script src="https://example.com/app.js"></script>';
    assert.equal(relativizeHtml(input), input);
  });

  test('handles multiple absolute paths in same document', () => {
    const input = '<link href="/styles.css"><script src="/app.js"></script>';
    const expected = '<link href="./styles.css"><script src="./app.js"></script>';
    assert.equal(relativizeHtml(input), expected);
  });

  test('does not rewrite attributes other than src or href', () => {
    const input = '<a data-path="/foo">x</a>';
    assert.equal(relativizeHtml(input), input);
  });

  test('preserves nested paths', () => {
    const input = '<img src="/icons/sun.svg">';
    assert.equal(relativizeHtml(input), '<img src="./icons/sun.svg">');
  });
});

describe('build', () => {
  function makeFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'skyo-build-'));
    const src = join(dir, 'src');
    const out = join(dir, 'out');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'index.html'), '<link href="/styles.css"><script src="/app.js"></script>');
    writeFileSync(join(src, 'app.js'), 'console.log("hi");');
    writeFileSync(join(src, 'styles.css'), 'body{}');
    return { dir, src, out };
  }

  test('copies source directory to output directory', () => {
    const { dir, src, out } = makeFixture();
    try {
      build({ srcDir: src, outDir: out });
      assert.ok(existsSync(join(out, 'index.html')));
      assert.ok(existsSync(join(out, 'app.js')));
      assert.ok(existsSync(join(out, 'styles.css')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('relativizes absolute-root paths in index.html', () => {
    const { dir, src, out } = makeFixture();
    try {
      build({ srcDir: src, outDir: out });
      const html = readFileSync(join(out, 'index.html'), 'utf8');
      assert.match(html, /href="\.\/styles\.css"/);
      assert.match(html, /src="\.\/app\.js"/);
      assert.doesNotMatch(html, /href="\/styles\.css"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('overwrites a previous output directory', () => {
    const { dir, src, out } = makeFixture();
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'stale.txt'), 'leftover');
    try {
      build({ srcDir: src, outDir: out });
      assert.equal(existsSync(join(out, 'stale.txt')), false, 'previous output must be cleared');
      assert.ok(existsSync(join(out, 'index.html')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws when source directory is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skyo-build-'));
    try {
      assert.throws(
        () => build({ srcDir: join(dir, 'does-not-exist'), outDir: join(dir, 'out') }),
        /does not exist/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('succeeds even when index.html is absent (other assets only)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'skyo-build-'));
    const src = join(dir, 'src');
    const out = join(dir, 'out');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'standalone.txt'), 'hello');
    try {
      build({ srcDir: src, outDir: out });
      assert.ok(existsSync(join(out, 'standalone.txt')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns srcDir and outDir paths for caller inspection', () => {
    const { dir, src, out } = makeFixture();
    try {
      const result = build({ srcDir: src, outDir: out });
      assert.deepEqual(result, { srcDir: src, outDir: out });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
