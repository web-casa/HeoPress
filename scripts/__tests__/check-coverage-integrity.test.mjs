/**
 * Tripwire for the coverage-integrity guard (HeoPress P14 task 8.3).
 *
 * A guard that is always green proves nothing, so each of the three violations is exercised both as a unit and against
 * a real temporary git repository: a lowered threshold, a narrowed coverage scope, and an added `v8 ignore` comment
 * must each make the check fail; an unchanged tree must pass.
 *
 * Uses `node --test` like the other script guards (`scripts/__tests__/*.test.mjs`, run by `pnpm scripts:test`).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ignoreCommentViolations,
  METRICS,
  parseCoverageScope,
  scopeViolations,
  thresholdViolations,
} from '../check-coverage-integrity.mjs';

const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'check-coverage-integrity.mjs');

const thresholds = (baseline, extra = {}) => ({
  target: { lines: 90, branches: 85 },
  modules: {
    permissions: { files: ['src/a.ts', 'src/b.ts'], baseline: { lines: 84, branches: 72, functions: 92, statements: 80 } },
  },
  other: { baseline: { lines: 79, branches: 70, functions: 79, statements: 77 } },
  ...extra,
});

const config = (include = ['src/**/*.ts'], exclude = ['src/**/__tests__/**', 'src/**/*.test.ts']) => `
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: [${include.map((p) => `'${p}'`).join(', ')}],
      exclude: [${exclude.map((p) => `'${p}'`).join(', ')}],
      reporter: ['text-summary'],
    },
  },
});
`;

/** A throwaway git repository with the two files the guard reads and one source file. */
function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-integrity-'));
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  write('apps/cms/coverage-thresholds.json', `${JSON.stringify(thresholds(), null, 2)}\n`);
  write('apps/cms/vitest.config.ts', config());
  write('apps/cms/src/a.ts', 'export const a = 1;\n');
  write('packages/example/src/index.ts', 'export const example = 1;\n');
  const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  run('init', '--quiet');
  run('add', '--all');
  run('-c', 'user.email=guard@example.test', '-c', 'user.name=guard', 'commit', '--quiet', '-m', 'base');
  return { root, write, run, base: 'HEAD' };
}

/** The guard's exit code and output for a repository and base. */
function guard(repo, base = repo.base) {
  try {
    const stdout = execFileSync(process.execPath, [script, '--root', repo.root, '--base', base], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, output: stdout };
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const commit = (repo, message) => {
  repo.run('add', '--all');
  repo.run('-c', 'user.email=guard@example.test', '-c', 'user.name=guard', 'commit', '--quiet', '-m', message);
};

test('a clean tree passes', () => {
  const repo = makeRepo();
  const result = guard(repo);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /unchanged/);
});

test('lowering a threshold fails, naming the metric', () => {
  const base = thresholds();
  const lowered = thresholds();
  lowered.other.baseline.branches = 69;
  const violations = thresholdViolations(base, lowered);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /other\.branches: 70 → 69/);

  const repo = makeRepo();
  const file = path.join(repo.root, 'apps/cms/coverage-thresholds.json');
  const next = JSON.parse(fs.readFileSync(file, 'utf8'));
  next.modules.permissions.baseline.branches = 71;
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  const result = guard(repo);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /modules\.permissions\.branches: 72 → 71/);
});

test('raising a threshold or adding one is fine; dropping a module or one of its files is not', () => {
  const base = thresholds();
  const raised = thresholds();
  raised.other.baseline.branches = 74;
  raised.modules.permissions.baseline.lines = 85;
  assert.deepEqual(thresholdViolations(base, raised), []);

  const droppedModule = thresholds();
  delete droppedModule.modules.permissions;
  assert.match(thresholdViolations(base, droppedModule).join('\n'), /modules\.permissions: the threshold row was removed/);

  const fewerFiles = thresholds();
  fewerFiles.modules.permissions.files = ['src/a.ts'];
  assert.match(thresholdViolations(base, fewerFiles).join('\n'), /src\/b\.ts left the module/);

  const removedMetric = thresholds();
  delete removedMetric.other.baseline[METRICS[1]];
  assert.match(thresholdViolations(base, removedMetric).join('\n'), /other\.branches: the baseline was removed/);
});

test('dropping an include pattern or adding an exclude pattern fails', () => {
  const base = parseCoverageScope(config(['src/**/*.ts', '!src/generated/**']));
  assert.deepEqual(base.include, ['src/**/*.ts', '!src/generated/**']);

  const droppedInclude = parseCoverageScope(config(['src/**/*.ts']));
  assert.match(scopeViolations(base, droppedInclude).join('\n'), /coverage\.include: "!src\/generated\/\*\*" was removed/);

  const addedExclude = parseCoverageScope(config(['src/**/*.ts', '!src/generated/**'], ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/legacy/**']));
  assert.match(scopeViolations(base, addedExclude).join('\n'), /coverage\.exclude: "src\/legacy\/\*\*" was added/);

  // Widening the scope is allowed: a new include, or removing an exclude.
  const addedInclude = parseCoverageScope(config(['src/**/*.ts', '!src/generated/**', 'src/extra/**']));
  const narrowerExclude = parseCoverageScope(config(['src/**/*.ts', '!src/generated/**'], ['src/**/__tests__/**']));
  assert.deepEqual(scopeViolations(base, addedInclude), []);
  assert.deepEqual(scopeViolations(base, narrowerExclude), []);

  // An unparseable scope is a failure, never an assumption.
  assert.equal(parseCoverageScope('export default {}'), null);
  assert.match(scopeViolations(base, parseCoverageScope('export default {}')).join('\n'), /cannot be parsed/);

  const repo = makeRepo();
  fs.writeFileSync(path.join(repo.root, 'apps/cms/vitest.config.ts'), config(['src/**/*.ts'], ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/generated/**']));
  const result = guard(repo);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /coverage\.exclude: "src\/generated\/\*\*" was added/);
});

test('an added istanbul/v8 ignore comment fails; an existing or removed one does not', () => {
  assert.deepEqual(ignoreCommentViolations(['+export const a = 1;', '-// v8 ignore next', '+++ b/file.ts']), []);
  const violations = ignoreCommentViolations([
    '+// v8 ignore next',
    '+  /* istanbul ignore else */',
    '-// v8 ignore next',
    '+const fine = false;',
  ]);
  assert.equal(violations.length, 2);
  assert.match(violations.join('\n'), /v8 ignore next/);
  assert.match(violations.join('\n'), /istanbul ignore else/);
  // A line that merely mentions the words in prose is still an added comment the provider honours; the guard is
  // deliberately literal about the two forms.
  assert.equal(ignoreCommentViolations(['+const text = "istanbul ignore";']).length, 1);

  const repo = makeRepo();
  fs.appendFileSync(path.join(repo.root, 'apps/cms/src/a.ts'), '// v8 ignore next\nexport const b = a + 1;\n');
  const result = guard(repo);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /v8 ignore next/);
});

test('an ignore comment in packages counts too, and a removed one does not', () => {
  const repo = makeRepo();
  fs.appendFileSync(path.join(repo.root, 'packages/example/src/index.ts'), '/* istanbul ignore file */\n');
  const result = guard(repo);
  assert.equal(result.status, 1, result.output);

  const clean = makeRepo();
  fs.writeFileSync(path.join(clean.root, 'apps/cms/src/a.ts'), '// v8 ignore next\nexport const a = 1;\n');
  commit(clean, 'add an ignore comment');
  fs.writeFileSync(path.join(clean.root, 'apps/cms/src/a.ts'), 'export const a = 1;\n');
  const removed = guard(clean, 'HEAD~1');
  assert.equal(removed.status, 0, removed.output);
});

test('a missing thresholds file, at the base or in the tree, fails instead of passing', () => {
  // The base predates the thresholds file: there is no bar to compare with, so the guard must not report agreement.
  const repo = makeRepo();
  repo.run('rm', '--quiet', 'apps/cms/coverage-thresholds.json');
  commit(repo, 'drop the thresholds file');
  const missingAtBase = guard(repo, repo.base);
  assert.equal(missingAtBase.status, 2, missingAtBase.output);
  assert.match(missingAtBase.output, /missing from the working tree|does not exist/);

  // The file exists at the base but not in the working tree.
  const headOnly = makeRepo();
  fs.rmSync(path.join(headOnly.root, 'apps/cms/coverage-thresholds.json'));
  const missingHead = guard(headOnly);
  assert.equal(missingHead.status, 2, missingHead.output);
  assert.match(missingHead.output, /missing from the working tree/);
});

test('a base commit that does not exist fails with a comparison error', () => {
  const repo = makeRepo();
  const unknownBase = guard(repo, 'does-not-exist');
  assert.equal(unknownBase.status, 2, unknownBase.output);
  assert.match(unknownBase.output, /cannot|unknown revision|does not exist/i);
});

test('the real repository passes its own guard', () => {
  // The guard must be green on the tree it ships in: raising the baselines is the only change it sees. CI checks out a
  // single commit without `origin/main`, so compare with the first parent there (or with HEAD when the checkout has no
  // parent): no change is the same "nothing loosened" claim.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let base;
  try {
    base = git(['merge-base', 'HEAD', 'origin/main']);
  } catch {
    try {
      base = git(['rev-parse', 'HEAD^']);
    } catch {
      base = git(['rev-parse', 'HEAD']);
    }
  }
  const result = guard({ root }, base);
  assert.equal(result.status, 0, result.output);
});
