#!/usr/bin/env node
/**
 * Unified quality commands (HeoPress P13 task 6.1, ADR-0017 §5).
 *
 *   pnpm quality:fast      local loop: workspace scripts, typecheck, lint, unit tests
 *   pnpm quality:pr        the PR gate: + repository guards, build, and the database suites as the application role
 *                          with the coverage thresholds of the critical modules
 *   pnpm quality:release   before a release: + OpenSpec strict, security scans, image runtime acceptance, Trivy
 *
 *   node scripts/quality.mjs <fast|pr|release> [--group <name>]... [--list]
 *
 * A tier is a list of groups; a group is a list of steps run in order, stopping at the first failure. `--group`
 * runs only the named groups of the tier — CI runs `pr` as two jobs (`static` without a database, `db` with
 * PostgreSQL and its test services); scripts/__tests__/quality.test.mjs checks that the CI workflow runs every group
 * of `pr`. `--list` prints the steps without running them.
 *
 * Nothing is skipped silently (ADR-0017 §5: no `--if-present`). Turbo runs a task only in the workspaces that
 * define its script, so the first step of every tier checks the workspaces themselves (`checkWorkspaces`): each
 * workspace is declared in `WORKSPACES` below, has the scripts declared for it (a placeholder such as
 * `echo … && exit 0` does not count), has a `test` script whenever it holds test files, and its sources are in the
 * root ESLint run. A step whose prerequisite is missing (a database, a scanner binary, Docker) fails; it is not
 * reported as passed.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every workspace and the scripts the quality commands rely on in it. `typecheck` everywhere (`pnpm typecheck`),
 * `test` wherever there are tests (`pnpm test`). A new workspace must be added here; one that holds test files
 * must list `test`, whatever this table says.
 */
export const WORKSPACES = {
  '@heopress/cms': ['typecheck', 'test', 'build'],
  '@heopress/studio': ['typecheck', 'test', 'build'],
  '@heopress/site-classic': ['typecheck', 'test', 'build'],
  '@heopress/site-astro': ['typecheck', 'test'],
  '@heopress/ai-skills': ['typecheck'],
  '@heopress/astro-kit': ['typecheck'],
  heopress: ['typecheck', 'test', 'build'],
  '@heopress/contracts': ['typecheck', 'build'],
  '@heopress/database': ['typecheck', 'test', 'migrate'],
  '@heopress/extension-cli': ['typecheck'],
  '@heopress/extension-sdk': ['typecheck', 'build'],
  '@heopress/extensions': ['typecheck'],
  '@heopress/mcp-server': ['typecheck', 'test', 'build'],
  '@heopress/plugin-glossary': ['typecheck', 'test', 'build'],
  '@heopress/public-site': ['typecheck', 'test'],
  '@heopress/runtime': ['typecheck', 'test'],
  '@heopress/sdk': ['typecheck', 'test', 'build'],
  '@heopress/seo-geo': ['typecheck', 'test'],
  '@heopress/ui': ['typecheck'],
};

/** Root scripts the steps call. */
export const ROOT_SCRIPTS = ['check:all', 'typecheck', 'lint', 'test', 'build'];

const TEST_FILE = /\.(test|spec)\.(c|m)?[jt]sx?$/;
const PLAYWRIGHT_DIRS = new Set(['e2e']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', '.astro', 'e2e-results', 'e2e-report']);

/** A script that does nothing: `echo …`, `exit 0`, `true`, `:` or an empty string, alone or chained. */
export function isPlaceholderScript(command) {
  const parts = String(command ?? '')
    .split(/&&|\|\||;/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return true;
  return parts.every((p) => /^(echo\b.*|exit\s+0|true|:)$/.test(p));
}

/** Workspace directories from pnpm-workspace.yaml (`dir/*` and plain directory entries). */
export function workspaceDirs(rootDir) {
  const yaml = fs.readFileSync(path.join(rootDir, 'pnpm-workspace.yaml'), 'utf8');
  const patterns = [];
  let inPackages = false;
  for (const line of yaml.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const m = line.match(/^\s+-\s+["']?([^"'#]+?)["']?\s*(#.*)?$/);
      if (m) patterns.push(m[1].trim());
      else if (/^\S/.test(line)) inPackages = false;
    }
  }
  const dirs = [];
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    if (pattern.endsWith('/*')) {
      const parent = path.join(rootDir, pattern.slice(0, -2));
      if (!fs.existsSync(parent)) continue;
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        const dir = path.join(pattern.slice(0, -2), entry.name);
        if (entry.isDirectory() && fs.existsSync(path.join(rootDir, dir, 'package.json'))) dirs.push(dir);
      }
    } else if (/[*?[]/.test(pattern)) {
      throw new Error(`pnpm-workspace.yaml: unsupported pattern ${pattern} (use dir/* or a directory)`);
    } else if (fs.existsSync(path.join(rootDir, pattern, 'package.json'))) {
      dirs.push(pattern);
    }
  }
  return dirs.sort();
}

/** Whether a workspace holds Vitest / node:test files (Playwright suites under e2e/ run from their own script). */
export function hasTestFiles(dir) {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || PLAYWRIGHT_DIRS.has(entry.name)) continue;
        stack.push(path.join(current, entry.name));
      } else if (TEST_FILE.test(entry.name)) {
        return true;
      }
    }
  }
  return false;
}

/** The path arguments of the root `lint` script's ESLint run. */
export function eslintPaths(lintScript) {
  const eslintRun = String(lintScript ?? '').split('&&')[0] ?? '';
  const tokens = eslintRun.trim().split(/\s+/);
  const at = tokens.findIndex((t) => /(^|\/)eslint(\.js)?$/.test(t));
  if (at < 0) return [];
  const paths = [];
  for (let i = at + 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.startsWith('-')) {
      // Options with a value: skip the value too.
      if (['--max-warnings', '--config', '-c', '--ext', '--rule', '--format', '-f'].includes(t)) i += 1;
      continue;
    }
    paths.push(t.replace(/\/+$/, ''));
  }
  return paths;
}

function hasSources(dir) {
  const src = path.join(dir, 'src');
  if (!fs.existsSync(src)) return false;
  const stack = [src];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(path.join(current, entry.name));
      } else if (/\.(c|m)?[jt]sx?$/.test(entry.name)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * The workspace check (first step of every tier). Returns the problems found; an empty list passes.
 * `declared` defaults to `WORKSPACES`.
 */
export function checkWorkspaces(rootDir, declared = WORKSPACES) {
  const problems = [];
  const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  for (const name of ROOT_SCRIPTS) {
    const cmd = rootPkg.scripts?.[name];
    if (cmd === undefined) problems.push(`root package.json: missing script "${name}"`);
    else if (isPlaceholderScript(cmd)) problems.push(`root package.json: script "${name}" is a placeholder (${cmd})`);
  }
  const linted = eslintPaths(rootPkg.scripts?.lint);
  const seen = new Set();
  for (const dir of workspaceDirs(rootDir)) {
    const abs = path.join(rootDir, dir);
    const pkg = JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8'));
    const name = pkg.name ?? dir;
    seen.add(name);
    const required = declared[name];
    if (!required) {
      problems.push(`${dir} (${name}): not declared in scripts/quality.mjs WORKSPACES — declare the scripts it must have`);
      continue;
    }
    const scripts = pkg.scripts ?? {};
    for (const script of required) {
      if (scripts[script] === undefined) problems.push(`${dir} (${name}): missing script "${script}"`);
      else if (isPlaceholderScript(scripts[script]))
        problems.push(`${dir} (${name}): script "${script}" is a placeholder (${scripts[script]})`);
    }
    if (hasTestFiles(abs)) {
      if (!required.includes('test')) {
        problems.push(`${dir} (${name}): has test files but WORKSPACES does not require a "test" script`);
      }
    }
    if (hasSources(abs) && !linted.some((p) => dir === p || dir.startsWith(`${p}/`) || `${dir}/src` === p)) {
      problems.push(`${dir} (${name}): its sources are not in the root ESLint run (package.json "lint")`);
    }
  }
  for (const name of Object.keys(declared)) {
    if (!seen.has(name)) problems.push(`WORKSPACES declares ${name}, which is not a workspace`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Steps, groups and tiers
// ---------------------------------------------------------------------------

const pnpm = (...args) => ({ cmd: 'pnpm', args });

function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    return `needs ${missing.join(', ')} (a disposable PostgreSQL 18: migrate as the owner, test as the application role; see AGENTS.md §8.3)`;
  }
  return null;
}

function requireBinary(envName, fallback) {
  const bin = process.env[envName] || fallback;
  const probe = spawnSync(bin, ['--version'], { stdio: 'ignore' });
  if (probe.error || probe.status !== 0) return { error: `needs ${fallback} on PATH or ${envName} set (not completed — never a pass)` };
  return { bin };
}

let scratch;
function scratchDir() {
  scratch ??= fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-quality-'));
  return scratch;
}

const IMAGE_TAG = process.env.HEOPRESS_QUALITY_IMAGE_TAG || 'quality';
const IMAGES = {
  cms: { ref: `heopress-cms:${IMAGE_TAG}`, build: ['build', '-f', 'docker/Dockerfile', '-t', `heopress-cms:${IMAGE_TAG}`, '.'] },
  'site-classic': {
    ref: `heopress-site-classic:${IMAGE_TAG}`,
    build: ['build', '-f', 'docker/Dockerfile', '--target', 'site-classic', '-t', `heopress-site-classic:${IMAGE_TAG}`, '.'],
  },
  postgres: {
    ref: `heopress-postgres:${IMAGE_TAG}`,
    build: ['build', '-f', 'docker/postgres/Dockerfile', '-t', `heopress-postgres:${IMAGE_TAG}`, 'docker/postgres'],
  },
};

/** Database suites: never with a superuser or without the owner URL (rls.db.test.ts checks the role itself). */
const dbPrecheck = () => {
  const missing = requireEnv(['DATABASE_URL', 'DATABASE_OWNER_URL']);
  if (missing) return missing;
  if (process.env.DATABASE_URL === process.env.DATABASE_OWNER_URL) {
    return 'DATABASE_URL must be the application role, not the owner (DATABASE_OWNER_URL)';
  }
  return null;
};

export const STEPS = {
  workspaces: { title: 'Workspaces declare the scripts the quality commands run (no silent skip)', internal: 'workspaces' },
  'check:all': { title: 'Repository guards (pnpm check:all)', ...pnpm('check:all') },
  typecheck: { title: 'Type check (pnpm typecheck)', ...pnpm('typecheck') },
  lint: { title: 'Lint (pnpm lint)', ...pnpm('lint') },
  // Turbo runs package tests side by side: never against a database (the DB suites reset it). Turbo's strict
  // environment mode drops DATABASE_URL already; it is removed here as well, explicitly.
  unit: { title: 'Unit tests, database suites skipped (pnpm test)', ...pnpm('test'), unsetEnv: ['DATABASE_URL'] },
  build: { title: 'Build (pnpm build)', ...pnpm('build') },
  'db:database': {
    title: 'Database package suites as the application role',
    ...pnpm('--filter', '@heopress/database', 'exec', 'vitest', '--run'),
    precheck: dbPrecheck,
  },
  'db:runtime': {
    title: 'Runtime adapter suites (PostgreSQL cache, rate limiter, queue, S3 when configured)',
    ...pnpm('--filter', '@heopress/runtime', 'exec', 'vitest', '--run'),
    precheck: dbPrecheck,
  },
  'db:cms': {
    title: 'CMS suites with the coverage thresholds of the critical modules (apps/cms/coverage-thresholds.json)',
    ...pnpm('--filter', '@heopress/cms', 'exec', 'vitest', '--run', '--coverage'),
    precheck: dbPrecheck,
  },
  openspec: {
    title: 'OpenSpec strict validation',
    cmd: 'npx',
    args: ['-y', '@fission-ai/openspec@1.14.1', 'validate', '--all', '--strict'],
    env: { OPENSPEC_TELEMETRY: '0' },
  },
  'security:exceptions': {
    title: 'Security exceptions complete and unexpired',
    cmd: 'node',
    args: ['scripts/check-security-scan.mjs', 'exceptions'],
  },
  'security:audit': {
    title: 'pnpm audit (high and critical; project audit ignores dropped)',
    run: () => [
      ['node', ['scripts/security-scanners.mjs', 'audit', '--dir', '.', '--report', path.join(scratchDir(), 'pnpm-audit.json')]],
      [
        'node',
        ['scripts/check-security-scan.mjs', 'pnpm-audit', '--report', path.join(scratchDir(), 'pnpm-audit.json'), '--ignores-dropped'],
      ],
    ],
  },
  'security:gitleaks': {
    // What is published is the public export of a commit, never the working tree (build output, private review
    // lists): scripts/public-export.mjs exports HEAD and scans it (private terms, gitleaks with the reviewed findings,
    // opaque files), then gitleaks runs over the export as security.yml does in the public repository. Commit first.
    title: 'Public export of HEAD scanned, then gitleaks over the export (as security.yml)',
    run: () => {
      const { bin, error } = requireBinary('GITLEAKS_BIN', 'gitleaks');
      if (error) return error;
      const out = path.join(scratchDir(), 'export');
      const report = path.join(scratchDir(), 'gitleaks.json');
      const exported = (...args) => ['sh', ['-c', 'cd "$0" && exec "$@"', out, ...args]];
      return [
        ['node', ['scripts/public-export.mjs', '--out', out]],
        exported('node', path.join(repoRoot, 'scripts/security-scanners.mjs'), 'gitleaks', '--dir', '.', '--report', report, '--bin', bin),
        exported('node', path.join(repoRoot, 'scripts/check-security-scan.mjs'), 'gitleaks', '--report', report, '--scan-root', '.'),
      ];
    },
  },
  'images:build': {
    title: `Build the production images (tag :${IMAGE_TAG})`,
    run: () => Object.values(IMAGES).map((image) => ['docker', image.build]),
  },
  'images:runtime': {
    title: 'Image runtime acceptance (docker/scripts/accept-image-runtime.sh)',
    cmd: 'docker/scripts/accept-image-runtime.sh',
    args: [],
    env: {
      HEOPRESS_CMS_IMAGE: IMAGES.cms.ref,
      HEOPRESS_SITE_IMAGE: IMAGES['site-classic'].ref,
      HEOPRESS_DB_IMAGE: IMAGES.postgres.ref,
      ACCEPT_SKIP_BUILD: 'true',
    },
  },
  'images:trivy': {
    title: 'Trivy over the three images (high and critical)',
    run: () => {
      const { bin, error } = requireBinary('TRIVY_BIN', 'trivy');
      if (error) return error;
      return Object.entries(IMAGES).flatMap(([name, image]) => {
        const report = path.join(scratchDir(), `trivy-${name}.json`);
        return [
          ['node', ['scripts/security-scanners.mjs', 'trivy', '--dir', '.', '--image', image.ref, '--report', report, '--bin', bin]],
          ['node', ['scripts/check-security-scan.mjs', 'trivy', '--report', report, '--image', name]],
        ];
      });
    },
  },
};

export const GROUPS = {
  fast: ['workspaces', 'typecheck', 'lint', 'unit'],
  static: ['workspaces', 'check:all', 'typecheck', 'lint', 'unit', 'build'],
  db: ['workspaces', 'db:database', 'db:runtime', 'db:cms'],
  release: [
    'workspaces',
    'openspec',
    'security:exceptions',
    'security:audit',
    'security:gitleaks',
    'images:build',
    'images:runtime',
    'images:trivy',
  ],
};

export const TIERS = {
  fast: ['fast'],
  pr: ['static', 'db'],
  release: ['static', 'db', 'release'],
};

/** The steps of a tier (or of some of its groups), in order, each once. */
export function planSteps(tier, groups = []) {
  const tierGroups = TIERS[tier];
  if (!tierGroups) throw new Error(`unknown tier "${tier}" (fast, pr, release)`);
  for (const g of groups) {
    if (!tierGroups.includes(g)) throw new Error(`tier "${tier}" has no group "${g}" (${tierGroups.join(', ')})`);
  }
  const chosen = groups.length > 0 ? tierGroups.filter((g) => groups.includes(g)) : tierGroups;
  const steps = [];
  for (const g of chosen) for (const s of GROUPS[g]) if (!steps.includes(s)) steps.push(s);
  return steps;
}

function parseArgs(argv) {
  const [tier, ...rest] = argv;
  const groups = [];
  let list = false;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--group') groups.push(rest[++i]);
    else if (rest[i] === '--list') list = true;
    else throw new Error(`unknown argument ${rest[i]}`);
  }
  return { tier, groups, list, root: repoRoot };
}

function runCommand(cmd, args, step, root) {
  const env = { ...process.env, ...(step.env ?? {}) };
  for (const name of step.unsetEnv ?? []) delete env[name];
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env });
  if (result.error) return `could not run ${cmd}: ${result.error.message}`;
  if (result.status !== 0) return `${cmd} ${args.join(' ')} exited with ${result.status ?? result.signal}`;
  return null;
}

function runStep(id, root) {
  const step = STEPS[id];
  if (step.internal === 'workspaces') {
    const problems = checkWorkspaces(root);
    for (const p of problems) console.error(`  - ${p}`);
    return problems.length > 0 ? `${problems.length} workspace problem(s)` : null;
  }
  const pre = step.precheck?.();
  if (pre) return pre;
  if (step.run) {
    const commands = step.run();
    if (typeof commands === 'string') return commands;
    for (const [cmd, args] of commands) {
      const failure = runCommand(cmd, args, step, root);
      if (failure) return failure;
    }
    return null;
  }
  return runCommand(step.cmd, step.args, step, root);
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (!opts.tier) throw new Error('usage: node scripts/quality.mjs <fast|pr|release> [--group <name>]... [--list]');
    opts.steps = planSteps(opts.tier, opts.groups);
  } catch (err) {
    console.error(`[quality] ${err.message}`);
    process.exit(2);
  }
  const label = `${opts.tier}${opts.groups.length ? ` (${opts.groups.join(', ')})` : ''}`;
  if (opts.list) {
    console.log(`quality:${label}`);
    for (const id of opts.steps) console.log(`  ${id}  ${STEPS[id].title}`);
    return;
  }
  const gha = process.env.GITHUB_ACTIONS === 'true';
  const done = [];
  for (const id of opts.steps) {
    const started = Date.now();
    console.log(gha ? `::group::[quality] ${id} — ${STEPS[id].title}` : `\n[quality] ${id} — ${STEPS[id].title}`);
    const failure = runStep(id, opts.root);
    if (gha) console.log('::endgroup::');
    const seconds = Math.round((Date.now() - started) / 1000);
    if (failure) {
      console.error(`[quality] FAILED ${id}: ${failure}`);
      for (const d of done) console.error(`[quality]   passed ${d}`);
      console.error(`[quality] quality:${label} failed at ${id}; the remaining steps did not run.`);
      process.exit(1);
    }
    done.push(`${id} (${seconds}s)`);
  }
  console.log(`\n[quality] quality:${label} passed: ${done.join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
