import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { TRUST_FILES, exceptionChanges, trustReview } from '../release-trust-review.mjs';

// Run from a git hook, the environment names the repository being committed to (GIT_DIR, GIT_INDEX_FILE, …): dropped
// first, so the fixture repositories below are the only ones these git commands touch.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

// P07 task 8.1: what the maintainer reviews at release time in the files the security gate trusts.
const e = (id, extra = {}) => ({ scanner: 'trivy', id, package: 'libfoo', versions: ['1.0-1'], owner: 'maintainer', reason: 'r', reviewBy: '2027-01-01', ...extra });
const doc = (...list) => JSON.stringify({ exceptions: list });

test('exceptions added, changed (owner, reason or deadline) and removed are listed with id, package, owner and deadline', () => {
  const before = doc(e('CVE-1'), e('CVE-2'), { scanner: 'gitleaks', id: 'abc', path: 'a.ts:1', owner: 'm', reason: 'placeholder' });
  const after = doc(e('CVE-1', { reviewBy: '2027-06-01' }), e('CVE-3', { owner: 'someone' }), { scanner: 'gitleaks', id: 'abc', path: 'a.ts:1', owner: 'm', reason: 'placeholder' });
  assert.deepEqual(exceptionChanges(before, after), {
    added: ['trivy CVE-3 libfoo@1.0-1 owner=someone reviewBy=2027-01-01'],
    changed: ['trivy CVE-1 libfoo@1.0-1 owner=maintainer reviewBy=2027-06-01'],
    removed: ['trivy CVE-2 libfoo@1.0-1 owner=maintainer reviewBy=2027-01-01'],
  });
  // The first release: everything is new.
  assert.equal(exceptionChanges(null, after).added.length, 3);
  // Other versions of the same advisory and package are another exception.
  assert.equal(exceptionChanges(doc(e('CVE-1')), doc(e('CVE-1', { versions: ['2.0-1'] }))).added.length, 1);
});

test('the trust files cover the workflow, the scanners, the checker, the gate, the exceptions, the images and the attributes', () => {
  for (const f of ['.github/workflows/security.yml', 'scripts/security-scanners.mjs', 'scripts/check-security-scan.mjs', 'scripts/release-security-gate.mjs', 'security/exceptions.json']) {
    assert.ok(TRUST_FILES.includes(f), f);
  }
  for (const f of ['docker/Dockerfile', 'docker/postgres/Dockerfile', '.gitattributes', '.github/workflows/ci.yml', 'scripts/__tests__/security-workflow.test.mjs']) {
    assert.ok(TRUST_FILES.includes(f), f);
  }
});

test('an exception for other images is another exception; fixBlockedBy is shown', () => {
  const a = e('CVE-1', { images: ['cms'] });
  const b = e('CVE-1', { images: ['cms', 'postgres'], fixBlockedBy: 'upstream image rebuild' });
  assert.deepEqual(exceptionChanges(doc(a), doc(b)), {
    added: ['trivy CVE-1 libfoo@1.0-1 [cms,postgres] owner=maintainer reviewBy=2027-01-01 fixBlockedBy'],
    changed: [],
    removed: ['trivy CVE-1 libfoo@1.0-1 [cms] owner=maintainer reviewBy=2027-01-01'],
  });
});

test('a trust file that is a symbolic link in the exported release tree is refused, even when the release commit holds a regular file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-trust-link-'));
  try {
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
    const repo = path.join(dir, 'repo');
    fs.mkdirSync(path.join(repo, 'security'), { recursive: true });
    const git = (args, cwd = repo) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
    git(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(repo, 'security/exceptions.json'), doc());
    git(['add', '-A']);
    git(['commit', '-qm', 'regular exceptions']);
    const commit = git(['rev-parse', 'HEAD']);
    // No public release yet: an empty target (the first release, reviewed in full).
    const target = path.join(dir, 'public.git');
    git(['init', '-q', '--bare', target], dir);
    // The exported tree, as written for the release: the trust file there is a link to a file the review never shows.
    const treeDir = path.join(dir, 'tree');
    fs.mkdirSync(path.join(treeDir, 'security'), { recursive: true });
    fs.writeFileSync(path.join(treeDir, 'security/allow.json'), doc());
    fs.symlinkSync('allow.json', path.join(treeDir, 'security/exceptions.json'));
    assert.throws(
      () => trustReview({ root: repo, commit, treeDir, target: `file://${target}`, files: ['security/exceptions.json'] }),
      /trust files must be regular files, not symbolic links \(the release tree\): security\/exceptions\.json/,
    );
    // The same tree with a regular file: reviewed.
    fs.rmSync(path.join(treeDir, 'security/exceptions.json'));
    fs.writeFileSync(path.join(treeDir, 'security/exceptions.json'), doc());
    assert.ok(trustReview({ root: repo, commit, treeDir, target: `file://${target}`, files: ['security/exceptions.json'] }).digest);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
