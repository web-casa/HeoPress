#!/usr/bin/env node
/**
 * The public release of a private commit (ADR-0010; P07 tasks 7.3, 7.4, 7.6).
 *
 *   node scripts/public-release.mjs prepare --version <vX.Y.Z> --target <public repository URL>
 *                                           [--branch main] [--commit <rev>] [--main-ref <ref>] [--test-target]
 *   node scripts/public-release.mjs push    --version <vX.Y.Z> --confirm <confirmation code>
 *
 * The target must be the public repository `web-casa/HeoPress` (`PUBLIC_TARGETS`); `--test-target` allows a local
 * `file://` repository instead (rehearsals and tests), nothing else.
 *
 * `prepare`:
 * - refuses a shallow private repository (its history check would be blind)
 *   and a commit that is not merged into the private main branch (`--main-ref`,
 *   default `refs/remotes/origin/main`: merged through a PR and pushed);
 * - requires `release/RELEASES.md` of the commit to list the version (public
 *   versions and tags only: a full SHA, or any 7–40 hex digits naming an object
 *   of the private repository, is refused) and the version not to be released
 *   already (`release/private-releases.jsonl`);
 * - exports the commit (scripts/public-export.mjs: whitelist, never-public
 *   categories, path and link checks, private-term and gitleaks scans, the
 *   licence files a release must carry) into `<state>/<version>/tree`;
 * - builds a copy of it on its own (`build/`: install, typecheck, build,
 *   test — nothing but the export, in an environment of its own: a fresh
 *   HOME, XDG, npm/pnpm cache and store under `build-env/`, the public npm
 *   registry, no host `NODE_OPTIONS` / `npm_config_*` / `PNPM_*`, no secrets
 *   or database settings); a failing step stops the release;
 * - after the build, checks that it changed no exported file, scans everything
 *   it left (outside node_modules) for private terms and secrets, and scans the
 *   publish tree again — a scan from before the build is never reused;
 * - requires a passing security scan of exactly that tree
 *   (scripts/release-security-gate.mjs: the exceptions and `pnpm audit` here,
 *   and a successful `.github/workflows/security.yml` run — gitleaks, Trivy
 *   over the images — on its public CI mirror commit, read with gh);
 * - shows what changed since the last public release in the files the
 *   security gate trusts (workflow, scanners, checker, exceptions; the full
 *   diff in `security-review.diff`: scripts/release-trust-review.mjs);
 * - writes the publish tree as a git tree in a fresh repository (checked to
 *   hold exactly the export) and prints its digest and a confirmation code
 *   binding that tree, the private commit, the trust files' digest, the target
 *   repository, the branch and the tag.
 *
 * `push` (after the maintainer has reviewed the prepared tree and copied the
 * code — the manual confirmation):
 * - scans the prepared tree again and rebuilds its git tree: any change since
 *   `prepare` (a file, a link, an added environment file) gives another tree
 *   or fails a check, and the code no longer matches — prepare again;
 * - checks the security gate again (an exception may have expired, or the
 *   scan run grown too old, since `prepare`);
 * - in a fresh bare repository (no shared clone, nothing of `../public`), makes
 *   one commit of that tree on top of the target branch's current head (or a
 *   root commit for an empty target), under a fixed release identity, and
 *   refuses it when its history holds any commit known to the private
 *   repository (public history never carries private history);
 * - records a pending push intent (`push-intent.json`, with the public commit
 *   and tree), tags (annotated), pushes branch and tag atomically with a lease
 *   on the head just read, checks the target now shows both, and only then
 *   appends `private SHA → version → public SHA` to
 *   `release/private-releases.jsonl` (never public) for the maintainer to
 *   commit, and marks the intent complete. A push interrupted after it reached
 *   the target is completed by running `push` again with the same code: the
 *   target's tag must point at the intent's commit and tree. The intent, the
 *   journal and the completion are each replaced whole (every byte written to
 *   a temporary file, fsync, rename, fsync of the directory) before the next
 *   step, in the order intent → push → verify →
 *   record → complete, so a power loss at any point leaves either no public
 *   tag, or a pending intent (completed by `push`), or the record. `prepare`
 *   refuses to discard a version whose pending push reached the target.
 *
 * Settings: HEOPRESS_RELEASE_STATE (prepared releases; default ~/.cache/heopress-release).
 * Needs git, gitleaks, pnpm (the audit) and gh signed in (reading the public workflow runs only).
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportCommit, missingLicenseFiles, redactUrl, scanTree, writeExportTree } from './public-export.mjs';
import { releaseSecurityGate } from './release-security-gate.mjs';
import { NPM_REGISTRY } from './security-scanners.mjs';
import { trustDigest, trustReview } from './release-trust-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = process.env.HEOPRESS_RELEASE_STATE ?? path.join(os.homedir(), '.cache', 'heopress-release');
const RELEASES = 'release/RELEASES.md';
const PRIVATE_RELEASES = 'release/private-releases.jsonl';
/** The identity of public release commits and tags: no personal name or e-mail leaves with them. */
const RELEASE_IDENTITY = { name: 'HeoPress Release', email: 'release@heopress.invalid' };
/** The private branch a released commit must be merged into (merged through a PR and pushed). */
export const DEFAULT_MAIN_REF = 'refs/remotes/origin/main';
/** The only repository a release goes to (ADR-0010): `web-casa/HeoPress`, by any of its GitHub URLs. */
export const PUBLIC_TARGETS = [
  'https://github.com/web-casa/HeoPress.git',
  'https://github.com/web-casa/HeoPress',
  'git@github.com:web-casa/HeoPress.git',
  'ssh://git@github.com/web-casa/HeoPress.git',
];

/** The independent build of the export (ADR-0010 §4), run in order in a copy of it. */
export const BUILD_STEPS = [
  ['pnpm', 'install', '--frozen-lockfile'],
  ['pnpm', 'typecheck'],
  ['pnpm', 'build'],
  ['pnpm', 'test'],
];

/**
 * The only host environment variables the build sees: the tool path and the locale. Everything else is the build's
 * own (`buildEnv`): no secret, no database (a `DATABASE_URL` would make the integration tests reset that database),
 * no `.env*`, no host npm/pnpm configuration — the export must build as a public user's checkout would.
 */
const BUILD_ENV_KEYS = ['PATH', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM'];

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, ...opts }).trim();
const git = (args, opts = {}) => run('git', args, opts);

/** A release version is its tag: `v` and a semantic version. */
export function releaseTag(version) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$/.test(version ?? '')) {
    throw new Error(`not a release version: ${JSON.stringify(version)} (expected v<major>.<minor>.<patch>[-<pre>])`);
  }
  return version;
}

/** The target must be the public repository; with `testTarget`, a local `file://` repository instead. */
export function checkTarget(target, { testTarget = false } = {}) {
  if (!target) throw new Error('a target repository URL is required (--target)');
  // The test mode relaxes the main-branch guard: it is valid with a local test repository only, never the public one.
  if (testTarget) {
    if (/^file:\/\/\//.test(target)) return target;
    throw new Error(`--test-target allows only a local file:/// test repository, not ${redactUrl(target)} (a release to web-casa/HeoPress takes no --test-target)`);
  }
  if (PUBLIC_TARGETS.includes(target)) return target;
  throw new Error(
    `${redactUrl(target)} is not the public repository web-casa/HeoPress (${PUBLIC_TARGETS[0]}); only a local file:/// test repository may replace it, with --test-target`,
  );
}

/** The private repository, by any of its GitHub URLs (the `origin` a release's main branch must come from). */
const PRIVATE_REPOSITORY = 'yeagoo/heopress-private';

/**
 * Whether `url` is the private repository (https, ssh or scp-like GitHub URL, with or without `.git`; an https URL may
 * carry credentials, which are ignored — and never printed: see `redactUrl`).
 */
export function isPrivateRepositoryUrl(url) {
  const bare = (url ?? '').trim().replace(/^(https:\/\/)[^/?#\s]*@/i, '$1');
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(bare);
  return Boolean(m) && m[1].toLowerCase() === PRIVATE_REPOSITORY;
}

/** A shallow repository cannot tell which commits are private: refused. */
export function refuseShallow(root) {
  if (git(['rev-parse', '--is-shallow-repository'], { cwd: root }) === 'true') {
    throw new Error('the private repository is a shallow clone: its history cannot show that the public history holds no private commit; release from a full clone (git fetch --unshallow)');
  }
}

/**
 * The ref the released commit must be merged into names the main branch: `refs/heads/main` or
 * `refs/remotes/<remote>/main`. Any other ref (a feature branch would make its own commit "merged") is refused,
 * but in the test-target mode of rehearsals.
 */
export function checkMainRef(mainRef, { root = ROOT, testTarget = false } = {}) {
  // Rehearsals only (checkTarget allows the test mode with a file:/// target alone).
  if (testTarget && spawnSync('git', ['check-ref-format', mainRef ?? '']).status === 0) return mainRef;
  if (mainRef === 'refs/heads/main') return mainRef;
  if (mainRef === 'refs/remotes/origin/main') {
    const url = spawnSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8' }).stdout?.trim() ?? '';
    if (isPrivateRepositoryUrl(url)) return mainRef;
    throw new Error(`--main-ref ${mainRef}: origin is not the private repository ${PRIVATE_REPOSITORY} (${url ? redactUrl(url) : 'no URL'}), so its main proves nothing`);
  }
  throw new Error(`--main-ref ${JSON.stringify(mainRef)} does not name the main branch (refs/heads/main, or refs/remotes/origin/main of the private repository)`);
}

/** The released commit must be merged into the private main branch `mainRef`. */
export function requireMerged(root, sha, mainRef) {
  if (spawnSync('git', ['rev-parse', '--verify', '--quiet', `${mainRef}^{commit}`], { cwd: root }).status !== 0) {
    throw new Error(`${mainRef} does not exist in the private repository (fetch it, or name the main branch with --main-ref)`);
  }
  if (spawnSync('git', ['merge-base', '--is-ancestor', sha, mainRef], { cwd: root }).status !== 0) {
    throw new Error(`${sha.slice(0, 8)} is not merged into ${mainRef}: only merged commits are released (merge it through a PR, then fetch)`);
  }
}

/** Whether `hex` (4+ hex digits) abbreviates an object — any object — of the repository at `root`. */
export function namesPrivateObject(root, hex) {
  const run = spawnSync('git', ['rev-parse', `--disambiguate=${hex.toLowerCase()}`], { cwd: root, encoding: 'utf8' });
  return run.status === 0 && run.stdout.trim() !== '';
}

/**
 * What `release/RELEASES.md` of the released commit must satisfy: the version listed, and no commit ID — no 40-digit
 * hex at all, and no run of 7–40 hex digits that `isPrivateObject` recognises as (an abbreviation of) a private
 * commit or other object.
 */
export function releasesProblems(text, tag, { isPrivateObject = () => false } = {}) {
  const problems = [];
  const listed = text
    .split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .some((row) => row.split('|').some((cell) => cell.trim().replace(/^`(.*)`$/, '$1') === tag));
  if (!listed) problems.push(`${RELEASES} does not list ${tag}: add its row (version, tag, date) and commit it before preparing`);
  const runs = text.match(/(?<![0-9a-f])[0-9a-f]{7,}(?![0-9a-f])/gi) ?? [];
  const ids = runs.filter((h) => h.length >= 40 || (h.length <= 40 && isPrivateObject(h)));
  if (ids.length) {
    problems.push(`${RELEASES} holds ${ids.length} commit ID(s) (a full SHA, or an abbreviation of a private object): it lists public versions and tags only (private commits go to ${PRIVATE_RELEASES})`);
  }
  return problems;
}

/**
 * The code the maintainer confirms: it binds the final tree, the private commit it came from, the digest of the
 * security trust files the maintainer reviewed (scripts/release-trust-review.mjs), the target repository, the branch
 * and the tag.
 */
export function confirmationCode({ tree, privateCommit, target, branch, tag, trust }) {
  if (!/^[0-9a-f]{64}$/.test(trust ?? '')) throw new Error('a confirmation code needs the digest of the reviewed security trust files');
  return createHash('sha256')
    .update(`heopress-release\u0000${tree}\u0000${privateCommit}\u0000${target}\u0000${branch}\u0000${tag}\u0000${trust}`)
    .digest('hex');
}

/**
 * The build's environment: the host's tool path and locale, and everything else its own under `envDir` — a fresh
 * HOME, XDG directories, temporary directory, corepack, npm cache and pnpm store, empty npm user and global
 * configuration and the public registry — so no host `~/.npmrc`, cache, store, `NODE_OPTIONS`, `npm_config_*` or
 * `PNPM_*` setting can make the export build here when it would not for a public user. Creates the directories.
 */
export function buildEnv(envDir, env = process.env) {
  const dirs = {
    HOME: path.join(envDir, 'home'),
    XDG_CACHE_HOME: path.join(envDir, 'xdg-cache'),
    XDG_CONFIG_HOME: path.join(envDir, 'xdg-config'),
    XDG_DATA_HOME: path.join(envDir, 'xdg-data'),
    XDG_STATE_HOME: path.join(envDir, 'xdg-state'),
    TMPDIR: path.join(envDir, 'tmp'),
    COREPACK_HOME: path.join(envDir, 'corepack'),
    npm_config_cache: path.join(envDir, 'npm-cache'),
    npm_config_store_dir: path.join(envDir, 'pnpm-store'),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const userconfig = path.join(dirs.HOME, '.npmrc');
  const globalconfig = path.join(envDir, 'npmrc-global');
  fs.writeFileSync(userconfig, '');
  fs.writeFileSync(globalconfig, '');
  const out = { CI: 'true', HUSKY: '0', ...dirs, npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig, npm_config_registry: NPM_REGISTRY };
  for (const key of BUILD_ENV_KEYS) if (env[key] !== undefined) out[key] = env[key];
  return out;
}

/** Run the build steps in `dir`, in the environment of `envDir` (`buildEnv`); the first failing step stops the release. */
export function runBuild({ dir, envDir, steps = BUILD_STEPS, stdio = 'inherit', log = console.log }) {
  const env = buildEnv(envDir);
  for (const step of steps) {
    const [cmd, ...args] = step;
    const label = step.map((s) => (s === process.execPath ? 'node' : s)).join(' ');
    log(`[release] build: ${label}`);
    const result = spawnSync(cmd, args, { cwd: dir, env, stdio, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    if (result.error) throw new Error(`build step "${label}" did not run (${result.error.message})`);
    if (result.status !== 0) {
      const output = stdio === 'pipe' ? `\n${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-40).join('\n')}` : '';
      throw new Error(`build step "${label}" failed (exit ${result.status ?? result.signal}): the export does not build on its own${output}`);
    }
  }
}

/**
 * The files below `dir` (regular files and links, `/`-separated, sorted), skipping directories named in `skipDirs`;
 * `special` lists anything else (sockets, FIFOs, devices): never part of a release.
 */
export function listFiles(dir, { skipDirs = new Set() } = {}) {
  const files = [];
  const special = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) walk(r);
      } else if (e.isFile() || e.isSymbolicLink()) files.push(r);
      else special.push(r);
    }
  };
  walk('');
  return { files: files.sort(), special: special.sort() };
}

/** Exported files the build changed, removed or replaced (by content, or link target). */
export function changedByBuild(treeDir, buildDir, files) {
  const read = (abs) => {
    try {
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) return `link:${fs.readlinkSync(abs)}`;
      if (st.isFile()) return fs.readFileSync(abs);
      return 'special';
    } catch {
      return null;
    }
  };
  return files.filter((f) => {
    const a = read(path.join(treeDir, f));
    const b = read(path.join(buildDir, f));
    if (a === null || b === null) return true;
    if (Buffer.isBuffer(a) && Buffer.isBuffer(b)) return !a.equals(b);
    return a !== b;
  });
}

/**
 * The publish tree checked from scratch — scanned again (structure, private terms, unscannable files, gitleaks,
 * licence files) as it is on disk now, and written as a git tree that must hold exactly the exported entries.
 * Returns the tree's digest. `gitDir` is a fresh repository to write into (a temporary one when omitted).
 */
export function sealTree({ root, treeDir, entries, gitDir }) {
  const { files, special } = listFiles(treeDir);
  const problems = special.length ? [`special files (not regular files or links):\n  ${special.join('\n  ')}`] : [];
  problems.push(...scanTree({ root, dir: treeDir, files }));
  const licences = missingLicenseFiles(treeDir);
  if (licences.length) problems.push(`licence files a release must carry (ADR-0008, ADR-0010 §7):\n  ${licences.join('\n  ')}`);
  if (problems.length) throw new Error(`the publish tree fails its checks:\n${problems.join('\n')}`);
  if (gitDir) return writeExportTree({ gitDir, out: treeDir, entries });
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-seal-'));
  try {
    const fresh = path.join(scratch, 'seal.git');
    git(['init', '--quiet', '--bare', fresh]);
    return writeExportTree({ gitDir: fresh, out: treeDir, entries });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

const releaseDir = (stateDir, tag) => path.join(path.resolve(stateDir), releaseTag(tag));

/** The private release records (`release/private-releases.jsonl` in the working tree of `root`). */
export function readPrivateReleases(root) {
  const file = path.join(root, PRIVATE_RELEASES);
  if (!fs.existsSync(file)) return [];
  return parseJournal(fs.readFileSync(file, 'utf8'), PRIVATE_RELEASES).records;
}

/**
 * The private release journal: one JSON record per line. A trailing line without its newline that does not parse is
 * the remains of an interrupted append (older, non-atomic writes): tolerated here and dropped by the next durable
 * write (`partial`). Any other line that does not parse is damage, refused — never guessed at.
 */
export function parseJournal(text, name = PRIVATE_RELEASES) {
  const parts = text.split('\n');
  const trailing = parts.pop();
  const lines = [];
  const records = [];
  parts.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`${name}:${i + 1} is not a JSON record: the journal is damaged — repair it by hand (git history has it)`);
    }
    lines.push(line);
  });
  let partial = false;
  if (trailing.trim()) {
    try {
      records.push(JSON.parse(trailing));
      lines.push(trailing);
    } catch {
      partial = true;
    }
  }
  return { records, lines, partial };
}

/** Export, build, scan again and seal a release; returns the tree digest and the confirmation code. */
export function prepareRelease({
  root = ROOT,
  commit = 'HEAD',
  version,
  target,
  testTarget = false,
  branch = 'main',
  mainRef = DEFAULT_MAIN_REF,
  stateDir = STATE_DIR,
  steps = BUILD_STEPS,
  stdio = 'inherit',
  log = console.log,
  security = releaseSecurityGate,
}) {
  const tag = releaseTag(version);
  checkTarget(target, { testTarget });
  checkMainRef(mainRef, { root, testTarget });
  if (spawnSync('git', ['check-ref-format', `refs/heads/${branch}`]).status !== 0) throw new Error(`not a branch name: ${JSON.stringify(branch)}`);
  refuseShallow(root);
  const sha = git(['rev-parse', '--verify', `${commit}^{commit}`], { cwd: root });
  requireMerged(root, sha, mainRef);
  if (readPrivateReleases(root).some((r) => r.tag === tag)) throw new Error(`${tag} is already released (${PRIVATE_RELEASES})`);
  let releases;
  try {
    releases = git(['show', `${sha}:${RELEASES}`], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    throw new Error(`${RELEASES} is missing from ${sha.slice(0, 8)}`);
  }
  const listed = releasesProblems(releases, tag, { isPrivateObject: (hex) => namesPrivateObject(root, hex) });
  if (listed.length) throw new Error(listed.join('\n'));

  const dir = releaseDir(stateDir, tag);
  refusePendingPush(dir, log);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const treeDir = path.join(dir, 'tree');
  const buildDir = path.join(dir, 'build');
  const { entries, files } = exportCommit({ root, commit: sha, out: treeDir, requireLicenses: true });
  log(`[release] ${files} files of ${sha.slice(0, 8)} exported and scanned`);
  // Before the (long) build: no release without a passing security scan of this exact tree.
  const scan = security({ root, sha, treeDir, entries });
  log(`[release] security scan passed: ${scan.run?.url ?? 'evidence recorded'}`);

  // The build runs in a copy: what it leaves behind (dependencies, outputs) is never part of the publish tree.
  fs.cpSync(treeDir, buildDir, { recursive: true, verbatimSymlinks: true });
  // The build's own HOME, caches and store: beside the copy, not in it (they would be scanned as outputs, and tools
  // that walk the tree would find the store's packages).
  runBuild({ dir: buildDir, envDir: path.join(dir, 'build-env'), steps, stdio, log });
  const exportedFiles = entries.map((e) => e.file);
  const drift = changedByBuild(treeDir, buildDir, exportedFiles);
  if (drift.length) throw new Error(`the build changed exported files (the published sources must be the ones built and tested):\n  ${drift.join('\n  ')}`);
  // Everything the build left (but installed dependencies) is scanned again: a build must not pull private content in.
  const outputs = listFiles(buildDir, { skipDirs: new Set(['node_modules']) }).files;
  const leftovers = scanTree({ root, dir: buildDir, files: outputs, structure: false, opaque: false });
  if (leftovers.length) throw new Error(`the build produced content that must not leave:\n${leftovers.join('\n')}`);

  const tree = sealTree({ root, treeDir, entries });
  // The human checkpoint over what the security gate trusts: what changed since the last public release.
  // The baseline is the target's own history (its branch head, the last release), never a record in this repository.
  const review = trustReview({ root, commit: sha, treeDir, target, branch });
  const reviewFile = path.join(dir, 'security-review.diff');
  fs.writeFileSync(reviewFile, `${review.summary.join('\n')}\n\n${review.diff}\n`);
  const code = confirmationCode({ tree, privateCommit: sha, target, branch, tag, trust: review.digest });
  const prepared = {
    tag,
    privateCommit: sha,
    mainRef,
    target,
    testTarget,
    branch,
    tree,
    trust: review.digest,
    entries: entries.map(({ mode, object, file }) => ({ mode, object, file })),
    security: scan,
    preparedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(dir, 'prepared.json'), `${JSON.stringify(prepared, null, 2)}\n`);
  log(`[release] ${tag} prepared from ${sha.slice(0, 8)}: ${files} files, built and tested on their own, scanned again after the build`);
  log(`  tree     ${tree}`);
  log(`  commit   ${sha} (merged into ${mainRef})`);
  log(`  target   ${redactUrl(target)} (branch ${branch}, tag ${tag})`);
  log(`  review   ${treeDir}`);
  log('  security trust files (the scans, the checker, the workflow and the exceptions the gate believes):');
  for (const line of review.summary) log(`    ${line}`);
  log(`  trust    ${review.digest} — review the full diff in ${reviewFile} before confirming`);
  log(`  confirm  node scripts/public-release.mjs push --version ${tag} --confirm ${code}`);
  log('  Any change to the tree, the commit, the trust files, the target or the tag after this needs a new prepare and a new confirmation.');
  return { dir, treeDir, tree, code, sha, files, trust: review.digest, reviewFile, review };
}

/**
 * Commits of `commit`'s history (in `gitDir`) that the private repository at `root` knows: none may be published.
 * Complete only in a full clone (`refuseShallow` runs first).
 */
export function privateAncestors({ root, gitDir, commit }) {
  const history = git(['--git-dir', gitDir, 'rev-list', commit]).split('\n').filter(Boolean);
  const known = new Set(git(['rev-list', '--all', 'HEAD'], { cwd: root }).split('\n').filter(Boolean));
  return history.filter((c) => known.has(c));
}

/** Flush a directory's entries (a created or renamed file) to disk. */
function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Write all of `data` to `fd`, however many calls a short write takes; a call that writes nothing is an error. */
function writeAll(fd, data) {
  const buf = Buffer.from(data);
  for (let offset = 0; offset < buf.length; ) {
    const written = fs.writeSync(fd, buf, offset, buf.length - offset);
    if (!(written > 0)) throw new Error('a write made no progress (is the disk full?): the file was not replaced');
    offset += written;
  }
}

/**
 * Replace a file atomically and durably: the whole content is written to a temporary file (every byte, however short
 * the writes) and flushed (fsync), the file renamed over the old one, and the directory flushed. After it returns, a
 * crash or a power loss leaves the new content; before, the old one — never part of either.
 */
export function writeFileDurable(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    writeAll(fd, data);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

/** A JSON file, replaced atomically and durably (`writeFileDurable`). */
export function writeJsonDurable(file, value) {
  writeFileDurable(file, `${JSON.stringify(value, null, 2)}\n`);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The holder a lock file names (`<pid> <time>`), and whether that lock is stale: its process gone, or too old. */
function lockState(lock, staleMs) {
  let text;
  let st;
  try {
    text = fs.readFileSync(lock, 'utf8');
    st = fs.statSync(lock);
  } catch {
    return { gone: true };
  }
  const pid = Number(text.split(' ')[0]);
  if (Date.now() - st.mtimeMs > staleMs) return { text, pid, stale: true };
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return { text, pid, stale: false };
    } catch (err) {
      return { text, pid, stale: err.code === 'ESRCH' };
    }
  }
  // Half-written by a holder that has just created it: wait (it turns stale by age if that holder died).
  return { text, pid, stale: false };
}

/**
 * Run `fn(stillHeld)` holding the exclusive lock of `file`: `<file>.lock`, created with O_EXCL (`wx`) and naming the
 * holder (`<pid> <time> <token>`), removed when `fn` ends — only while it is still this holder's lock (its token),
 * never a lock another release took over meanwhile. One process at a time reads, changes and replaces the file, so no
 * update is lost; `stillHeld()` lets `fn` check the lock is still its own right before it replaces the file. A lock
 * whose process no longer exists on this machine, or older than `staleMs` (10 minutes), is stale: it is taken over —
 * moved aside, checked to be the very lock judged stale (else put back), removed. Otherwise the caller waits up to
 * `timeoutMs`, then fails naming the holder; nothing is changed.
 */
export function withFileLock(file, fn, { timeoutMs = 30_000, staleMs = 10 * 60_000 } = {}) {
  const lock = `${file}.lock`;
  const started = Date.now();
  const mine = `${process.pid} ${new Date().toISOString()} ${randomUUID()}\n`;
  const stillHeld = () => {
    try {
      return fs.readFileSync(lock, 'utf8') === mine;
    } catch {
      return false;
    }
  };
  for (;;) {
    let fd;
    try {
      fd = fs.openSync(lock, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const state = lockState(lock, staleMs);
      if (state.gone) continue;
      if (state.stale) {
        const aside = `${lock}.stale.${process.pid}.${Date.now()}`;
        try {
          fs.renameSync(lock, aside);
        } catch {
          continue; // taken over by another waiter meanwhile
        }
        if (fs.readFileSync(aside, 'utf8') !== state.text) {
          // A fresh lock replaced the stale one between the check and the move: give it back.
          try {
            fs.linkSync(aside, lock);
          } catch {
            // Its holder will find its lock gone at release; nothing of the journal depends on it.
          }
        }
        fs.rmSync(aside, { force: true });
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        throw new Error(`${path.basename(lock)} is held by another release (process ${state.pid}): wait for it to finish; remove the lock only if that process is gone`);
      }
      sleepSync(50);
      continue;
    }
    try {
      writeAll(fd, mine);
      fs.fsyncSync(fd);
    } catch (err) {
      // A lock that could not be written is not held: never left behind to block the next release.
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
      throw err;
    }
    fs.closeSync(fd);
    break;
  }
  try {
    return fn(stillHeld);
  } finally {
    // Only this holder's lock: a lock another release took over (judged stale while this one ran) is left to it.
    if (stillHeld()) fs.rmSync(lock, { force: true });
  }
}

/**
 * Add a record to the journal `file` atomically and durably, under its lock (`withFileLock`): the journal is read, the
 * record added in memory and the whole journal replaced (`writeFileDurable`) — a concurrent append waits instead of
 * being overwritten, an interrupted write leaves the old journal, never a partial line, and the remains of an older
 * interrupted append are dropped. A record for a tag the journal already has is not added twice. `pauseMs` (tests
 * only) widens the window between the read and the replacement.
 */
export function appendRecordDurable(file, record, { pauseMs = 0, lockTimeoutMs } = {}) {
  return withFileLock(
    file,
    (stillHeld) => {
      const { lines, records } = parseJournal(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '', path.basename(file));
      const same = records.find((r) => record.tag !== undefined && r.tag === record.tag);
      if (same) {
        if (same.publicCommit === record.publicCommit) return same;
        throw new Error(`${path.basename(file)} already records ${record.tag} at another public commit: check it by hand`);
      }
      if (pauseMs) sleepSync(pauseMs);
      // Taken over meanwhile (this holder was judged stale): another release may be replacing the journal — stop.
      if (!stillHeld()) throw new Error(`${path.basename(file)}.lock was taken over by another release while this one held it: run the step again`);
      writeFileDurable(file, `${[...lines, JSON.stringify(record)].join('\n')}\n`);
      return record;
    },
    lockTimeoutMs === undefined ? {} : { timeoutMs: lockTimeoutMs },
  );
}

/**
 * `prepare` must not discard a push that may have reached the target: a version directory holding a pending push
 * intent is kept — but for an intent whose tag the target does not have (that push never landed).
 */
function refusePendingPush(dir, log) {
  const intentFile = path.join(dir, 'push-intent.json');
  if (!fs.existsSync(intentFile)) return;
  const intent = JSON.parse(fs.readFileSync(intentFile, 'utf8'));
  if (intent.status !== 'pending') return;
  if (remoteTagTarget(intent.target, intent.tag)) {
    throw new Error(
      `${intent.tag} has a pending push that reached ${redactUrl(intent.target)} but was not recorded: complete it with ` +
        `"node scripts/public-release.mjs push --version ${intent.tag} --confirm <the same code>" — prepare would discard it`,
    );
  }
  log(`[release] ${intent.tag}: a pending push never reached ${redactUrl(intent.target)}; preparing again`);
}

/** The commit and tree a tag of `target` points at, read in a fresh repository (null when the tag is absent). */
function remoteTagTarget(target, tag) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-release-check-'));
  try {
    const gitDir = path.join(scratch, 'check.git');
    git(['init', '--quiet', '--bare', gitDir]);
    if (!remoteRefs(target).has(`refs/tags/${tag}`)) return null;
    git(['--git-dir', gitDir, 'fetch', '--quiet', '--no-tags', target, `+refs/tags/${tag}:refs/tags/${tag}`]);
    return { commit: git(['--git-dir', gitDir, 'rev-parse', `refs/tags/${tag}^{commit}`]), tree: git(['--git-dir', gitDir, 'rev-parse', `refs/tags/${tag}^{tree}`]) };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The target's refs: `ref → sha`, peeled tags as `refs/tags/<tag>^{}`. */
function remoteRefs(target) {
  const refs = new Map();
  for (const line of git(['ls-remote', target]).split('\n').filter(Boolean)) {
    const [sha, ref] = line.split('\t');
    refs.set(ref, sha);
  }
  return refs;
}

/**
 * Complete a push that reached the target but was interrupted before its record was written: the pending intent's
 * tag must exist on the target and point at the intent's commit and tree. Returns the record, or null when the push
 * never reached the target (the intent is then stale and the push runs normally).
 */
function completeInterrupted({ root, intent, intentFile, confirm, log }) {
  if (intent.code !== confirm) throw new Error(`a pending push of ${intent.tag} was confirmed with another code: confirm with that code to complete it`);
  // The target first: what decides is whether the push landed, not the journal (which an older crash may have left
  // with a partial last line — tolerated by the reader, repaired by the write below).
  const found = remoteTagTarget(intent.target, intent.tag);
  if (!found) return null;
  if (found.commit !== intent.publicCommit || found.tree !== intent.tree) {
    throw new Error(`${redactUrl(intent.target)} has the tag ${intent.tag} at ${found.commit.slice(0, 8)}, not the pending push's commit ${intent.publicCommit.slice(0, 8)} and tree: check it by hand; nothing was recorded`);
  }
  const existing = readPrivateReleases(root).find((r) => r.tag === intent.tag);
  const record = existing ?? {
    version: intent.tag,
    tag: intent.tag,
    privateCommit: intent.privateCommit,
    publicCommit: intent.publicCommit,
    tree: intent.tree,
    target: intent.target,
    branch: intent.branch,
    pushedAt: intent.createdAt,
    recoveredAt: new Date().toISOString(),
  };
  if (!existing) appendRecordDurable(path.join(root, PRIVATE_RELEASES), record);
  writeJsonDurable(intentFile, { ...intent, status: 'complete', completedAt: new Date().toISOString() });
  log(`[release] ${intent.tag}: an interrupted push had reached ${redactUrl(intent.target)}; recorded in ${PRIVATE_RELEASES} — commit it`);
  return { ...record, recovered: true };
}

/**
 * Push a prepared release after the maintainer's confirmation; returns the private release record. `hooks.afterPush`
 * (tests only) runs after the target is verified and before anything is recorded — where a crash would hit.
 */
export function pushRelease({ root = ROOT, version, confirm, stateDir = STATE_DIR, log = console.log, security = releaseSecurityGate, hooks = {} }) {
  const tag = releaseTag(version);
  const dir = releaseDir(stateDir, tag);
  const preparedFile = path.join(dir, 'prepared.json');
  if (!fs.existsSync(preparedFile)) throw new Error(`${tag} is not prepared: run prepare first`);
  const prepared = JSON.parse(fs.readFileSync(preparedFile, 'utf8'));
  if (prepared.tag !== tag) throw new Error(`${preparedFile} is for ${prepared.tag}, not ${tag}`);
  if (!/^[0-9a-f]{64}$/.test(confirm ?? '')) throw new Error('the confirmation code prepare printed is required (--confirm)');
  const { target, branch } = prepared;
  checkTarget(target, { testTarget: prepared.testTarget });
  const intentFile = path.join(dir, 'push-intent.json');
  const intent = fs.existsSync(intentFile) ? JSON.parse(fs.readFileSync(intentFile, 'utf8')) : null;
  if (intent?.status === 'pending') {
    const recovered = completeInterrupted({ root, intent, intentFile, confirm, log });
    if (recovered) return recovered;
  }
  if (readPrivateReleases(root).some((r) => r.tag === tag)) throw new Error(`${tag} is already released (${PRIVATE_RELEASES})`);
  refuseShallow(root);
  const mainRef = checkMainRef(prepared.mainRef ?? DEFAULT_MAIN_REF, { root, testTarget: prepared.testTarget });
  requireMerged(root, prepared.privateCommit, mainRef);

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-release-'));
  let record;
  try {
    const gitDir = path.join(scratch, 'release.git');
    git(['init', '--quiet', '--bare', gitDir]);
    // The confirmation holds for this exact tree only: scanned again and rebuilt from disk now.
    const tree = sealTree({ root, treeDir: path.join(dir, 'tree'), entries: prepared.entries, gitDir });
    const trust = trustDigest(root, prepared.privateCommit);
    if (tree !== prepared.tree || trust !== prepared.trust || confirmationCode({ tree, privateCommit: prepared.privateCommit, target, branch, tag, trust }) !== confirm) {
      throw new Error('the release tree or its security trust files changed after confirmation, or the code confirms another tree, commit, target or tag: run prepare again, review and confirm its new code');
    }
    const scan = security({ root, sha: prepared.privateCommit, treeDir: path.join(dir, 'tree'), entries: prepared.entries });
    log(`[release] security scan still passed: ${scan.run?.url ?? 'evidence recorded'}`);

    const before = remoteRefs(target);
    if (before.has(`refs/tags/${tag}`)) throw new Error(`${redactUrl(target)} already has the tag ${tag}`);
    const head = before.get(`refs/heads/${branch}`) ?? '';
    if (head) git(['--git-dir', gitDir, 'fetch', '--quiet', '--no-tags', target, `+refs/heads/${branch}:refs/remotes/target/${branch}`]);
    const now = new Date().toISOString();
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: RELEASE_IDENTITY.name,
      GIT_AUTHOR_EMAIL: RELEASE_IDENTITY.email,
      GIT_AUTHOR_DATE: now,
      GIT_COMMITTER_NAME: RELEASE_IDENTITY.name,
      GIT_COMMITTER_EMAIL: RELEASE_IDENTITY.email,
      GIT_COMMITTER_DATE: now,
    };
    const commit = git(['--git-dir', gitDir, 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', `release: HeoPress ${tag}`], { env });
    const leaked = privateAncestors({ root, gitDir, commit });
    if (leaked.length) {
      throw new Error(`the public history would hold commits of the private repository (public history never carries private history):\n  ${leaked.map((c) => c.slice(0, 12)).join('\n  ')}`);
    }
    git(['--git-dir', gitDir, 'tag', '-a', tag, '-m', `HeoPress ${tag}`, commit], { env });
    // The intent first: a push that reaches the target but is interrupted before its record is completed by a retry.
    writeJsonDurable(intentFile, { status: 'pending', tag, privateCommit: prepared.privateCommit, publicCommit: commit, tree, target, branch, code: confirm, createdAt: now });
    // Atomic, with a lease on the head just read: a concurrent change of the branch fails the push instead of being overwritten.
    git(['--git-dir', gitDir, 'push', '--quiet', '--atomic', `--force-with-lease=refs/heads/${branch}:${head}`, target, `${commit}:refs/heads/${branch}`, `refs/tags/${tag}:refs/tags/${tag}`]);
    const after = remoteRefs(target);
    if (after.get(`refs/heads/${branch}`) !== commit || after.get(`refs/tags/${tag}^{}`) !== commit) {
      throw new Error(`${redactUrl(target)} does not show ${branch} and ${tag} at ${commit.slice(0, 8)} after the push: check it by hand; nothing was recorded`);
    }
    hooks.afterPush?.();
    record = { version: tag, tag, privateCommit: prepared.privateCommit, publicCommit: commit, tree, target, branch, pushedAt: now };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  // Only after a successful push: the private commit behind the public version (never public).
  appendRecordDurable(path.join(root, PRIVATE_RELEASES), record);
  writeJsonDurable(intentFile, { ...JSON.parse(fs.readFileSync(intentFile, 'utf8')), status: 'complete', completedAt: new Date().toISOString() });
  log(`[release] ${tag} pushed to ${redactUrl(target)} (${branch} and tag) as ${record.publicCommit.slice(0, 8)}; recorded in ${PRIVATE_RELEASES} — commit it`);
  return record;
}

function main(argv) {
  const [command] = argv;
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  try {
    if (command === 'prepare') {
      prepareRelease({
        version: arg('--version'),
        target: arg('--target'),
        testTarget: argv.includes('--test-target'),
        branch: arg('--branch') ?? 'main',
        commit: arg('--commit') ?? 'HEAD',
        mainRef: arg('--main-ref') ?? DEFAULT_MAIN_REF,
      });
    } else if (command === 'push') {
      pushRelease({ version: arg('--version'), confirm: arg('--confirm') });
    } else {
      console.error(
        'usage: public-release.mjs prepare --version <vX.Y.Z> --target <public repository URL> [--branch main] [--commit <rev>] [--main-ref <ref>] [--test-target]\n       public-release.mjs push --version <vX.Y.Z> --confirm <code>',
      );
      process.exit(2);
    }
  } catch (err) {
    console.error(`[release] stopped: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
