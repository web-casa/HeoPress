import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  appendRecordDurable,
  isPrivateRepositoryUrl,
  withFileLock,
  buildEnv,
  checkMainRef,
  checkTarget,
  confirmationCode,
  prepareRelease,
  PUBLIC_TARGETS,
  pushRelease,
  parseJournal,
  readPrivateReleases,
  releasesProblems,
  releaseTag,
  writeJsonDurable,
} from '../public-release.mjs';
import { NPM_REGISTRY } from '../security-scanners.mjs';
import { checkPublicRepo } from '../ci-mirror.mjs';

/**
 * The public release (ADR-0010; P07 tasks 7.3, 7.4, 7.6): the export builds on its own, everything is scanned again
 * after the build, the maintainer's confirmation holds for one exact tree, and the public history never carries a
 * private commit. Every push here goes to a bare repository made in a temporary directory (a file:// URL) — never to
 * a hosted repository.
 */

// Run from a git hook, the environment names the repository being committed to (GIT_DIR, …): dropped first.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

const madeDirs = [];
after(() => {
  for (const dir of madeDirs) fs.rmSync(dir, { recursive: true, force: true });
});
const tempDir = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  madeDirs.push(dir);
  return dir;
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TSC = path.join(ROOT, 'node_modules/typescript/bin/tsc');
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
/** An invented private term (an operator domain): the real list never appears in tests. */
const TERM = 'ops-farm.example.com';
const quiet = () => {};

/** The build of the fixtures: a real type check of the exported sources. */
const TYPECHECK = [[process.execPath, TSC, '-p', '.']];
/** A build step that runs a snippet of JavaScript in the build directory. */
const nodeStep = (code) => [process.execPath, '-e', code];

/**
 * A stand-in for gitleaks: reports every line holding `FIXTURE_SECRET_` (outside node_modules) where asked, and
 * refuses to run without the flags that keep the tree from configuring or silencing it.
 */
const GITLEAKS_STUB = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
for (const need of ['--ignore-gitleaks-allow', '--config', '--gitleaks-ignore-path', '--redact']) {
  if (!a.includes(need)) { console.error('missing ' + need); process.exit(2); }
}
const found = [];
const walk = (rel) => {
  for (const e of fs.readdirSync(rel || '.', { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(r); }
    else if (e.isFile()) fs.readFileSync(r, 'utf8').split('\\n').forEach((l, i) => {
      if (l.includes('FIXTURE_SECRET_')) found.push({ File: r, StartLine: i + 1, RuleID: 'generic-api-key' });
    });
  }
};
walk('');
fs.writeFileSync(a[a.indexOf('--report-path') + 1], JSON.stringify(found));
process.stderr.write('INF scanned ~100 bytes (100 bytes) in 1ms\\n');
`;

const LICENCES = ['LICENSE', 'LICENSE-EXCEPTION.md', 'COMMERCIAL-LICENSE.md', 'CLA.md', 'LICENSES/Apache-2.0.txt', 'NOTICE'];

/** A private repository to release from, a gitleaks stub, a state directory and an empty bare target. */
function fixture({ importLine = "import { helper } from './util';" } = {}) {
  const dir = tempDir('release-');
  const repo = path.join(dir, 'repo');
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(repo, rel), text);
  };
  write(
    'release/public-manifest.yaml',
    [
      'include:',
      '  - src/**',
      '  - docker/**',
      '  - release/**',
      ...['LICENSE', 'LICENSE-EXCEPTION.md', 'COMMERCIAL-LICENSE.md', 'CLA.md', 'LICENSES/**', 'NOTICE'].map((p) => `  - ${p}`),
      '  - .env.example',
      '  - tsconfig.json',
      'never:',
      '  - docs/handoffs/**',
      '',
    ].join('\n'),
  );
  write('release/private-terms.txt', `# invented for the tests\n${TERM}\n`);
  write('release/RELEASES.md', '# Releases\n\n| 版本 | 标签 | 日期 |\n|---|---|---|\n| 0.1.0 | `v0.1.0` | 2026-11-01 |\n| 0.2.0 | `v0.2.0` | 2026-12-01 |\n');
  for (const f of LICENCES) write(f, `${f}: the final text of this fixture\n`);
  write(
    'tsconfig.json',
    JSON.stringify({ compilerOptions: { strict: true, noEmit: true, module: 'esnext', moduleResolution: 'bundler', target: 'es2022', types: [], skipLibCheck: true }, include: ['src'] }),
  );
  write('src/util.ts', 'export const helper = (n: number): number => n + 1;\n');
  write('internal/private-helper.ts', 'export const helper = (n: number): number => n * 2;\n');
  write('src/index.ts', `${importLine}\nexport const answer: number = helper(41);\n`);
  write('docs/handoffs/2026-11-01.md', 'private progress notes\n');
  write('.env.example', 'JWT_SECRET=replace-me\n');
  write('docker/.env.example', 'POSTGRES_PASSWORD=replace-me\n');
  write('docker/.env', 'POSTGRES_PASSWORD=not-for-anyone\n');
  write('.env.local', 'LOCAL=1\n');
  const git = (args, opts = {}) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...ID }, ...opts }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['add', '-A']);
  git(['commit', '-qm', 'private work, with private history']);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gitleaks'), GITLEAKS_STUB, { mode: 0o755 });
  const target = path.join(dir, 'public.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', target]);
  return { dir, repo, git, write, bin, stateDir: path.join(dir, 'state'), target, targetUrl: pathToFileURL(target).href };
}

const withPath = (bin, fn) => {
  const prev = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${prev}`;
  try {
    return fn();
  } finally {
    process.env.PATH = prev;
  }
};

/** A security gate that passes (the gate itself is tested in release-security-gate.test.mjs); calls are recorded. */
const gateCalls = [];
const passingGate = (args) => {
  gateCalls.push(args);
  return { run: { url: 'https://github.example.com/runs/1' } };
};
const prepare = (fx, opts = {}) =>
  withPath(fx.bin, () =>
    prepareRelease({
      root: fx.repo,
      version: 'v0.1.0',
      target: fx.targetUrl,
      testTarget: true,
      mainRef: 'refs/heads/main',
      stateDir: fx.stateDir,
      steps: [nodeStep('')],
      stdio: 'pipe',
      log: quiet,
      security: passingGate,
      ...opts,
    }),
  );
const push = (fx, opts) => withPath(fx.bin, () => pushRelease({ root: fx.repo, version: 'v0.1.0', stateDir: fx.stateDir, log: quiet, security: passingGate, ...opts }));
const errorOf = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.message;
  }
  assert.fail('expected an error');
};
const targetGit = (fx, args) => execFileSync('git', ['--git-dir', fx.target, ...args], { encoding: 'utf8' }).trim();
const targetRefs = (fx) => targetGit(fx, ['for-each-ref', '--format=%(refname)']);

test('versions are tags; RELEASES.md must list the version and may hold no commit SHA; the code binds tree, commit, target, branch and tag', () => {
  assert.equal(releaseTag('v0.1.0'), 'v0.1.0');
  assert.equal(releaseTag('v1.2.3-rc.1'), 'v1.2.3-rc.1');
  for (const bad of ['0.1.0', 'v0.1', 'v01.0.0', 'v0.1.0/../x', '']) assert.throws(() => releaseTag(bad), /not a release version/);
  const table = '| 0.1.0 | `v0.1.0` | 2026-11-01 |\n';
  assert.deepEqual(releasesProblems(table, 'v0.1.0'), []);
  assert.match(releasesProblems(table, 'v0.2.0').join(), /does not list v0\.2\.0/);
  assert.match(releasesProblems(`${table}| 0.1.0 | ${'a'.repeat(40)} | x |\n`, 'v0.1.0').join(), /holds 1 commit ID/);
  // Shorter hex runs are commit IDs when the private repository knows them; other hex (a date, a colour) is not.
  const known = (hex) => 'abc1234def56'.startsWith(hex.toLowerCase());
  assert.match(releasesProblems(`${table}| note | fixes ABC1234 and abc1234def56 |\n`, 'v0.1.0', { isPrivateObject: known }).join(), /holds 2 commit ID/);
  assert.deepEqual(releasesProblems(`${table}| note | colour ffffff, build 20261101 |\n`, 'v0.1.0', { isPrivateObject: known }), []);
  const base = { tree: 't'.repeat(40), privateCommit: 'p'.repeat(40), target: 'file:///x', branch: 'main', tag: 'v0.1.0', trust: 'a'.repeat(64) };
  const code = confirmationCode(base);
  for (const change of [{ tree: 'u'.repeat(40) }, { privateCommit: 'q'.repeat(40) }, { target: 'file:///y' }, { branch: 'next' }, { tag: 'v0.1.1' }, { trust: 'b'.repeat(64) }]) {
    assert.notEqual(confirmationCode({ ...base, ...change }), code, JSON.stringify(change));
  }
  assert.throws(() => confirmationCode({ ...base, trust: undefined }), /reviewed security trust files/);
});

test('the build sees no secret, database or host tool configuration: the tool path and locale, the rest its own', () => {
  const envDir = path.join(tempDir('build-env-'), 'env');
  const host = {
    PATH: '/bin',
    LANG: 'C.UTF-8',
    HOME: '/home/maintainer',
    DATABASE_URL: 'postgresql://example.com/db',
    HEOPRESS_SECRET: 'x',
    GITHUB_TOKEN: 'y',
    NODE_OPTIONS: '--require /home/maintainer/preload.cjs',
    NPM_CONFIG_REGISTRY: 'https://npm.private.example.com/',
    npm_config_registry: 'https://npm.private.example.com/',
    npm_config_store_dir: '/home/maintainer/.pnpm-store',
    PNPM_HOME: '/home/maintainer/.pnpm',
    COREPACK_HOME: '/home/maintainer/.corepack',
    XDG_CACHE_HOME: '/home/maintainer/.cache',
  };
  const env = buildEnv(envDir, host);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(env.npm_config_registry, NPM_REGISTRY);
  for (const key of ['HOME', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'TMPDIR', 'COREPACK_HOME', 'npm_config_cache', 'npm_config_store_dir', 'npm_config_userconfig', 'npm_config_globalconfig']) {
    assert.ok(env[key].startsWith(`${envDir}${path.sep}`), `${key}=${env[key]}`);
  }
  assert.equal(fs.readFileSync(env.npm_config_userconfig, 'utf8'), '');
  for (const key of ['DATABASE_URL', 'HEOPRESS_SECRET', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'NPM_CONFIG_REGISTRY', 'PNPM_HOME']) assert.equal(env[key], undefined, key);
});

test('7.3: an export that imports a module the manifest does not export fails to build, and nothing is prepared', () => {
  const fx = fixture({ importLine: "import { helper } from '../internal/private-helper';" });
  const message = errorOf(() => prepare(fx, { steps: TYPECHECK }));
  assert.match(message, /build step "node .*tsc -p \." failed[\s\S]*does not build on its own\n.*TS2307: Cannot find module '\.\.\/internal\/private-helper'/);
  assert.ok(!fs.existsSync(path.join(fx.stateDir, 'v0.1.0', 'prepared.json')));
});

test('7.4 rehearsal: prepare, confirm and push to a local bare repository; the record is written only after the push', () => {
  const fx = fixture();
  // The maintainer's machine: a database, a private registry in ~/.npmrc, a NODE_OPTIONS preload setting.
  const hostHome = tempDir('host-home-');
  fs.writeFileSync(path.join(hostHome, '.npmrc'), 'registry=https://npm.private.example.com/\n');
  const host = { DATABASE_URL: 'postgresql://example.com/must-not-be-seen', HOME: hostHome, NODE_OPTIONS: '--max-old-space-size=4097', npm_config_registry: 'https://npm.private.example.com/' };
  const saved = Object.fromEntries(Object.keys(host).map((k) => [k, process.env[k]]));
  Object.assign(process.env, host);
  const sees = `const e = process.env, h = ${JSON.stringify(hostHome)};
    const rc = require('path').join(e.HOME, '.npmrc');
    if (e.DATABASE_URL) process.exit(3);
    if (e.NODE_OPTIONS) process.exit(4);
    if (e.HOME === h || !e.HOME) process.exit(5);
    if (e.npm_config_registry !== ${JSON.stringify(NPM_REGISTRY)}) process.exit(6);
    if (require('fs').existsSync(rc) && require('fs').readFileSync(rc, 'utf8').includes('private')) process.exit(7);`;
  let prepared;
  try {
    prepared = prepare(fx, { steps: [...TYPECHECK, nodeStep(sees)] });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  assert.match(prepared.tree, /^[0-9a-f]{40}$/);
  assert.equal(prepared.code, confirmationCode({ tree: prepared.tree, privateCommit: fx.git(['rev-parse', 'HEAD']), target: fx.targetUrl, branch: 'main', tag: 'v0.1.0', trust: prepared.trust }));
  // Prepared, not pushed: the target is untouched and nothing is recorded.
  assert.equal(targetRefs(fx), '');
  assert.deepEqual(readPrivateReleases(fx.repo), []);

  const record = push(fx, { confirm: prepared.code });
  const privateHead = fx.git(['rev-parse', 'HEAD']);
  assert.equal(targetGit(fx, ['rev-parse', 'refs/heads/main']), record.publicCommit);
  assert.equal(targetGit(fx, ['rev-parse', 'refs/tags/v0.1.0^{commit}']), record.publicCommit);
  assert.equal(targetGit(fx, ['cat-file', '-t', 'refs/tags/v0.1.0']), 'tag'); // annotated
  assert.equal(targetGit(fx, ['rev-parse', `${record.publicCommit}^{tree}`]), prepared.tree);
  // One public commit, no parent, a fixed identity, nothing of the private commit in it.
  assert.equal(targetGit(fx, ['rev-list', '--count', 'main']), '1');
  const meta = targetGit(fx, ['log', '-1', '--format=%an <%ae>|%cn <%ce>|%B', 'main']);
  assert.equal(meta, 'HeoPress Release <release@heopress.invalid>|HeoPress Release <release@heopress.invalid>|release: HeoPress v0.1.0');
  const files = targetGit(fx, ['ls-tree', '-r', '--name-only', 'main']).split('\n');
  for (const must of ['src/index.ts', 'src/util.ts', '.env.example', 'docker/.env.example', 'release/RELEASES.md', ...LICENCES]) assert.ok(files.includes(must), `missing ${must}`);
  for (const never of ['docs/handoffs/2026-11-01.md', 'release/private-terms.txt', 'docker/.env', '.env.local', 'internal/private-helper.ts']) assert.ok(!files.includes(never), `published ${never}`);
  assert.ok(!targetGit(fx, ['cat-file', '-p', 'main']).includes(privateHead));
  // The private mapping, after the push only.
  assert.deepEqual(
    readPrivateReleases(fx.repo).map((r) => [r.tag, r.privateCommit, r.publicCommit, r.tree, r.target]),
    [['v0.1.0', privateHead, record.publicCommit, prepared.tree, fx.targetUrl]],
  );
  // The same version twice: refused before anything happens.
  assert.match(errorOf(() => prepare(fx)), /v0\.1\.0 is already released/);

  // The next version goes on top of the public history, which stays public commits only.
  fx.write('src/util.ts', 'export const helper = (n: number): number => n + 2;\n');
  fx.git(['commit', '-qam', 'more private work']);
  const next = prepare(fx, { version: 'v0.2.0' });
  const second = push(fx, { version: 'v0.2.0', confirm: next.code });
  assert.equal(targetGit(fx, ['rev-list', '--count', 'main']), '2');
  assert.equal(targetGit(fx, ['rev-parse', 'main^']), record.publicCommit);
  assert.equal(targetGit(fx, ['rev-parse', 'refs/tags/v0.2.0^{commit}']), second.publicCommit);
  assert.equal(readPrivateReleases(fx.repo).length, 2);
});

test('7.6: a secret or a private term the build writes stops the release — the scan before the build is not reused', () => {
  const termed = fixture();
  const message = errorOf(() => prepare(termed, { steps: [nodeStep(`fs.mkdirSync('dist'); fs.writeFileSync('dist/about.txt', 'built\\nfor ${TERM}\\n')`)] }));
  assert.match(message, /the build produced content that must not leave:\nprivate terms in the export:\n {2}dist\/about\.txt:2 \(term #1\)/);
  assert.ok(!message.includes(TERM), 'the report names file and line, never the term');

  const leaked = fixture();
  const secret = errorOf(() => prepare(leaked, { steps: [nodeStep("fs.writeFileSync('src/generated.ts', 'export const k = 1;\\nexport const key = \"FIXTURE_SECRET_abc\";\\n')")] }));
  assert.match(secret, /the build produced content that must not leave:\ngitleaks findings not reviewed[\s\S]*src\/generated\.ts:2 generic-api-key/);
  assert.ok(!secret.includes('FIXTURE_SECRET_abc'));

  // A build that rewrites an exported source: what was built is not what would be published.
  const drift = fixture();
  assert.match(errorOf(() => prepare(drift, { steps: [nodeStep("fs.appendFileSync('src/util.ts', '// changed\\n')")] })), /the build changed exported files[\s\S]*src\/util\.ts/);
  for (const fx of [termed, leaked, drift]) assert.ok(!fs.existsSync(path.join(fx.stateDir, 'v0.1.0', 'prepared.json')));
});

test('7.6: a tree changed after confirmation, or a code for another target, is not pushed and nothing is recorded', () => {
  const fx = fixture();
  const prepared = prepare(fx);
  const treeDir = path.join(fx.stateDir, 'v0.1.0', 'tree');
  const original = fs.readFileSync(path.join(treeDir, 'src/util.ts'));

  // Another tree, target or tag than the one confirmed.
  const privateCommit = fx.git(['rev-parse', 'HEAD']);
  const otherTarget = confirmationCode({ tree: prepared.tree, privateCommit, target: 'file:///elsewhere.git', branch: 'main', tag: 'v0.1.0', trust: prepared.trust });
  assert.match(errorOf(() => push(fx, { confirm: otherTarget })), /changed after confirmation, or the code confirms another tree, commit, target or tag/);
  const otherCommit = confirmationCode({ tree: prepared.tree, privateCommit: 'f'.repeat(40), target: fx.targetUrl, branch: 'main', tag: 'v0.1.0', trust: prepared.trust });
  assert.match(errorOf(() => push(fx, { confirm: otherCommit })), /code confirms another tree, commit, target or tag/);
  // A code for other (unreviewed) versions of the security trust files.
  const otherTrust = confirmationCode({ tree: prepared.tree, privateCommit, target: fx.targetUrl, branch: 'main', tag: 'v0.1.0', trust: 'c'.repeat(64) });
  assert.match(errorOf(() => push(fx, { confirm: otherTrust })), /security trust files changed after confirmation/);

  // A changed file.
  fs.writeFileSync(path.join(treeDir, 'src/util.ts'), 'export const helper = (n: number): number => n - 1;\n');
  assert.match(errorOf(() => push(fx, { confirm: prepared.code })), /the tree differs from the export at src\/util\.ts/);
  fs.writeFileSync(path.join(treeDir, 'src/util.ts'), original);

  // An environment file, a link leaving the tree, a hard link: each fails the checks of the final tree.
  fs.writeFileSync(path.join(treeDir, 'docker/.env'), 'POSTGRES_PASSWORD=x\n');
  assert.match(errorOf(() => push(fx, { confirm: prepared.code })), /environment files[\s\S]*docker\/\.env/);
  fs.rmSync(path.join(treeDir, 'docker/.env'));
  fs.symlinkSync('../../../repo/docs/handoffs', path.join(treeDir, 'src/notes'));
  assert.match(errorOf(() => push(fx, { confirm: prepared.code })), /symbolic links leaving the export:\n {2}src\/notes ->/);
  fs.rmSync(path.join(treeDir, 'src/notes'));
  fs.linkSync(path.join(treeDir, 'src/util.ts'), path.join(fx.dir, 'outside-link.ts'));
  assert.match(errorOf(() => push(fx, { confirm: prepared.code })), /hard links[\s\S]*src\/util\.ts/);
  fs.rmSync(path.join(fx.dir, 'outside-link.ts'));

  assert.equal(targetRefs(fx), '');
  assert.deepEqual(readPrivateReleases(fx.repo), []);
  // Restored exactly, the confirmed tree pushes.
  assert.equal(push(fx, { confirm: prepared.code }).tree, prepared.tree);
});

test('7.6: a target whose history holds a private commit is refused (public history never carries private history)', () => {
  const fx = fixture();
  const prepared = prepare(fx);
  // An accident to guard against: a private commit pushed to the public branch (a local bare test repository).
  const privateHead = fx.git(['rev-parse', 'HEAD']);
  fx.git(['push', '-q', fx.targetUrl, 'HEAD:refs/heads/main']);
  const message = errorOf(() => push(fx, { confirm: prepared.code }));
  assert.match(message, /the public history would hold commits of the private repository/);
  assert.ok(message.includes(privateHead.slice(0, 12)));
  assert.equal(targetGit(fx, ['rev-parse', 'refs/heads/main']), privateHead);
  assert.ok(!targetRefs(fx).includes('refs/tags/'));
  assert.deepEqual(readPrivateReleases(fx.repo), []);
});

test('7.7: a release without every final licence file does not prepare', () => {
  const missing = fixture();
  fs.rmSync(path.join(missing.repo, 'CLA.md'));
  missing.git(['commit', '-qam', 'drop the CLA']);
  assert.match(errorOf(() => prepare(missing)), /licence files a release must carry[\s\S]*CLA\.md \(missing\)/);

  const draft = fixture();
  draft.write('LICENSE-EXCEPTION.md', '# HeoPress Plugin and Theme Exception — DRAFT\n\ntext\n');
  draft.git(['commit', '-qam', 'the draft as the exception']);
  assert.match(errorOf(() => prepare(draft)), /LICENSE-EXCEPTION\.md \(a draft: the final, reviewed text is required\)/);
});

test('the commit to release must list its version in RELEASES.md', () => {
  const fx = fixture();
  assert.match(errorOf(() => prepare(fx, { version: 'v0.3.0' })), /release\/RELEASES\.md does not list v0\.3\.0/);
  assert.throws(() => prepare(fx, { target: '' }), /target repository URL is required/);
});

test('8.1: no release without a passing security scan of the exact tree — prepare stops before the build, push checks again', () => {
  const fx = fixture();
  const failing = () => {
    throw new Error('the security gate is not passed: the run of .github/workflows/security.yml concluded failure');
  };
  const message = errorOf(() => prepare(fx, { security: failing, steps: [nodeStep("require('fs').writeFileSync('built', '')")] }));
  assert.match(message, /security gate is not passed/);
  assert.ok(!fs.existsSync(path.join(fx.stateDir, 'v0.1.0', 'build', 'built')), 'the build did not run');
  assert.ok(!fs.existsSync(path.join(fx.stateDir, 'v0.1.0', 'prepared.json')), 'nothing is prepared');

  // The gate sees the released commit and the exported tree it publishes; its evidence is kept with the prepared release.
  gateCalls.length = 0;
  const prepared = prepare(fx);
  assert.equal(gateCalls.length, 1);
  assert.equal(gateCalls[0].sha, fx.git(['rev-parse', 'HEAD']));
  assert.equal(gateCalls[0].treeDir, prepared.treeDir);
  assert.ok(gateCalls[0].entries.some((e) => e.file === 'src/index.ts'));
  const saved = JSON.parse(fs.readFileSync(path.join(prepared.dir, 'prepared.json'), 'utf8'));
  assert.deepEqual(saved.security, { run: { url: 'https://github.example.com/runs/1' } });

  // Between prepare and push the gate fails (an exception expired, the run grew old): nothing is pushed or recorded.
  assert.match(errorOf(() => push(fx, { confirm: prepared.code, security: failing })), /security gate is not passed/);
  assert.equal(targetRefs(fx), '');
  assert.deepEqual(readPrivateReleases(fx.repo), []);
});

test('P2: RELEASES.md naming a private commit by a 7- or 12-digit abbreviation is refused', () => {
  for (const digits of [7, 12]) {
    const fx = fixture();
    const id = fx.git(['rev-parse', 'HEAD']).slice(0, digits);
    fx.write('release/RELEASES.md', `# Releases\n\n| 版本 | 标签 | 日期 | 说明 |\n|---|---|---|---|\n| 0.1.0 | \`v0.1.0\` | 2026-11-01 | built from ${id} |\n`);
    fx.git(['commit', '-qam', 'release notes']);
    assert.match(errorOf(() => prepare(fx)), /release\/RELEASES\.md holds 1 commit ID\(s\)/, `${digits} digits`);
  }
});

test('P2: only a commit merged into the private main branch is released, and the code binds that commit', () => {
  const fx = fixture();
  fx.git(['checkout', '-q', '-b', 'feature/experimental']);
  fx.write('src/util.ts', 'export const helper = (n: number): number => n + 3;\n');
  fx.git(['commit', '-qam', 'unmerged work']);
  const feature = fx.git(['rev-parse', 'HEAD']);
  assert.match(errorOf(() => prepare(fx, { commit: feature })), new RegExp(`${feature.slice(0, 8)} is not merged into refs/heads/main`));
  assert.match(errorOf(() => prepare(fx, { commit: feature, mainRef: 'refs/remotes/origin/main' })), /refs\/remotes\/origin\/main does not exist/);
  // Merged, it prepares; the code names the private commit.
  fx.git(['checkout', '-q', 'main']);
  fx.git(['merge', '-q', '--ff-only', 'feature/experimental']);
  const prepared = prepare(fx, { commit: feature });
  assert.equal(prepared.code, confirmationCode({ tree: prepared.tree, privateCommit: feature, target: fx.targetUrl, branch: 'main', tag: 'v0.1.0', trust: prepared.trust }));
});

test('P3: the target must be web-casa/HeoPress; a local file:// repository only with the test override; the mirror pushes nowhere else', () => {
  for (const url of PUBLIC_TARGETS) assert.equal(checkTarget(url), url);
  for (const url of ['https://github.com/web-casa/HeoPress-fork.git', 'https://example.com/web-casa/HeoPress.git', 'file:///tmp/x.git', 'git@github.com:someone/HeoPress.git']) {
    assert.throws(() => checkTarget(url), /is not the public repository web-casa\/HeoPress/, url);
  }
  assert.equal(checkTarget('file:///tmp/x.git', { testTarget: true }), 'file:///tmp/x.git');
  assert.throws(() => checkTarget('https://example.com/x.git', { testTarget: true }), /--test-target allows only a local file:\/\/\/ test repository/);
  const fx = fixture();
  assert.match(errorOf(() => prepare(fx, { testTarget: false })), /not the public repository/);
  assert.equal(checkPublicRepo('web-casa/HeoPress'), 'web-casa/HeoPress');
  assert.throws(() => checkPublicRepo('someone/HeoPress'), /refusing to push the mirror to "someone\/HeoPress"/);
});

test('P3: a shallow private repository is refused (its history check would be blind)', () => {
  const fx = fixture();
  fx.write('src/util.ts', 'export const helper = (n: number): number => n + 4;\n');
  fx.git(['commit', '-qam', 'a second commit']);
  const shallow = path.join(fx.dir, 'shallow');
  execFileSync('git', ['clone', '-q', '--depth', '1', pathToFileURL(fx.repo).href, shallow]);
  assert.match(errorOf(() => prepare({ ...fx, repo: shallow })), /the private repository is a shallow clone/);
});

test('P2: a push interrupted after it reached the target is completed by the retry with the same code', () => {
  const fx = fixture();
  const prepared = prepare(fx);
  const crash = () => {
    throw new Error('simulated crash after the push');
  };
  assert.match(errorOf(() => push(fx, { confirm: prepared.code, hooks: { afterPush: crash } })), /simulated crash/);
  // Public, but not recorded: the intent is pending.
  const publicCommit = targetGit(fx, ['rev-parse', 'refs/tags/v0.1.0^{commit}']);
  assert.deepEqual(readPrivateReleases(fx.repo), []);
  const intentFile = path.join(fx.stateDir, 'v0.1.0', 'push-intent.json');
  assert.equal(JSON.parse(fs.readFileSync(intentFile, 'utf8')).status, 'pending');
  // prepare again would discard the pending push: it refuses, and says how to complete it.
  assert.match(errorOf(() => prepare(fx)), /v0\.1\.0 has a pending push that reached .* but was not recorded: complete it with "node scripts\/public-release\.mjs push --version v0\.1\.0 --confirm <the same code>"/);
  assert.equal(JSON.parse(fs.readFileSync(intentFile, 'utf8')).status, 'pending', 'the intent is kept');
  // Another code does not complete it.
  const other = confirmationCode({ tree: prepared.tree, privateCommit: 'f'.repeat(40), target: fx.targetUrl, branch: 'main', tag: 'v0.1.0', trust: prepared.trust });
  assert.match(errorOf(() => push(fx, { confirm: other })), /pending push of v0\.1\.0 was confirmed with another code/);
  // The retry finds the tag at the intent's commit and tree and records it — without pushing again.
  const recovered = push(fx, { confirm: prepared.code, security: () => assert.fail('no new push, no new gate') });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.publicCommit, publicCommit);
  assert.deepEqual(
    readPrivateReleases(fx.repo).map((r) => [r.tag, r.privateCommit, r.publicCommit, r.tree]),
    [['v0.1.0', fx.git(['rev-parse', 'HEAD']), publicCommit, prepared.tree]],
  );
  assert.equal(JSON.parse(fs.readFileSync(intentFile, 'utf8')).status, 'complete');
  assert.equal(targetGit(fx, ['rev-list', '--count', 'main']), '1');
  assert.match(errorOf(() => push(fx, { confirm: prepared.code })), /v0\.1\.0 is already released/);

  // A pending intent whose tag on the target points elsewhere is not "completed".
  const odd = fixture();
  const oddPrepared = prepare(odd);
  assert.match(errorOf(() => push(odd, { confirm: oddPrepared.code, hooks: { afterPush: crash } })), /simulated crash/);
  const intent = JSON.parse(fs.readFileSync(path.join(odd.stateDir, 'v0.1.0', 'push-intent.json'), 'utf8'));
  fs.writeFileSync(path.join(odd.stateDir, 'v0.1.0', 'push-intent.json'), JSON.stringify({ ...intent, publicCommit: 'e'.repeat(40) }));
  assert.match(errorOf(() => push(odd, { confirm: oddPrepared.code })), /has the tag v0\.1\.0 at .*, not the pending push's commit/);
  assert.deepEqual(readPrivateReleases(odd.repo), []);
});

test('8.1: prepare shows what changed in the files the security gate trusts since the last public release; the code binds them', () => {
  const fx = fixture();
  const exception = (id, reviewBy) => ({ scanner: 'trivy', id, package: 'libfoo', versions: ['1.0-1'], images: ['cms'], owner: 'maintainer', reason: 'no fix', reviewBy });
  // The trust files are published (as in the real manifest).
  const manifest = fs.readFileSync(path.join(fx.repo, 'release/public-manifest.yaml'), 'utf8');
  fx.write('release/public-manifest.yaml', manifest.replace('include:\n', 'include:\n  - security/**\n  - scripts/**\n'));
  fx.write('security/exceptions.json', JSON.stringify({ exceptions: [exception('CVE-2026-0001', '2026-12-01')] }, null, 2));
  fx.write('scripts/security-scanners.mjs', 'export const scan = 1;\n');
  fx.git(['add', '-A']);
  fx.git(['commit', '-qm', 'scanners and exceptions']);
  const lines = [];
  const first = prepare(fx, { log: (l) => lines.push(l) });
  // The first release (the target has no main): the full content is to be reviewed.
  assert.ok(lines.some((l) => /first release \(.* has no main\): review the full content of every trust file/.test(l)));
  assert.ok(lines.some((l) => l.includes('+ trivy CVE-2026-0001 libfoo@1.0-1 [cms] owner=maintainer reviewBy=2026-12-01')));
  assert.match(fs.readFileSync(first.reviewFile, 'utf8'), /\+\+\+ b\/release\/scripts\/security-scanners\.mjs\n@@ -0,0 \+1 @@\n\+export const scan = 1;/);
  push(fx, { confirm: first.code });
  const firstPublic = targetGit(fx, ['rev-parse', 'refs/heads/main']);

  // A later commit adds an exception, extends another and weakens a scanner — and forges the private release journal
  // so that its "last release" is the parent commit, which already holds the weakened files. The baseline is the
  // target's own history, so everything is still shown.
  fx.write('security/exceptions.json', JSON.stringify({ exceptions: [exception('CVE-2026-0001', '2027-03-01'), exception('CVE-2026-0002', '2027-01-01')] }, null, 2));
  fx.write('scripts/security-scanners.mjs', 'export const scan = 0; // weakened\n');
  fx.git(['commit', '-qam', 'more exceptions']);
  const forged = { version: 'v0.1.9', tag: 'v0.1.9', privateCommit: fx.git(['rev-parse', 'HEAD']), publicCommit: 'f'.repeat(40), tree: 'e'.repeat(40), target: fx.targetUrl, branch: 'main' };
  fs.appendFileSync(path.join(fx.repo, 'release/private-releases.jsonl'), `${JSON.stringify(forged)}\n`);
  fx.write('src/extra.ts', 'export const extra = 1;\n');
  fx.git(['add', '-A']);
  fx.git(['commit', '-qm', 'an innocent change on top']);
  lines.length = 0;
  const second = prepare(fx, { version: 'v0.2.0', log: (l) => lines.push(l) });
  const text = lines.join('\n');
  assert.match(text, new RegExp(`changes since the last public release \\(${fx.targetUrl.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} main at ${firstPublic.slice(0, 12)}, v0\\.1\\.0\\):`));
  assert.match(text, /security-scanners\.mjs +\| +2 \+-/);
  assert.match(text, /exceptions: 1 added, 1 changed, 0 removed/);
  assert.match(text, /\+ trivy CVE-2026-0002 libfoo@1\.0-1 \[cms\] owner=maintainer reviewBy=2027-01-01/);
  assert.match(text, /~ trivy CVE-2026-0001 libfoo@1\.0-1 \[cms\] owner=maintainer reviewBy=2027-03-01/);
  assert.match(fs.readFileSync(second.reviewFile, 'utf8'), /-export const scan = 1;\n\+export const scan = 0; \/\/ weakened/);
  assert.notEqual(second.trust, first.trust);
  assert.equal(second.code, confirmationCode({ tree: second.tree, privateCommit: second.sha, target: fx.targetUrl, branch: 'main', tag: 'v0.2.0', trust: second.trust }));
});

test('8.1: a trust file that is a symbolic link is refused — in the release and in the last public release', () => {
  // The release: security/exceptions.json → security/allow.json would make the scans read a file the review never shows.
  const fx = fixture();
  const manifest = fs.readFileSync(path.join(fx.repo, 'release/public-manifest.yaml'), 'utf8');
  fx.write('release/public-manifest.yaml', manifest.replace('include:\n', 'include:\n  - security/**\n'));
  fx.write('security/allow.json', JSON.stringify({ exceptions: [] }));
  fs.symlinkSync('allow.json', path.join(fx.repo, 'security/exceptions.json'));
  fx.git(['add', '-A']);
  fx.git(['commit', '-qm', 'exceptions through a link']);
  assert.match(errorOf(() => prepare(fx)), /trust files must be regular files, not symbolic links \(the release commit [0-9a-f]{12}\): security\/exceptions\.json/);
  assert.equal(targetRefs(fx), '');

  // The last public release on the target holds a linked trust file: its content cannot serve as the baseline.
  const clean = fixture();
  clean.write('security/exceptions.json', JSON.stringify({ exceptions: [] }));
  clean.git(['add', '-A']);
  clean.git(['commit', '-qm', 'regular exceptions']);
  const other = tempDir('release-linked-public-');
  const og = (args) => execFileSync('git', args, { cwd: other, encoding: 'utf8', env: { ...process.env, ...ID } }).trim();
  og(['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(other, 'security'));
  fs.writeFileSync(path.join(other, 'security/allow.json'), '{}\n');
  fs.symlinkSync('allow.json', path.join(other, 'security/exceptions.json'));
  og(['add', '-A']);
  og(['commit', '-qm', 'a public release with a linked trust file']);
  og(['push', '-q', clean.targetUrl, 'main:refs/heads/main']);
  assert.match(errorOf(() => prepare(clean)), /trust files must be regular files, not symbolic links \(the last public release [0-9a-f]{12}\): security\/exceptions\.json/);
});

test('8.1: a .gitattributes in the tree cannot turn the trust diff into "Binary files differ"', () => {
  const fx = fixture();
  const manifest = fs.readFileSync(path.join(fx.repo, 'release/public-manifest.yaml'), 'utf8');
  fx.write('release/public-manifest.yaml', manifest.replace('include:\n', 'include:\n  - scripts/**\n  - .gitattributes\n'));
  fx.write('scripts/security-scanners.mjs', 'export const scan = 1;\n');
  fx.git(['add', '-A']);
  fx.git(['commit', '-qm', 'scanner']);
  const first = prepare(fx);
  push(fx, { confirm: first.code });
  fx.write('.gitattributes', 'scripts/** -diff binary\n*.mjs -text -diff\n');
  fx.write('scripts/security-scanners.mjs', 'export const scan = 0; // weakened\n');
  fx.git(['add', '-A']);
  fx.git(['commit', '-qm', 'hide the change']);
  const second = prepare(fx, { version: 'v0.2.0' });
  const review = fs.readFileSync(second.reviewFile, 'utf8');
  assert.doesNotMatch(review, /Binary files/);
  assert.match(review, /\+export const scan = 0; \/\/ weakened/);
  assert.match(review, /\+scripts\/\*\* -diff binary/, 'the attributes file itself is shown');
});

test('P2: --main-ref must name the main branch (refs/heads/main, or origin/main of the private repository), but in the test-target mode', () => {
  const repo = fixture().repo;
  assert.equal(checkMainRef('refs/heads/main', { root: repo }), 'refs/heads/main');
  for (const ref of ['refs/heads/feature/experimental', 'refs/remotes/upstream/main', 'refs/remotes/fork/main', 'refs/remotes/origin/main-old', 'refs/heads/mainline', 'refs/remotes/origin/x/main', 'HEAD', 'main', '']) {
    assert.throws(() => checkMainRef(ref, { root: repo }), /does not name the main branch/, ref);
  }
  assert.equal(checkMainRef('refs/heads/feature/experimental', { testTarget: true }), 'refs/heads/feature/experimental');
  // The bypass: a feature branch named as "main" makes its own commit merged — refused before anything else runs.
  const fx = fixture();
  fx.git(['checkout', '-q', '-b', 'feature/experimental']);
  fx.write('src/util.ts', 'export const helper = (n: number): number => n + 5;\n');
  fx.git(['commit', '-qam', 'unmerged work']);
  const message = errorOf(() =>
    prepare(fx, { target: PUBLIC_TARGETS[0], testTarget: false, commit: 'feature/experimental', mainRef: 'refs/heads/feature/experimental', security: () => assert.fail('not reached') }),
  );
  assert.match(message, /--main-ref "refs\/heads\/feature\/experimental" does not name the main branch/);
  assert.ok(!fs.existsSync(path.join(fx.stateDir, 'v0.1.0')), 'nothing was prepared');
});

test('P2: a pending intent whose push never reached the target does not block prepare', () => {
  const fx = fixture();
  const first = prepare(fx);
  // A crash before the push: the intent is pending, the target has no tag.
  fs.writeFileSync(path.join(first.dir, 'push-intent.json'), JSON.stringify({ status: 'pending', tag: 'v0.1.0', target: fx.targetUrl, publicCommit: 'e'.repeat(40), tree: first.tree, code: first.code }));
  const again = prepare(fx);
  assert.equal(again.tree, first.tree);
  assert.ok(!fs.existsSync(path.join(again.dir, 'push-intent.json')));
});

test('P2: durable writes flush the file and its directory (fsync) before they return', () => {
  const dir = tempDir('durable-');
  const opened = new Map();
  const synced = [];
  const realOpen = fs.openSync;
  const realSync = fs.fsyncSync;
  fs.openSync = (p, ...rest) => {
    const fd = realOpen(p, ...rest);
    opened.set(fd, p);
    return fd;
  };
  fs.fsyncSync = (fd) => {
    synced.push(opened.get(fd));
    return realSync(fd);
  };
  try {
    const intent = path.join(dir, 'push-intent.json');
    writeJsonDurable(intent, { status: 'pending' });
    assert.ok(synced.some((p) => p.startsWith(`${intent}.`) && p.endsWith('.tmp')), `the temporary file is flushed before the rename: ${synced}`);
    assert.ok(synced.includes(dir), 'the directory is flushed after the rename');
    assert.deepEqual(JSON.parse(fs.readFileSync(intent, 'utf8')), { status: 'pending' });
    assert.deepEqual(fs.readdirSync(dir), ['push-intent.json'], 'no temporary file is left');

    synced.length = 0;
    const records = path.join(dir, 'private-releases.jsonl');
    appendRecordDurable(records, { tag: 'v0.1.0' });
    appendRecordDurable(records, { tag: 'v0.2.0' });
    // The journal is replaced whole each time: its temporary file, then the directory.
    // Under the journal's lock (its file is flushed too), the journal's temporary file, then the directory — twice.
    const journalSyncs = synced.filter((p) => p !== `${records}.lock`);
    assert.equal(synced.filter((p) => p === `${records}.lock`).length, 2);
    assert.equal(journalSyncs.length, 4);
    assert.ok(journalSyncs[0].startsWith(`${records}.`) && journalSyncs[0].endsWith('.tmp') && journalSyncs[1] === dir && journalSyncs[3] === dir, synced.join(', '));
    assert.ok(!fs.existsSync(`${records}.lock`), 'the lock is released');
    assert.equal(fs.readFileSync(records, 'utf8'), '{"tag":"v0.1.0"}\n{"tag":"v0.2.0"}\n');
  } finally {
    fs.openSync = realOpen;
    fs.fsyncSync = realSync;
  }
});

test('P2: --test-target is valid with a file:/// target only — never with the public repository, in prepare or in push', () => {
  for (const url of PUBLIC_TARGETS) assert.throws(() => checkTarget(url, { testTarget: true }), /--test-target allows only a local file:\/\/\/ test repository/, url);
  // The bypass of the main-branch guard: the public target, the test mode, a feature branch as "main".
  const fx = fixture();
  fx.git(['checkout', '-q', '-b', 'feature/experimental']);
  fx.write('src/util.ts', 'export const helper = (n: number): number => n + 6;\n');
  fx.git(['commit', '-qam', 'unmerged work']);
  const message = errorOf(() =>
    prepare(fx, { target: PUBLIC_TARGETS[0], testTarget: true, commit: 'feature/experimental', mainRef: 'refs/heads/feature/experimental', security: () => assert.fail('not reached') }),
  );
  assert.match(message, /--test-target allows only a local file:\/\/\/ test repository/);
  assert.ok(!fs.existsSync(path.join(fx.stateDir, 'v0.1.0')), 'nothing was prepared');
  // A prepared release edited to point the test mode at the public repository: push refuses it.
  fx.git(['checkout', '-q', 'main']);
  const prepared = prepare(fx);
  const file = path.join(prepared.dir, 'prepared.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), target: PUBLIC_TARGETS[0] }));
  assert.match(errorOf(() => push(fx, { confirm: prepared.code })), /--test-target allows only a local file:\/\/\/ test repository/);
  assert.equal(targetRefs(fx), '');
});

test('P2: refs/remotes/origin/main counts only when origin is the private repository — not a fork', () => {
  const fx = fixture();
  fx.git(['remote', 'add', 'origin', 'https://github.com/someone/heopress-fork.git']);
  fx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  fx.git(['remote', 'add', 'mirror', 'https://github.com/yeagoo/heopress-private.git']);
  fx.git(['update-ref', 'refs/remotes/mirror/main', 'HEAD']);
  assert.throws(() => checkMainRef('refs/remotes/origin/main', { root: fx.repo }), /origin is not the private repository yeagoo\/heopress-private/);
  // Another remote, even at the private repository's URL, is not the configured origin.
  assert.throws(() => checkMainRef('refs/remotes/mirror/main', { root: fx.repo }), /does not name the main branch/);
  assert.match(
    errorOf(() => prepare(fx, { target: PUBLIC_TARGETS[0], testTarget: false, mainRef: 'refs/remotes/origin/main', security: () => assert.fail('not reached') })),
    /origin is not the private repository/,
  );
  for (const url of ['https://github.com/yeagoo/heopress-private.git', 'https://github.com/yeagoo/heopress-private', 'git@github.com:yeagoo/heopress-private.git', 'ssh://git@github.com/yeagoo/heopress-private.git']) {
    fx.git(['remote', 'set-url', 'origin', url]);
    assert.equal(checkMainRef('refs/remotes/origin/main', { root: fx.repo }), 'refs/remotes/origin/main', url);
  }
  for (const url of ['https://github.com/yeagoo/heopress-private-fork.git', 'https://example.com/yeagoo/heopress-private.git', '/srv/heopress-private.git']) {
    fx.git(['remote', 'set-url', 'origin', url]);
    assert.throws(() => checkMainRef('refs/remotes/origin/main', { root: fx.repo }), /origin is not the private repository/, url);
  }
});

test('P2: the journal tolerates and repairs a trailing partial line from an older crash; other damage is refused', () => {
  const ok = '{"tag":"v0.1.0","privateCommit":"a"}';
  assert.deepEqual(parseJournal(`${ok}\n{"tag":"v0.2.0","priv`), { records: [{ tag: 'v0.1.0', privateCommit: 'a' }], lines: [ok], partial: true });
  assert.deepEqual(parseJournal(`${ok}\n${ok}`).records.length, 2, 'a complete last line without its newline is a record');
  assert.throws(() => parseJournal(`${ok}\n{"tag":\n${ok}\n`), /private-releases\.jsonl:2 is not a JSON record: the journal is damaged/);

  // Recovery: a push interrupted after it reached the target, and a journal an older crash cut mid-line.
  const fx = fixture();
  const prepared = prepare(fx);
  assert.match(errorOf(() => push(fx, { confirm: prepared.code, hooks: { afterPush: () => { throw new Error('simulated crash after the push'); } } })), /simulated crash/);
  const journal = path.join(fx.repo, 'release/private-releases.jsonl');
  const earlier = '{"tag":"v0.0.8","privateCommit":"c"}';
  fs.writeFileSync(journal, `${earlier}\n{"tag":"v0.0.9","privateComm`);
  assert.deepEqual(readPrivateReleases(fx.repo).map((r) => r.tag), ['v0.0.8']);
  const recovered = push(fx, { confirm: prepared.code, security: () => assert.fail('no new push') });
  assert.equal(recovered.recovered, true);
  const text = fs.readFileSync(journal, 'utf8');
  assert.ok(text.endsWith('\n'), 'the journal ends with a complete line');
  assert.deepEqual(text.trim().split('\n').map((l) => JSON.parse(l).tag), ['v0.0.8', 'v0.1.0'], 'the partial line is gone, the earlier record kept');
  assert.equal(JSON.parse(text.trim().split('\n')[1]).publicCommit, recovered.publicCommit);
});

test('P2: durable writes write every byte through short writes, and a write that makes no progress replaces nothing', () => {
  const dir = tempDir('short-');
  const realWrite = fs.writeSync;
  // At most three bytes per call, as a short write can.
  fs.writeSync = (fd, buf, offset = 0, length = buf.length - offset) => realWrite(fd, buf, offset, Math.min(3, length));
  try {
    writeJsonDurable(path.join(dir, 'intent.json'), { status: 'pending', tag: 'v0.1.0' });
    appendRecordDurable(path.join(dir, 'journal.jsonl'), { tag: 'v0.1.0', publicCommit: 'b'.repeat(40) });
  } finally {
    fs.writeSync = realWrite;
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'intent.json'), 'utf8')), { status: 'pending', tag: 'v0.1.0' });
  assert.equal(fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'), `{"tag":"v0.1.0","publicCommit":"${'b'.repeat(40)}"}\n`);
  // A disk that takes nothing: an error, the old journal intact, no temporary file left.
  fs.writeSync = () => 0;
  try {
    assert.throws(() => appendRecordDurable(path.join(dir, 'journal.jsonl'), { tag: 'v0.2.0' }), /made no progress/);
  } finally {
    fs.writeSync = realWrite;
  }
  assert.equal(fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'), `{"tag":"v0.1.0","publicCommit":"${'b'.repeat(40)}"}\n`);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['intent.json', 'journal.jsonl']);
});

test('P2: two releases appending to the journal at once both keep their record (an exclusive lock, not a lost update)', async () => {
  const dir = tempDir('journal-race-');
  const journal = path.join(dir, 'private-releases.jsonl');
  const driver = path.join(dir, 'append.mjs');
  const moduleUrl = pathToFileURL(path.join(ROOT, 'scripts/public-release.mjs')).href;
  // Each process reads the journal, pauses (the window a concurrent append would hit), then replaces it.
  fs.writeFileSync(
    driver,
    `const { appendRecordDurable } = await import(${JSON.stringify(moduleUrl)});\n` +
      `appendRecordDurable(process.argv[2], { tag: process.argv[3], publicCommit: process.argv[3] }, { pauseMs: 600 });\n`,
  );
  const run = (tag) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [driver, journal, tag], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => {
        err += d;
      });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`append ${tag} failed: ${err}`))));
    });
  const first = run('v0.1.0');
  await new Promise((r) => setTimeout(r, 200));
  await Promise.all([first, run('v0.2.0')]);
  assert.deepEqual(readJournalTags(journal), ['v0.1.0', 'v0.2.0']);
  assert.ok(!fs.existsSync(`${journal}.lock`));
});

function readJournalTags(file) {
  return parseJournal(fs.readFileSync(file, 'utf8')).records.map((r) => r.tag);
}

test('P2: a stale journal lock (its process gone) is taken over; a live one is waited for, then reported, and nothing changes', () => {
  const dir = tempDir('journal-lock-');
  const journal = path.join(dir, 'private-releases.jsonl');
  // A process that has exited: its pid names no process any more.
  const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout;
  fs.writeFileSync(`${journal}.lock`, `${gone} 2026-01-01T00:00:00.000Z\n`);
  appendRecordDurable(journal, { tag: 'v0.1.0', publicCommit: 'a' });
  assert.deepEqual(readJournalTags(journal), ['v0.1.0']);
  assert.ok(!fs.existsSync(`${journal}.lock`));
  // A lock held by a live process (this one): the append waits, then fails naming it; the journal is unchanged.
  fs.writeFileSync(`${journal}.lock`, `${process.pid} ${new Date().toISOString()}\n`);
  assert.throws(() => appendRecordDurable(journal, { tag: 'v0.2.0', publicCommit: 'b' }, { lockTimeoutMs: 200 }), new RegExp(`held by another release \\(process ${process.pid}\\)`));
  assert.deepEqual(readJournalTags(journal), ['v0.1.0']);
  fs.rmSync(`${journal}.lock`);
  // Too old, whatever its process: stale.
  fs.writeFileSync(`${journal}.lock`, `${process.pid} 2026-01-01T00:00:00.000Z\n`);
  const old = new Date(Date.now() - 11 * 60_000);
  fs.utimesSync(`${journal}.lock`, old, old);
  assert.equal(withFileLock(journal, () => 'ran'), 'ran');
  // The same record twice is kept once; another commit for a recorded tag is refused.
  appendRecordDurable(journal, { tag: 'v0.1.0', publicCommit: 'a' });
  assert.throws(() => appendRecordDurable(journal, { tag: 'v0.1.0', publicCommit: 'c' }), /already records v0\.1\.0 at another public commit/);
  assert.deepEqual(readJournalTags(journal), ['v0.1.0']);
});

test('P3: a holder whose lock was taken over meanwhile neither removes the new holder\'s lock nor replaces the journal', () => {
  const journal = path.join(tempDir('journal-takeover-'), 'private-releases.jsonl');
  fs.writeFileSync(journal, `${JSON.stringify({ tag: 'v0.1.0', publicCommit: 'a' })}\n`);
  const other = `999999 ${new Date().toISOString()} another-holder\n`;
  // While this holder runs, another release judges it stale and takes the lock over.
  const result = withFileLock(journal, (stillHeld) => {
    assert.equal(stillHeld(), true);
    fs.writeFileSync(`${journal}.lock`, other);
    return stillHeld();
  });
  assert.equal(result, false);
  assert.equal(fs.readFileSync(`${journal}.lock`, 'utf8'), other, 'the new holder\'s lock is left in place');
  fs.rmSync(`${journal}.lock`);
  // Inside the append: taken over between the read and the replacement — nothing is written.
  const realSleep = Atomics.wait;
  let hijacked = false;
  Atomics.wait = (...args) => {
    if (!hijacked && fs.existsSync(`${journal}.lock`)) {
      hijacked = true;
      fs.writeFileSync(`${journal}.lock`, other);
    }
    return realSleep(...args);
  };
  try {
    assert.throws(() => appendRecordDurable(journal, { tag: 'v0.2.0', publicCommit: 'b' }, { pauseMs: 1 }), /taken over by another release/);
  } finally {
    Atomics.wait = realSleep;
  }
  assert.ok(hijacked);
  assert.deepEqual(readJournalTags(journal), ['v0.1.0']);
  assert.equal(fs.readFileSync(`${journal}.lock`, 'utf8'), other);
});

test('P2: a remote URL with credentials is never printed — origin checks, targets and the mirror setting redact it', () => {
  const secret = ['not', 'a', 'real', 'credential'].join('-');
  const fx = fixture();
  fx.git(['remote', 'add', 'origin', `https://x-access-token:${secret}@github.com/someone/heopress-fork.git`]);
  fx.git(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  const message = errorOf(() => checkMainRef('refs/remotes/origin/main', { root: fx.repo }));
  assert.match(message, /origin is not the private repository yeagoo\/heopress-private \(https:\/\/\*\*\*@github\.com\/someone\/heopress-fork\.git\)/);
  assert.ok(!message.includes(secret) && !message.includes('x-access-token'), message);
  // The private repository with credentials in its URL is still the private repository.
  assert.ok(isPrivateRepositoryUrl(`https://x-access-token:${secret}@github.com/yeagoo/heopress-private.git`));
  fx.git(['remote', 'set-url', 'origin', `https://x-access-token:${secret}@github.com/yeagoo/heopress-private.git`]);
  assert.equal(checkMainRef('refs/remotes/origin/main', { root: fx.repo }), 'refs/remotes/origin/main');
  // A target with credentials (refused) is reported without them; so is the mirror's repository setting.
  for (const [fn, re] of [
    [() => checkTarget(`https://user:${secret}@github.com/web-casa/HeoPress.git`), /https:\/\/\*\*\*@github\.com\/web-casa\/HeoPress\.git is not the public repository/],
    [() => checkTarget(`https://example.com/x.git?access_token=${secret}`, { testTarget: true }), /access_token=\*\*\*/],
    [() => checkPublicRepo(`user:${secret}@github.com/web-casa/HeoPress`), /refusing to push the mirror to "\*\*\*@github\.com\/web-casa\/HeoPress"/],
  ]) {
    const err = errorOf(fn);
    assert.match(err, re);
    assert.ok(!err.includes(secret), err);
  }
});
