import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  GROUPS,
  SECURITY_SUITES,
  STEPS,
  TIERS,
  checkWorkspaces,
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

test('the CLI fails quality:pr at the first step when a workspace lost its test script', () => {
  // A copy of the script in the fixture (its root is the parent of its directory), declaring the fixture's workspaces.
  const root = fixture({ appScripts: { typecheck: 'tsc --noEmit' } });
  const source = fs.readFileSync(script, 'utf8');
  const copy = source.replace(/export const WORKSPACES = \{[^}]*\};/, `export const WORKSPACES = ${JSON.stringify(declared)};`);
  assert.notEqual(copy, source);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts', 'quality.mjs'), copy);
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
