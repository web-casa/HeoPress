#!/usr/bin/env node
/**
 * CI in the public repository for private commits (ADR-0018).
 *
 *   node scripts/ci-mirror.mjs push   [--commit <rev>]   check, export, scan, push to the public ci/ branch
 *   node scripts/ci-mirror.mjs report [--commit <rev>]   wait for that run, set the private commit's status
 *
 * `push`:
 * - runs the checks that need private files on the commit itself (OpenSpec
 *   strict validation of the commit's `openspec/`, changes in progress
 *   included), in an isolated directory;
 * - exports the commit (scripts/public-export.mjs: whitelist, secret and
 *   private-term scans);
 * - builds the mirror commit in a fresh, private-to-this-run bare repository
 *   (no shared clone, so concurrent runs cannot mix trees), checks that its
 *   tree holds exactly the exported files with their modes and contents, and
 *   pushes it to `ci/b-<hash of the private branch name>` of the public
 *   repository — never another ref — with a lease on the branch's current
 *   head. The mirror commit's message carries only the private commit's SHA;
 *   its author is a fixed identity;
 * - records `private SHA → mirror tree → mirror SHA → branch` on this machine
 *   (the record, not the public commit, is what `report` trusts) and marks the
 *   private commit `pending`.
 *
 * `report` waits for the public `push` run of the recorded mirror commit on
 * its branch, checks the public commit's tree is the recorded one and that the
 * record was not replaced meanwhile, then sets the private commit's
 * `public-mirror-ci` status to the outcome (or `error` when it cannot tell).
 *
 * Settings: HEOPRESS_PUBLIC_REPO (default web-casa/HeoPress; `push` refuses any other repository),
 * HEOPRESS_PRIVATE_REPO (default yeagoo/heopress-private),
 * HEOPRESS_CI_MIRROR_STATE (records; default ~/.cache/heopress-ci-mirror).
 * Needs git, gitleaks and an authenticated gh (git pushes use gh's credential helper).
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportCommit, redactUrl, writeExportTree } from './public-export.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_REPO = process.env.HEOPRESS_PUBLIC_REPO ?? 'web-casa/HeoPress';
const PRIVATE_REPO = process.env.HEOPRESS_PRIVATE_REPO ?? 'yeagoo/heopress-private';
const STATE_DIR = process.env.HEOPRESS_CI_MIRROR_STATE ?? path.join(os.homedir(), '.cache', 'heopress-ci-mirror');
const STATUS_CONTEXT = 'public-mirror-ci';
const WORKFLOW_PATH = '.github/workflows/ci.yml';
/** The identity of mirror commits: no personal name or e-mail leaves with them. */
const MIRROR_IDENTITY = { name: 'HeoPress CI mirror', email: 'ci-mirror@heopress.invalid', date: '2000-01-01T00:00:00Z' };

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts }).trim();
const git = (args, opts = {}) => run('git', args, opts);

/**
 * The public branch for a private branch: `ci/b-` and a hash of the name (the name itself may say what it
 * should not), a valid ref by construction.
 */
export function mirrorBranch(privateBranch) {
  if (!privateBranch || privateBranch === 'HEAD') throw new Error('no branch to mirror');
  const ref = `ci/b-${createHash('sha256').update(privateBranch).digest('hex').slice(0, 20)}`;
  const check = spawnSync('git', ['check-ref-format', `refs/heads/${ref}`]);
  if (check.status !== 0) throw new Error(`invalid ref ${ref}`);
  return ref;
}

/** The mirror commit's message: nothing from the private commit but its SHA. */
export function mirrorMessage(sha) {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a commit SHA: ${sha}`);
  return `ci: mirror of a private commit (ADR-0018)\n\nPrivate-Commit: ${sha}\n`;
}

/** Validate the commit's own `openspec/` (not the working tree's) in an isolated directory. */
function validateOpenSpec(sha) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-openspec-'));
  const index = path.join(dir, '.index');
  try {
    const env = { ...process.env, GIT_INDEX_FILE: index };
    git(['read-tree', `${sha}:openspec`], { cwd: ROOT, env });
    git(['checkout-index', '--all', '--force', `--prefix=${path.join(dir, 'openspec')}/`], { cwd: ROOT, env });
    const spec = spawnSync('npx', ['-y', '@fission-ai/openspec@1.14.1', 'validate', '--all', '--strict'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, OPENSPEC_TELEMETRY: '0' },
    });
    if (spec.status !== 0) throw new Error(`OpenSpec strict validation of ${sha.slice(0, 8)} failed:\n${spec.stdout}${spec.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The mirror commit of an export, built in the given (empty, private) bare repository: a root commit whose tree
 * must hold exactly the exported files — the same blobs and modes as the private commit, but for the modified-
 * files list the export rewrites.
 */
export function buildMirrorCommit({ gitDir, out, entries, sha, rewritten = new Set(['LICENSES/HEOPRESS-MODIFIED-FILES.txt']) }) {
  const env = {
    ...process.env,
    GIT_DIR: gitDir,
    GIT_WORK_TREE: out,
    GIT_INDEX_FILE: path.join(gitDir, 'mirror-index'),
    GIT_AUTHOR_NAME: MIRROR_IDENTITY.name,
    GIT_AUTHOR_EMAIL: MIRROR_IDENTITY.email,
    GIT_AUTHOR_DATE: MIRROR_IDENTITY.date,
    GIT_COMMITTER_NAME: MIRROR_IDENTITY.name,
    GIT_COMMITTER_EMAIL: MIRROR_IDENTITY.email,
    GIT_COMMITTER_DATE: MIRROR_IDENTITY.date,
  };
  // The tree is the export: same paths, modes and (but for rewritten files) blobs as the private commit.
  const tree = writeExportTree({ gitDir, out, entries, rewritten });
  const commit = git(['commit-tree', tree, '-m', mirrorMessage(sha)], { cwd: out, env });
  return { tree, commit };
}

const recordPath = (sha) => path.join(STATE_DIR, 'records', `${sha}.json`);
const readRecord = (sha) => (fs.existsSync(recordPath(sha)) ? JSON.parse(fs.readFileSync(recordPath(sha), 'utf8')) : null);

/** Replace a record atomically (a reader sees the old one or the new one, never half of either). */
function writeRecord(sha, record) {
  fs.mkdirSync(path.dirname(recordPath(sha)), { recursive: true });
  const tmp = `${recordPath(sha)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, recordPath(sha));
}

/**
 * Run `fn` holding this private commit's lock: record changes and status writes of one commit are serialised
 * (a lock older than four hours is taken as abandoned).
 */
export async function withCommitLock(sha, fn, { stateDir = STATE_DIR, waitMs = 10 * 60_000 } = {}) {
  const lock = path.join(stateDir, 'locks', `${sha}.lock`);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const started = Date.now();
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch (statErr) {
        if (statErr.code === 'ENOENT') continue; // released just now: compete for it again
        throw statErr;
      }
      if (age > 4 * 3600_000) fs.rmSync(lock, { force: true });
      else if (Date.now() - started > waitMs) throw new Error(`lock ${lock} held for too long`);
      else await new Promise((r) => setTimeout(r, 1000));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/**
 * Write the status only if the record is still the one this report started from — the same push (its generation,
 * not its mirror SHA: mirroring the same commit again usually gives the same SHA). A report of an earlier push
 * never overwrites the result of a later one, whatever its outcome (success, failure, error).
 */
export async function writeIfCurrent(sha, record, write, { read = readRecord, lockOptions } = {}) {
  return withCommitLock(
    sha,
    async () => {
      const latest = read(sha);
      if (!latest || latest.generation !== record.generation) {
        console.log(`[ci-mirror] ${sha.slice(0, 8)} was mirrored again meanwhile; this report is stale and writes nothing`);
        return false;
      }
      write();
      return true;
    },
    lockOptions,
  );
}

function setStatus(sha, state, description, targetUrl) {
  const args = ['api', '-X', 'POST', `repos/${PRIVATE_REPO}/statuses/${sha}`, '-f', `state=${state}`, '-f', `context=${STATUS_CONTEXT}`, '-f', `description=${description.slice(0, 140)}`];
  if (targetUrl) args.push('-f', `target_url=${targetUrl}`);
  run('gh', args);
}

/** The only repository the mirror pushes to: a typo or a stray environment variable must not send an export elsewhere. */
export function checkPublicRepo(repo) {
  if (repo !== 'web-casa/HeoPress') throw new Error(`refusing to push the mirror to ${JSON.stringify(redactUrl(repo))}: the public repository is web-casa/HeoPress`);
  return repo;
}

async function push(commit) {
  checkPublicRepo(PUBLIC_REPO);
  const sha = git(['rev-parse', '--verify', `${commit}^{commit}`], { cwd: ROOT });
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT });
  const target = mirrorBranch(branch);
  if (!/^ci\/b-[0-9a-f]{20}$/.test(target)) throw new Error(`refusing to push to ${target}`);

  validateOpenSpec(sha);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-mirror-'));
  try {
    const out = path.join(scratch, 'tree');
    const { files, entries, draftLicences } = exportCommit({ root: ROOT, commit: sha, out });
    // Licence texts still in draft are left out of the mirror (they leave only final, with a release).
    if (draftLicences.length) console.log(`[ci-mirror] left out, still drafts: ${draftLicences.join(', ')}`);
    const gitDir = path.join(scratch, 'mirror.git');
    git(['init', '--quiet', '--bare', gitDir]);
    const { tree, commit: mirrorSha } = buildMirrorCommit({ gitDir, out, entries, sha });
    const url = `https://github.com/${PUBLIC_REPO}.git`;
    const current = git(['ls-remote', url, `refs/heads/${target}`]).split('\t')[0] ?? '';
    // Lease on the head just read: a concurrent push of the same branch fails instead of being overwritten.
    git(['push', '--quiet', `--force-with-lease=refs/heads/${target}:${current}`, url, `${mirrorSha}:refs/heads/${target}`], {
      env: { ...process.env, GIT_DIR: gitDir },
    });
    await withCommitLock(sha, async () => {
      writeRecord(sha, { privateSha: sha, generation: randomUUID(), branch: target, tree, mirrorSha, pushedAt: new Date().toISOString() });
      setStatus(sha, 'pending', `Public CI running (${mirrorSha.slice(0, 8)})`, `https://github.com/${PUBLIC_REPO}/commit/${mirrorSha}`);
    });
    console.log(`[ci-mirror] ${files} files of ${sha.slice(0, 8)} pushed to ${PUBLIC_REPO} ${target} as ${mirrorSha.slice(0, 8)}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/** The public `push` run of the workflow for this mirror commit on its branch (latest attempt), or null. */
export function pickRun(runs, record) {
  const own = runs.filter((r) => r.head_sha === record.mirrorSha && r.event === 'push' && r.head_branch === record.branch && r.path === WORKFLOW_PATH);
  own.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  return own[0] ?? null;
}

async function report(commit) {
  const sha = git(['rev-parse', '--verify', `${commit}^{commit}`], { cwd: ROOT });
  let record = null;
  try {
    record = readRecord(sha);
    if (!record) throw new Error(`no mirror record for ${sha.slice(0, 8)}: run "push" first`);
    // The public commit must be the one built here (its tree), whatever its message says.
    const publicTree = run('gh', ['api', `repos/${PUBLIC_REPO}/git/commits/${record.mirrorSha}`, '-q', '.tree.sha']);
    if (publicTree !== record.tree) throw new Error(`public commit ${record.mirrorSha.slice(0, 8)} does not hold the recorded tree`);
    for (let attempt = 0; ; attempt++) {
      const runs = JSON.parse(
        run('gh', ['api', `repos/${PUBLIC_REPO}/actions/runs?head_sha=${record.mirrorSha}&event=push&per_page=50`, '-q', '.workflow_runs']),
      );
      const chosen = pickRun(runs, record);
      if (chosen && chosen.status === 'completed') {
        const ok = chosen.conclusion === 'success';
        await writeIfCurrent(sha, record, () => setStatus(sha, ok ? 'success' : 'failure', `Public CI ${chosen.conclusion} (${record.mirrorSha.slice(0, 8)})`, chosen.html_url));
        console.log(`[ci-mirror] ${sha.slice(0, 8)}: public CI ${chosen.conclusion} — ${chosen.html_url}`);
        return ok;
      }
      if (attempt >= 360) throw new Error('the public run did not finish within 3 hours');
      await new Promise((r) => setTimeout(r, 30_000));
    }
  } catch (err) {
    // Unknown, not pending forever — but only for the mirror this report was about.
    if (record) await writeIfCurrent(sha, record, () => setStatus(sha, 'error', `Public CI result unknown: ${err.message}`.slice(0, 140)));
    throw err;
  }
}

async function main(argv) {
  const [command] = argv;
  const i = argv.indexOf('--commit');
  const commit = i >= 0 ? argv[i + 1] : 'HEAD';
  try {
    if (command === 'push') await push(commit);
    else if (command === 'report') process.exit((await report(commit)) ? 0 : 1);
    else {
      console.error('usage: ci-mirror.mjs push|report [--commit <rev>]');
      process.exit(2);
    }
  } catch (err) {
    console.error(`[ci-mirror] stopped: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main(process.argv.slice(2));
