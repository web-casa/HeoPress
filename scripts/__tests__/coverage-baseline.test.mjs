import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { METRICS, THRESHOLDS_FILE, aggregate, cmsRelative, lowest, measure, raised } from '../coverage-baseline.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf8'));

const entry = (covered, total) =>
  Object.fromEntries(METRICS.map((m) => [m, { total, covered, skipped: 0, pct: total ? (covered / total) * 100 : 100 }]));

test('every critical module lists existing files, each in one module only', () => {
  // A renamed or deleted file would silently leave its module's threshold (a glob matching nothing passes).
  const seen = new Set();
  for (const [name, mod] of Object.entries(config.modules)) {
    assert.ok(mod.files.length > 0, `${name} has files`);
    for (const file of mod.files) {
      assert.ok(fs.existsSync(path.join(repoRoot, 'apps', 'cms', file)), `${name}: ${file} exists`);
      assert.ok(!seen.has(file), `${file} is in one module only`);
      seen.add(file);
    }
  }
  for (const name of ['permissions', 'site-scope', 'approvals', 'budgets', 'state-machines']) {
    assert.ok(config.modules[name], `module ${name}`);
  }
});

test('every baseline has the four metrics, between 0 and 100', () => {
  for (const baseline of [...Object.values(config.modules).map((m) => m.baseline), config.other.baseline]) {
    for (const m of METRICS) assert.ok(baseline[m] >= 0 && baseline[m] <= 100, `${m} = ${baseline[m]}`);
  }
});

test('modules aggregate their files; other is every file of the report', () => {
  const summary = {
    total: entry(0, 0),
    '/x/apps/cms/src/a.ts': entry(9, 10),
    [path.join(repoRoot, 'apps/cms/src/b.ts')]: entry(1, 10),
    'src/c.ts': entry(5, 10),
  };
  const cfg = { modules: { m: { files: ['src/b.ts', 'src/c.ts', 'src/gone.ts'], baseline: {} } }, other: { baseline: {} } };
  const measured = measure(cfg, summary);
  assert.equal(measured.m.pct.lines, 30);
  assert.deepEqual(measured.m.missing, ['src/gone.ts']);
  assert.equal(measured.other.pct.lines, 50);
  assert.equal(aggregate(summary, []).pct.lines, 100);
});

test('--update raises baselines to the measurement rounded down to whole points, never lowers one', () => {
  const cfg = {
    modules: { m: { files: ['src/b.ts'], baseline: { lines: 50, branches: 80, functions: 0, statements: 0 } } },
    other: { baseline: { lines: 99, branches: 0, functions: 0, statements: 0 } },
  };
  const next = raised(cfg, {
    m: { pct: { lines: 61.27, branches: 70, functions: 33.39, statements: 100 } },
    other: { pct: { lines: 10, branches: 5.55, functions: 0, statements: 0 } },
  });
  assert.deepEqual(next.modules.m.baseline, { lines: 61, branches: 80, functions: 33, statements: 100 });
  assert.deepEqual(next.other.baseline, { lines: 99, branches: 5, functions: 0, statements: 0 });
  assert.equal(cfg.modules.m.baseline.lines, 50, 'the input is not modified');
});

test('the CMS Vitest config applies the thresholds with an explicit coverage.include', () => {
  const vitestConfig = fs.readFileSync(path.join(repoRoot, 'apps', 'cms', 'vitest.config.ts'), 'utf8');
  assert.match(vitestConfig, /coverage-thresholds\.json/);
  assert.match(vitestConfig, /include: \['src\/\*\*\/\*\.ts'\]/);
  // Every run but a shard (`--shard`, partial coverage) checks them; CI checks them on the merge of the shards.
  assert.match(vitestConfig, /thresholds: sharded \? undefined : \{ \.\.\.coverageConfig\.other\.baseline, \.\.\.moduleThresholds \}/);
  assert.match(vitestConfig, /const sharded = process\.argv\.some\(\(arg\) => arg === '--shard' \|\| arg\.startsWith\('--shard='\)\);/);
});

test('several runs: the lowest value of each metric counts', () => {
  const run = (lines, branches) => ({
    m: { pct: { lines, branches, functions: 50, statements: 50 }, missing: [] },
    other: { pct: { lines: 70, branches: 60, functions: 50, statements: 50 }, missing: [] },
  });
  const low = lowest([run(93.2, 86.3), run(92.9, 85.5)]);
  assert.deepEqual(low.m.pct, { lines: 92.9, branches: 85.5, functions: 50, statements: 50 });
});

test('report keys from another checkout path resolve relative to apps/cms', () => {
  assert.equal(cmsRelative('/home/runner/work/HeoPress/HeoPress/apps/cms/src/services/a.ts'), 'src/services/a.ts');
  assert.equal(cmsRelative('src/services/a.ts'), 'src/services/a.ts');
  const entry = { lines: { total: 2, covered: 1 }, branches: { total: 0, covered: 0 }, functions: { total: 1, covered: 1 }, statements: { total: 2, covered: 1 } };
  const summary = { total: entry, '/elsewhere/repo/apps/cms/src/a.ts': entry };
  assert.deepEqual(aggregate(summary, ['src/a.ts']).missing, []);
  assert.equal(aggregate(summary, ['src/a.ts']).pct.lines, 50);
});
