/**
 * The human checkpoint of a release over what the security gate trusts (P07 task 8.1, ADR-0017 §5).
 *
 * The gate believes the scanners, the checker, the workflow, the exceptions and the image recipes of the tree it
 * releases — files any commit may change, and that the private repository cannot protect with required code-owner
 * reviews. So `prepare` shows the maintainer what changed in them since the last public release: a summary
 * (exceptions added, changed or removed — scanner, id, package, versions, images, owner, review deadline — and a
 * diff stat of the other files) and the full diff in `security-review.diff` next to the prepared tree. The digest of
 * these files (their blob ids at the released commit) is part of the confirmation code, so the code the maintainer
 * copies after reviewing holds for exactly those versions.
 *
 * The baseline is the real public history, never a record the released commit could write: the head of the target
 * branch (the last release, with its tags), fetched read-only into a throwaway repository; its tree holds exactly the
 * trust files that were published. No head (an empty target): the first release, reviewed in full. The diff runs
 * outside any repository, on extracted files, with text output forced and no attributes, external diff or textconv,
 * so no `.gitattributes` (of the tree or the host) can hide a change.
 */
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The files the security gate's verdict depends on. */
export const TRUST_FILES = [
  '.github/workflows/security.yml',
  'security/exceptions.json',
  'scripts/security-scanners.mjs',
  'scripts/check-security-scan.mjs',
  'scripts/release-security-gate.mjs',
  'scripts/release-trust-review.mjs',
  'scripts/pnpm-audit-config.mjs',
  'scripts/public-export.mjs',
  'scripts/public-release.mjs',
  'scripts/ci-mirror.mjs',
  'docker/Dockerfile',
  'docker/postgres/Dockerfile',
  // Copied over /usr/local/bin/gosu in the database image: it drops the server from root to postgres at start.
  'docker/postgres/gosu-setpriv.sh',
  'package.json',
  'pnpm-workspace.yaml',
  '.gitattributes',
  // The image policy (no package manager in the images) and its guard.
  '.github/workflows/ci.yml',
  'scripts/__tests__/security-workflow.test.mjs',
];

/**
 * Trust files that are symbolic links (git mode 120000) in `commit` of the repository `gitDir`/`cwd`: refused. A link
 * would let the scanners read another file than the one reviewed (`security/exceptions.json` → `security/allow.json`),
 * while the digest covers the link and the review shows no content.
 */
function linkedTrustFiles(gitArgs, commit, files, cwd) {
  const out = gitIn(cwd, [...gitArgs, 'ls-tree', '-z', commit, '--', ...files]);
  return out
    .split('\0')
    .filter(Boolean)
    .filter((entry) => entry.startsWith('120000 '))
    .map((entry) => entry.split('\t')[1]);
}

function refuseLinks(where, linked) {
  if (linked.length) {
    throw new Error(`trust files must be regular files, not symbolic links (${where}): ${linked.join(', ')} — the review and the digest would not show what the scans read`);
  }
}

/** git without any configuration or attributes but its own: nothing of the host or the tree changes its output. */
const CLEAN_ENV = () => {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: os.devNull, GIT_ATTR_NOSYSTEM: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_ATTR_NOSYSTEM'].includes(k)) delete env[k];
  return env;
};
const gitIn = (cwd, args, opts = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: CLEAN_ENV(), ...opts }).trim();

const blobOf = (root, commit, file) => {
  try {
    return gitIn(root, ['rev-parse', '--verify', '--quiet', `${commit}:${file}`], { stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

/** The digest of the trust files at `commit`: each path with its blob id (or `missing`). */
export function trustDigest(root, commit, files = TRUST_FILES) {
  refuseLinks(`the release commit ${commit.slice(0, 12)}`, linkedTrustFiles([], commit, files, root));
  const lines = files.map((f) => `${f}\u0000${blobOf(root, commit, f) ?? 'missing'}\n`);
  return createHash('sha256').update(`heopress-trust\u0000${lines.join('')}`).digest('hex');
}

const exceptionKey = (e) =>
  [e.scanner, e.id, e.package ?? e.path ?? '', [...(e.versions ?? [])].sort().join(','), [...(e.images ?? [])].sort().join(',')].join(' ');
const describe = (e) =>
  `${e.scanner} ${e.id}${e.package ? ` ${e.package}@${(e.versions ?? []).join(',')}` : ''}${e.path ? ` ${e.path}` : ''}` +
  `${e.images ? ` [${e.images.join(',')}]` : ''} owner=${e.owner ?? '?'} reviewBy=${e.reviewBy ?? '-'}${e.fixBlockedBy ? ' fixBlockedBy' : ''}`;

/** Exceptions added, changed (same scanner, id, package, versions and images; other fields differ) and removed. */
export function exceptionChanges(beforeText, afterText) {
  const parse = (text) => {
    if (!text) return [];
    try {
      return JSON.parse(text).exceptions ?? [];
    } catch {
      return [{ scanner: '?', id: 'security/exceptions.json is not JSON' }];
    }
  };
  const before = new Map(parse(beforeText).map((e) => [exceptionKey(e), e]));
  const after = new Map(parse(afterText).map((e) => [exceptionKey(e), e]));
  const out = { added: [], changed: [], removed: [] };
  for (const [k, e] of after) {
    if (!before.has(k)) out.added.push(describe(e));
    else if (JSON.stringify(before.get(k)) !== JSON.stringify(e)) out.changed.push(describe(e));
  }
  for (const [k, e] of before) if (!after.has(k)) out.removed.push(describe(e));
  return out;
}

/**
 * The last public release on `target`: the head of `branch` there, fetched read-only into the throwaway repository
 * `gitDir`, with the tags pointing at it. Null when the branch does not exist (the first release).
 */
export function publicBaseline({ target, branch, gitDir }) {
  const refs = new Map();
  for (const line of gitIn(os.tmpdir(), ['ls-remote', target]).split('\n').filter(Boolean)) {
    const [sha, ref] = line.split('\t');
    refs.set(ref, sha);
  }
  const head = refs.get(`refs/heads/${branch}`);
  if (!head) return null;
  gitIn(os.tmpdir(), ['init', '--quiet', '--bare', gitDir]);
  gitIn(os.tmpdir(), ['--git-dir', gitDir, 'fetch', '--quiet', '--no-tags', '--depth=1', target, `+refs/heads/${branch}:refs/baseline`]);
  const fetched = gitIn(os.tmpdir(), ['--git-dir', gitDir, 'rev-parse', 'refs/baseline']);
  if (fetched !== head) throw new Error(`${target} ${branch} moved while it was read (${head.slice(0, 8)} → ${fetched.slice(0, 8)}): prepare again`);
  const tags = [...refs]
    .filter(([ref, sha]) => ref.startsWith('refs/tags/') && (ref.endsWith('^{}') ? sha === head : sha === head && !refs.has(`${ref}^{}`)))
    .map(([ref]) => ref.replace(/^refs\/tags\//, '').replace(/\^\{\}$/, ''));
  return { commit: head, tags: [...new Set(tags)].sort() };
}

/** Write each trust file of one side into `dir` (absent files are left out); returns the files written. */
function extract(dir, read, files) {
  const written = [];
  for (const f of files) {
    const content = read(f);
    if (content === null) continue;
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), content);
    written.push(f);
  }
  return written;
}

/** `git diff --no-index` of two directories, outside any repository, text forced, no attributes or diff drivers. */
function noIndexDiff(cwd, extra) {
  const res = spawnSync(
    'git',
    ['-c', `core.attributesFile=${os.devNull}`, '-c', 'diff.noprefix=false', 'diff', '--no-index', '--text', '--no-ext-diff', '--no-textconv', '--no-color', ...extra, 'public', 'release'],
    { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: CLEAN_ENV() },
  );
  if (res.status !== 0 && res.status !== 1) throw new Error(`git diff failed: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * The review of the trust files of the release against the last public release on `target` (`branch`): `{ digest,
 * summary, diff, exceptions, baseline }`. The release side is the exported tree `treeDir` (what is published); the
 * digest is taken from the private `commit` (scripts/public-release.mjs checks it again at push).
 */
export function trustReview({ root, commit, treeDir, target, branch = 'main', files = TRUST_FILES }) {
  const digest = trustDigest(root, commit, files); // refuses symbolic links in the release commit
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-trust-review-'));
  try {
    const baseline = publicBaseline({ target, branch, gitDir: path.join(work, 'baseline.git') });
    const readPublic = (f) => {
      if (!baseline) return null;
      try {
        return execFileSync('git', ['--git-dir', path.join(work, 'baseline.git'), 'cat-file', 'blob', `${baseline.commit}:${f}`], { env: CLEAN_ENV(), maxBuffer: 256 * 1024 * 1024 });
      } catch {
        return null;
      }
    };
    if (baseline) refuseLinks(`the last public release ${baseline.commit.slice(0, 12)}`, linkedTrustFiles(['--git-dir', path.join(work, 'baseline.git')], baseline.commit, files, os.tmpdir()));
    refuseLinks(
      'the release tree',
      files.filter((f) => {
        try {
          return fs.lstatSync(path.join(treeDir, f)).isSymbolicLink();
        } catch {
          return false;
        }
      }),
    );
    const readRelease = (f) => {
      const abs = path.join(treeDir, f);
      return fs.existsSync(abs) && fs.lstatSync(abs).isFile() ? fs.readFileSync(abs) : null;
    };
    fs.mkdirSync(path.join(work, 'public'));
    fs.mkdirSync(path.join(work, 'release'));
    extract(path.join(work, 'public'), readPublic, files);
    const published = extract(path.join(work, 'release'), readRelease, files);
    const text = (b) => (b === null ? null : b.toString('utf8'));
    const exceptions = exceptionChanges(text(readPublic('security/exceptions.json')), text(readRelease('security/exceptions.json')));
    const stat = noIndexDiff(work, ['--stat=200']);
    const diff = noIndexDiff(work, []);
    const summary = [];
    if (baseline) {
      summary.push(`changes since the last public release (${target} ${branch} at ${baseline.commit.slice(0, 12)}${baseline.tags.length ? `, ${baseline.tags.join(', ')}` : ''}):`);
    } else {
      summary.push(`first release (${target} has no ${branch}): review the full content of every trust file`);
    }
    summary.push(...(stat ? stat.split('\n').map((l) => `  ${l.trim()}`) : ['  none']));
    const unexported = files.filter((f) => !published.includes(f) && blobOf(root, commit, f));
    if (unexported.length) summary.push(`  not in the release tree (reviewed by digest only): ${unexported.join(', ')}`);
    summary.push(`exceptions: ${exceptions.added.length} added, ${exceptions.changed.length} changed, ${exceptions.removed.length} removed`);
    for (const [sign, list] of [['+', exceptions.added], ['~', exceptions.changed], ['-', exceptions.removed]]) {
      for (const line of list) summary.push(`  ${sign} ${line}`);
    }
    return { digest, summary, diff, exceptions, baseline };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
