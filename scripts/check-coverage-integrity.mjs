#!/usr/bin/env node
/**
 * Coverage integrity guard (HeoPress P14 task 8.3, ADR-0017 §2).
 *
 * Coverage only means something while the bar stays where it is. Three edits quietly move it:
 *
 *   1. a threshold in `apps/cms/coverage-thresholds.json` is lowered (or a module is dropped, or a module loses one of
 *      its files — a threshold over fewer files is a lower bar);
 *   2. the coverage scope in `apps/cms/vitest.config.ts` narrows: an `include` pattern disappears, or an `exclude`
 *      pattern appears (measured code becomes unmeasured code, and the percentage goes up for free);
 *   3. an `istanbul ignore` / `v8 ignore` comment is added under `apps/cms/src` or `packages` (the coverage provider is
 *      told to pretend a line does not exist).
 *
 * Baselines only go up (`node scripts/coverage-baseline.mjs`); lowering one, narrowing the scope or ignoring code is a
 * deliberate edit that has to be reviewed as such. This script compares the working tree with the merge base of
 * `origin/main` and fails on any of the three. It needs the base commit to exist: a guard that cannot compare must not
 * report success.
 *
 *   node scripts/check-coverage-integrity.mjs [--base <git ref>] [--root <dir>] [--quiet]
 *
 * `--root` exists for the tests (a temporary repository); it is not a way to skip the comparison.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const THRESHOLDS_PATH = 'apps/cms/coverage-thresholds.json';
export const VITEST_CONFIG_PATH = 'apps/cms/vitest.config.ts';
export const METRICS = ['lines', 'branches', 'functions', 'statements'];
/** Paths whose diff may not add a coverage-ignore comment. */
export const IGNORE_PATHS = ['apps/cms/src', 'packages'];
/** `istanbul ignore`/`v8 ignore` in a comment — the two forms the coverage providers honour. */
const IGNORE_PATTERN = /\b(?:istanbul|v8)\s+ignore\b/;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The commit to compare with: `origin/main`'s merge base, unless the caller named one. */
export function resolveBase(root, explicit) {
  if (explicit) return explicit;
  // A CI checkout has no `origin/main` (one commit, no remote branches): the first parent is the base there, and a
  // repository with a single commit compares with itself. Both are weaker than the real merge base but never looser than
  // "nothing changed"; a caller that wants the real base passes `--base`.
  for (const ref of ['origin/main', 'HEAD^', 'HEAD']) {
    try {
      return git(root, ['merge-base', 'HEAD', ref]).trim();
    } catch {
      // try the next one
    }
  }
  throw new Error('cannot resolve a base commit (pass --base <ref>); coverage cannot be compared');
}

function readAt(root, ref, file) {
  try {
    return git(root, ['show', `${ref}:${file}`]);
  } catch {
    return null;
  }
}

/** Every threshold row of a thresholds file, keyed like `modules.permissions` / `other` / `target`. */
export function thresholdRows(config) {
  const rows = new Map();
  for (const [name, module] of Object.entries(config.modules ?? {})) rows.set(`modules.${name}`, module);
  if (config.other) rows.set('other', config.other);
  if (config.target) rows.set('target', config.target);
  return rows;
}

/**
 * A threshold may not go down, a module may not disappear, and a module may not lose one of its files. A higher value,
 * a new module and a new metric value are fine.
 */
export function thresholdViolations(base, head) {
  const violations = [];
  const headRows = thresholdRows(head);
  for (const [name, row] of thresholdRows(base)) {
    const next = headRows.get(name);
    if (!next) {
      violations.push(`${name}: the threshold row was removed`);
      continue;
    }
    for (const metric of METRICS) {
      if (typeof row.baseline?.[metric] !== 'number') continue;
      const value = next.baseline?.[metric];
      if (typeof value !== 'number') {
        violations.push(`${name}.${metric}: the baseline was removed (was ${row.baseline[metric]})`);
        continue;
      }
      if (value < row.baseline[metric]) violations.push(`${name}.${metric}: ${row.baseline[metric]} → ${value} (lowered)`);
    }
    if (Array.isArray(row.files)) {
      const files = new Set(next.files ?? []);
      for (const file of row.files) {
        if (!files.has(file)) violations.push(`${name}: ${file} left the module (the threshold now covers fewer files)`);
      }
    }
  }
  return violations;
}

/** The string literals of the first `key: [...]` array after `from`. */
function arrayAfter(text, key) {
  const start = text.search(new RegExp(`\\b${key}\\s*:\\s*\\[`));
  if (start < 0) return null;
  const open = text.indexOf('[', start);
  const close = text.indexOf(']', open);
  if (close < 0) return null;
  return [...text.slice(open + 1, close).matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
}

/**
 * The coverage scope of a Vitest config: `include` and `exclude` patterns under `coverage: { … }`. Returns null when it
 * cannot find them — an unverifiable scope is reported, never assumed unchanged.
 */
export function parseCoverageScope(configText) {
  const coverage = configText.search(/\bcoverage\s*:\s*\{/);
  if (coverage < 0) return null;
  const block = configText.slice(coverage);
  const include = arrayAfter(block, 'include');
  if (!include) return null;
  const exclude = arrayAfter(block, 'exclude') ?? [];
  return { include, exclude };
}

/** A narrower scope: an include pattern gone, or an exclude pattern added. */
export function scopeViolations(base, head) {
  const violations = [];
  if (!base || !head) {
    violations.push('the coverage scope cannot be parsed from vitest.config.ts (include/exclude must stay literal arrays)');
    return violations;
  }
  const baseInclude = new Set(base.include);
  const headInclude = new Set(head.include);
  for (const pattern of baseInclude) {
    if (!headInclude.has(pattern)) violations.push(`coverage.include: "${pattern}" was removed (the scope is narrower)`);
  }
  const baseExclude = new Set(base.exclude);
  for (const pattern of head.exclude) {
    if (!baseExclude.has(pattern)) violations.push(`coverage.exclude: "${pattern}" was added (the scope is narrower)`);
  }
  if (headInclude.size === 0) violations.push('coverage.include: the list is empty (nothing is measured)');
  return violations;
}

/** Added diff lines (`+…`, not `+++`) that introduce a coverage-ignore comment. */
export function ignoreCommentViolations(addedLines) {
  return addedLines
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .filter((line) => IGNORE_PATTERN.test(line))
    .map((line) => {
      const text = line.slice(1).trim();
      return `added: ${text.length > 120 ? `${text.slice(0, 117)}…` : text}`;
    });
}

/** Diff of the ignore-comment paths against `base`, as raw lines. */
export function ignoreDiff(root, base) {
  try {
    return git(root, ['diff', '--unified=0', base, '--', ...IGNORE_PATHS]).split('\n');
  } catch (error) {
    return [`+COULD NOT DIFF ${IGNORE_PATHS.join(' ')}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`];
  }
}

/**
 * Every violation of the three rules. `root` is a git checkout; `base` a commit in it. Throws when the thresholds file
 * cannot be read at `base` or in the working tree — absence is not agreement.
 */
export function check({ root, base: explicitBase }) {
  const base = resolveBase(root, explicitBase);
  const baseThresholds = readAt(root, base, THRESHOLDS_PATH);
  if (baseThresholds === null) throw new Error(`${THRESHOLDS_PATH} does not exist at ${base}: cannot compare thresholds`);
  const headFile = path.join(root, THRESHOLDS_PATH);
  if (!fs.existsSync(headFile)) throw new Error(`${THRESHOLDS_PATH} is missing from the working tree`);
  const baseConfig = readAt(root, base, VITEST_CONFIG_PATH);
  const headConfigFile = path.join(root, VITEST_CONFIG_PATH);
  const headConfig = fs.existsSync(headConfigFile) ? fs.readFileSync(headConfigFile, 'utf8') : null;

  const violations = [];
  violations.push(...thresholdViolations(JSON.parse(baseThresholds), JSON.parse(fs.readFileSync(headFile, 'utf8'))));
  if (baseConfig === null) {
    violations.push(`${VITEST_CONFIG_PATH} does not exist at ${base}: cannot compare the coverage scope`);
  } else if (headConfig === null) {
    violations.push(`${VITEST_CONFIG_PATH} is missing from the working tree`);
  } else {
    violations.push(...scopeViolations(parseCoverageScope(baseConfig), parseCoverageScope(headConfig)));
  }
  violations.push(...ignoreCommentViolations(ignoreDiff(root, base)));
  return { base, violations };
}

export function parseArgs(argv) {
  const options = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), base: undefined, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base') options.base = argv[++i];
    else if (arg === '--root') options.root = path.resolve(argv[++i]);
    else if (arg === '--quiet') options.quiet = true;
    else throw new Error(`unknown argument ${JSON.stringify(arg)}`);
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`[coverage-integrity] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let result;
  try {
    result = check({ root: options.root, base: options.base });
  } catch (error) {
    console.error(`[coverage-integrity] ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  if (result.violations.length === 0) {
    if (!options.quiet) console.log(`[coverage-integrity] thresholds, scope and ignore comments unchanged since ${result.base.slice(0, 12)}`);
    return 0;
  }
  console.error(`[coverage-integrity] ${result.violations.length} coverage-integrity violation(s) against ${result.base.slice(0, 12)}:`);
  for (const violation of result.violations) console.error(`  - ${violation}`);
  console.error('[coverage-integrity] baselines only go up (node scripts/coverage-baseline.mjs --update); fix the gap with tests, not with the threshold');
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
