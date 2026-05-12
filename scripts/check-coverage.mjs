#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export function parseCoverageSummary(text) {
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const stripped = line.replace(/^ℹ\s*/, '').replace(/^#\s*/, '').trim();
    if (!stripped.startsWith('all files')) continue;
    const cells = stripped.split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const linePct = Number(cells[1]);
    const branchPct = Number(cells[2]);
    const funcsPct = Number(cells[3]);
    if ([linePct, branchPct, funcsPct].some(Number.isNaN)) continue;
    return { line: linePct, branch: branchPct, funcs: funcsPct };
  }
  return null;
}

/* node:coverage disable */
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const THRESHOLD = Number(process.env.COVERAGE_THRESHOLD ?? 85);
  const testFiles = readdirSync('test')
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => join('test', f));

  if (testFiles.length === 0) {
    console.error('No test files found in test/.');
    process.exit(2);
  }

  const result = spawnSync(
    'node',
    ['--test', '--experimental-test-coverage', ...testFiles],
    { encoding: 'utf8' },
  );

  const output = (result.stdout ?? '') + (result.stderr ?? '');
  process.stdout.write(output);

  if (result.status !== 0) {
    console.error(`\nTests failed (exit ${result.status}); skipping coverage gate.`);
    process.exit(result.status ?? 1);
  }

  const summary = parseCoverageSummary(output);
  if (!summary) {
    console.error('\nCould not locate "all files" coverage line in test output.');
    process.exit(2);
  }

  const failed = [];
  for (const [metric, value] of Object.entries(summary)) {
    if (value < THRESHOLD) failed.push(`${metric}=${value.toFixed(2)}%`);
  }

  if (failed.length) {
    console.error(`\nCoverage gate failed (threshold ${THRESHOLD}%): ${failed.join(', ')}`);
    process.exit(1);
  }

  console.log(
    `\nCoverage gate passed (threshold ${THRESHOLD}%): ` +
      Object.entries(summary)
        .map(([k, v]) => `${k}=${v.toFixed(2)}%`)
        .join(', '),
  );
}
/* node:coverage enable */
