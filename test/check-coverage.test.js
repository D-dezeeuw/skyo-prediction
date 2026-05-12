import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoverageSummary } from '../scripts/check-coverage.mjs';

describe('parseCoverageSummary', () => {
  test('parses Node 24 info-prefixed coverage output', () => {
    const sample = [
      'ℹ start of coverage report',
      'ℹ ----------------------------------------------------------',
      'ℹ file      | line % | branch % | funcs % | uncovered lines',
      'ℹ ----------------------------------------------------------',
      'ℹ build.js  |  90.32 |    87.50 |  100.00 | 29-31',
      'ℹ public    |        |          |         | ',
      'ℹ  state.js | 100.00 |   100.00 |  100.00 | ',
      'ℹ ----------------------------------------------------------',
      'ℹ all files |  93.02 |    90.91 |  100.00 | ',
      'ℹ ----------------------------------------------------------',
      'ℹ end of coverage report',
    ].join('\n');
    assert.deepEqual(parseCoverageSummary(sample), {
      line: 93.02,
      branch: 90.91,
      funcs: 100,
    });
  });

  test('parses hash-prefixed coverage output (older Node)', () => {
    const sample = [
      '# start of coverage report',
      '# all files |  88.50 |    85.00 |   95.00 | ',
    ].join('\n');
    assert.deepEqual(parseCoverageSummary(sample), {
      line: 88.5,
      branch: 85,
      funcs: 95,
    });
  });

  test('returns null when no summary line is present', () => {
    assert.equal(parseCoverageSummary('no coverage here'), null);
  });

  test('returns null when summary cells are not numeric', () => {
    const sample = 'ℹ all files |  N/A   |    N/A   |   N/A   | ';
    assert.equal(parseCoverageSummary(sample), null);
  });

  test('returns null when summary has too few cells', () => {
    const sample = 'ℹ all files |  90.0';
    assert.equal(parseCoverageSummary(sample), null);
  });

  test('handles Windows-style line endings', () => {
    const sample = 'ℹ all files |  90.00 |  90.00 |  90.00 |\r\n';
    assert.deepEqual(parseCoverageSummary(sample), {
      line: 90,
      branch: 90,
      funcs: 90,
    });
  });
});
