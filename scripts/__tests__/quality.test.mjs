import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CMS_BLOB_DIR,
  GROUPS,
  SECURITY_SUITES,
  STACK_ENV_UNSET,
  STEPS,
  TIERS,
  checkBlobSet,
  checkMergedReport,
  checkWorkspaces,
  cmsBlobName,
  eslintPaths,
  isPlaceholderScript,
  planSteps,
} from '../quality.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repoRoot, 'scripts', 'quality.mjs');

/** A two-workspace monorepo: `@fx/app` with tests, `@fx/lib` without. */
function fixture({ appScripts, libScripts, lint } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-fixture-'));
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  };
  write('pnpm-workspace.yaml', 'packages:\n  - "apps/*"\n  - "packages/*"\n');
  write('package.json', {
    name: 'fx',
    scripts: {
      'check:all': 'node guards.mjs',
      typecheck: 'turbo run typecheck',
      lint: lint ?? 'node ./node_modules/eslint/bin/eslint.js --max-warnings 0 apps/app/src packages && turbo run lint',
      test: 'turbo run test',
      build: 'turbo run build',
    },
  });
  write('apps/app/package.json', {
    name: '@fx/app',
    scripts: appScripts ?? { typecheck: 'tsc --noEmit', test: 'vitest --run' },
  });
  write('apps/app/src/index.ts', 'export const a = 1;\n');
  write('apps/app/src/__tests__/index.test.ts', 'test("a", () => {});\n');
  write('packages/lib/package.json', { name: '@fx/lib', scripts: libScripts ?? { typecheck: 'tsc --noEmit' } });
  write('packages/lib/src/index.ts', 'export const b = 2;\n');
  return dir;
}

const declared = { '@fx/app': ['typecheck', 'test'], '@fx/lib': ['typecheck'] };

test('a complete fixture passes the workspace check', () => {
  assert.deepEqual(checkWorkspaces(fixture(), declared), []);
});

test('a workspace that lost its test script fails the check', () => {
  const problems = checkWorkspaces(fixture({ appScripts: { typecheck: 'tsc --noEmit' } }), declared);
  assert.deepEqual(problems, ['apps/app (@fx/app): missing script "test"']);
});

test('a workspace with tests must be declared as needing a test script', () => {
  const problems = checkWorkspaces(fixture(), { '@fx/app': ['typecheck'], '@fx/lib': ['typecheck'] });
  assert.deepEqual(problems, ['apps/app (@fx/app): has test files but WORKSPACES does not require a "test" script']);
});

test('placeholder scripts do not count', () => {
  const problems = checkWorkspaces(
    fixture({ appScripts: { typecheck: 'tsc --noEmit', test: 'echo "(no tests)" && exit 0' } }),
    declared,
  );
  assert.deepEqual(problems, ['apps/app (@fx/app): script "test" is a placeholder (echo "(no tests)" && exit 0)']);
  assert.equal(isPlaceholderScript('echo "(lint not configured)" && exit 0'), true);
  assert.equal(isPlaceholderScript('true'), true);
  assert.equal(isPlaceholderScript(''), true);
  assert.equal(isPlaceholderScript('vitest --run'), false);
  assert.equal(isPlaceholderScript('echo start && vitest --run'), false);
});

test('an undeclared workspace and a declared one that does not exist both fail', () => {
  const problems = checkWorkspaces(fixture(), { '@fx/app': ['typecheck', 'test'], '@fx/gone': ['typecheck'] });
  assert.deepEqual(problems, [
    'packages/lib (@fx/lib): not declared in scripts/quality.mjs WORKSPACES — declare the scripts it must have',
    'WORKSPACES declares @fx/gone, which is not a workspace',
  ]);
});

test('sources outside the root ESLint run fail', () => {
  const lint = 'node ./node_modules/eslint/bin/eslint.js --max-warnings 0 apps/app/src && turbo run lint';
  assert.deepEqual(checkWorkspaces(fixture({ lint }), declared), [
    'packages/lib (@fx/lib): its sources are not in the root ESLint run (package.json "lint")',
  ]);
  assert.deepEqual(eslintPaths(lint), ['apps/app/src']);
});

/** A copy of the script in the fixture (its root is the parent of its directory), declaring the fixture's workspaces. */
function scriptInFixture(root) {
  const source = fs.readFileSync(script, 'utf8');
  const copy = source.replace(/export const WORKSPACES = \{[^}]*\};/, `export const WORKSPACES = ${JSON.stringify(declared)};`);
  assert.notEqual(copy, source);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'quality.mjs'), copy);
  fs.copyFileSync(path.join(repoRoot, 'scripts', 'test-shards.mjs'), path.join(root, 'scripts', 'test-shards.mjs'));
}

test('the CLI fails quality:pr at the first step when a workspace lost its test script', () => {
  const root = fixture({ appScripts: { typecheck: 'tsc --noEmit' } });
  scriptInFixture(root);
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'quality.mjs'), 'pr'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing script "test"/);
  assert.match(result.stderr, /quality:pr failed at workspaces/);
});

test('the repository itself passes the workspace check', () => {
  assert.deepEqual(checkWorkspaces(repoRoot), []);
});

test('tiers build on each other and every step exists', () => {
  for (const groups of Object.values(GROUPS)) for (const step of groups) assert.ok(STEPS[step], step);
  const fast = planSteps('fast');
  const pr = planSteps('pr');
  const release = planSteps('release');
  assert.equal(fast[0], 'workspaces');
  for (const step of fast) assert.ok(pr.includes(step), `pr includes ${step}`);
  for (const step of pr) assert.ok(release.includes(step), `release includes ${step}`);
  assert.ok(pr.includes('db:cms'), 'pr runs the CMS suites with coverage');
  assert.throws(() => planSteps('pr', ['release']), /has no group/);
  assert.throws(() => planSteps('nightly'), /unknown tier/);
});

test('quality:release runs the security suites, and every listed suite file exists', () => {
  assert.ok(planSteps('release').includes('security:suites'));
  assert.ok(STEPS['security:suites'].precheck, 'the suites need the database');
  const dirs = { cms: 'apps/cms', runtime: 'packages/runtime' };
  for (const [ws, files] of Object.entries(SECURITY_SUITES)) {
    assert.ok(files.length > 0, ws);
    for (const file of files) assert.ok(fs.existsSync(path.join(repoRoot, dirs[ws], file)), `${dirs[ws]}/${file}`);
  }
});

test('the image acceptance never inherits the database, secrets or environment mode of the shell', () => {
  // quality:release runs the db group (DATABASE_URL set) before images:runtime; Compose would interpolate it.
  assert.deepEqual(STEPS['images:runtime'].unsetEnv, STACK_ENV_UNSET);
  const files = ['docker-compose.yml', 'docker-compose.sites.yml', 'docker-compose.accept.yml'];
  const interpolated = new Set(
    files.flatMap((f) => [...fs.readFileSync(path.join(repoRoot, 'docker', f), 'utf8').matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1])),
  );
  const sensitive = [...interpolated].filter((n) => /DATABASE|PASSWORD|SECRET|_KEY$|^HEOPRESS_ENV$/.test(n));
  assert.ok(sensitive.includes('DATABASE_URL'));
  for (const name of sensitive) assert.ok(STACK_ENV_UNSET.includes(name), `${name} is unset for the stack`);
});

test('the root package.json exposes the three commands', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  for (const tier of Object.keys(TIERS)) {
    assert.equal(pkg.scripts[`quality:${tier}`], `node scripts/quality.mjs ${tier}`);
  }
});

test('CI runs every group of quality:pr', () => {
  const ci = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const ran = new Set([...ci.matchAll(/node scripts\/quality\.mjs pr --group (\S+)/g)].map((m) => m[1]));
  assert.deepEqual([...ran].sort(), [...TIERS.pr].sort());
});

// ---------------------------------------------------------------------------
// The db group in shards (CI db-suites) and their merge (CI db-coverage)
// ---------------------------------------------------------------------------

test('without --shard the db group is the one-shot run of every suite, coverage thresholds included', () => {
  assert.deepEqual(planSteps('pr', ['db']), ['workspaces', 'db:database', 'db:runtime', 'db:cms']);
  assert.ok(STEPS['db:cms'].args.includes('--coverage'));
  assert.ok(!STEPS['db:cms'].args.some((a) => a.startsWith('--shard')), 'the one-shot run is not a shard');
});

test('a shard runs its CMS suites (shard 1 the package suites too); the merge runs the threshold step', () => {
  const shard = (index, count) => ({ shard: { index, count } });
  assert.deepEqual(planSteps('pr', ['db'], shard(1, 4)), ['workspaces', 'db:database', 'db:runtime', 'db:cms']);
  for (const i of [2, 3, 4]) assert.deepEqual(planSteps('pr', ['db'], shard(i, 4)), ['workspaces', 'db:cms']);
  assert.deepEqual(planSteps('pr', ['db'], { mergeShards: 4 }), ['workspaces', 'db:cms:merge']);
  // Every step of the one-shot run is in some shard or the merge.
  const covered = new Set([1, 2, 3, 4].flatMap((i) => planSteps('pr', ['db'], shard(i, 4))));
  for (const step of planSteps('pr', ['db'])) assert.ok(covered.has(step), step);
  assert.throws(() => planSteps('pr', [], shard(1, 4)), /pr --group db/);
  assert.throws(() => planSteps('pr', ['static', 'db'], shard(1, 4)), /pr --group db/);
  assert.throws(() => planSteps('release', ['db'], { mergeShards: 4 }), /pr --group db/);
  assert.throws(() => planSteps('pr', ['db'], { ...shard(1, 4), mergeShards: 4 }), /separate runs/);
});

test("a shard's CMS run keeps its blob and is cut by --shard; the one-shot run is not", () => {
  const variant = STEPS['db:cms'].sharded({ index: 3, count: 4 });
  assert.deepEqual(variant.args.slice(0, STEPS['db:cms'].args.length), STEPS['db:cms'].args);
  assert.ok(variant.args.includes('--shard=3/4'));
  assert.ok(variant.args.includes('--reporter=blob'));
  assert.ok(variant.args.includes(`--outputFile.blob=${path.join(CMS_BLOB_DIR, cmsBlobName(3, 4))}`));
  assert.equal(typeof variant.prepare, 'function', 'a stale blob is removed before the shard runs');
  assert.equal(STEPS['db:database'].sharded, undefined, 'package suites run whole, in shard 1');
});

test('the merge needs exactly the blobs of shards 1..n', () => {
  const all = [1, 2, 3, 4].map((i) => cmsBlobName(i, 4));
  assert.equal(checkBlobSet(all, 4), null);
  assert.equal(checkBlobSet([...all].reverse(), 4), null);
  assert.match(checkBlobSet(all.slice(1), 4), /missing shard blob\(s\): blob-1-4\.json/);
  assert.match(checkBlobSet([], 4), /missing shard blob\(s\): blob-1-4\.json, blob-2-4\.json, blob-3-4\.json, blob-4-4\.json/);
  assert.match(checkBlobSet([...all, 'blob-1-3.json'], 4), /unexpected file\(s\).*blob-1-3\.json/);
  assert.match(checkBlobSet(all.slice(0, 3), 3), /unexpected.*blob-1-4\.json/);
});

test('the merged report must hold every test file of the suite, all passed', () => {
  const cms = path.join(repoRoot, 'apps', 'cms');
  const listed = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts'].map((f) => ({ file: path.join(cms, f) }));
  const result = (f, status = 'passed') => ({ name: path.join(cms, f), status });
  const report = (results, extra = {}) => ({ testResults: results, numFailedTests: 0, numFailedTestSuites: 0, numPassedTests: 9, success: true, ...extra });
  const full = [result('src/a.test.ts'), result('src/b.test.ts'), result('src/c.test.ts')];
  assert.equal(checkMergedReport(report(full), listed), null);
  assert.match(checkMergedReport(report(full.slice(0, 2)), listed), /1 test file\(s\) in no shard: src\/c\.test\.ts/);
  assert.match(checkMergedReport(report([...full, result('src/z.test.ts')]), listed), /not in the suite: src\/z\.test\.ts/);
  assert.match(checkMergedReport(report([full[0], full[1], result('src/c.test.ts', 'failed')]), listed), /not passed: src\/c\.test\.ts/);
  assert.match(checkMergedReport(report(full, { numFailedTests: 1, success: false }), listed), /failed: 1 test/);
  assert.match(checkMergedReport(report([]), []), /no test files/);
});

test('the CLI merge fails when a shard blob is missing (never merges part of the suite)', () => {
  const root = fixture();
  scriptInFixture(root);
  const blobs = path.join(root, 'apps', 'cms', 'vitest-blobs');
  fs.mkdirSync(blobs, { recursive: true });
  for (const i of [1, 2, 4]) fs.writeFileSync(path.join(blobs, cmsBlobName(i, 4)), '[]');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'quality.mjs'), 'pr', '--group', 'db', '--merge-shards', '4'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAILED db:cms:merge: .*missing shard blob\(s\): blob-3-4\.json/);
  const bad = spawnSync(process.execPath, [script, 'pr', '--group', 'db', '--shard', '5/4', '--list'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /between 1 and 4/);
});

test('the CMS config checks no coverage threshold in a shard, and the full thresholds everywhere else', () => {
  const config = fs.readFileSync(path.join(repoRoot, 'apps', 'cms', 'vitest.config.ts'), 'utf8');
  assert.match(config, /const sharded = process\.argv\.some\(\(arg\) => arg === '--shard' \|\| arg\.startsWith\('--shard='\)\);/);
  assert.match(config, /thresholds: sharded \? undefined : \{ \.\.\.coverageConfig\.other\.baseline, \.\.\.moduleThresholds \}/);
  assert.match(config, /sequencer: DurationShardSequencer/);
});

test('CI: the shards, their count and the merge agree, and the merge fails closed', () => {
  const ci = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = (id) => {
    const at = ci.indexOf(`\n  ${id}:\n`);
    assert.ok(at >= 0, `job ${id}`);
    const next = ci.slice(at + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    return next < 0 ? ci.slice(at) : ci.slice(at, at + 1 + next);
  };
  const shards = job('db-suites');
  const matrix = /shard: \[([\d, ]+)\]/.exec(shards);
  assert.ok(matrix, 'db-suites is a matrix over shard');
  const indexes = matrix[1].split(',').map((n) => Number(n.trim()));
  const count = indexes.length;
  assert.ok(count >= 2);
  assert.deepEqual(indexes, Array.from({ length: count }, (_, i) => i + 1));
  assert.match(shards, /fail-fast: false/);
  assert.ok(shards.includes(`name: Database suites \${{ matrix.shard }}/${count} `));
  assert.ok(shards.includes(`node scripts/quality.mjs pr --group db --shard \${{ matrix.shard }}/${count}\n`));
  assert.ok(shards.includes(`path: apps/cms/vitest-blobs/blob-\${{ matrix.shard }}-${count}.json`));
  assert.match(shards, /if-no-files-found: error/);
  // Each shard keeps the whole job's setup: PostgreSQL 17 and 18, backup programs and settings, the drill.
  for (const must of ['image: postgres:18', 'image: postgres:17', 'HEOPRESS_TEST_PG17_URL', 'summarize_wal = on', 'host replication all all scram-sha-256', 'postgresql-18', 'HEOPRESS_TEST_BACKUP_TOOLS: required', 'HEOPRESS_TEST_PG_BIN_DIR', 'npx tsx scripts/cli.ts backup drill']) {
    assert.ok(shards.includes(must), `db-suites keeps ${must}`);
  }
  assert.doesNotMatch(shards, /\n {4}if:/, 'a shard is never skipped by a condition');
  const merge = job('db-coverage');
  assert.match(merge, /\n {4}needs: db-suites\n/);
  assert.match(merge, /\n {4}if: always\(\)\n/, 'the merge runs whatever happened to the shards');
  assert.match(merge, /SHARDS_RESULT: \$\{\{ needs\.db-suites\.result \}\}[\s\S]*test "\$SHARDS_RESULT" = success/);
  assert.ok(merge.includes(`node scripts/quality.mjs pr --group db --merge-shards ${count}\n`));
  assert.match(merge, /pattern: cms-shard-blob-\*/);
  assert.match(merge, /name: cms-coverage/);
  // No other job runs the db group: the merge is the only place CI checks the thresholds, and it always runs.
  assert.equal([...ci.matchAll(/node scripts\/quality\.mjs pr --group db\b/g)].length, 2);
});
