import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

import { MAX_SCAN_AGE_DAYS, REQUIRED_JOBS, SECURITY_WORKFLOW, mirrorCommitOf, pickSecurityRun, releaseSecurityGate } from '../release-security-gate.mjs';

/**
 * P07 task 8.1: the release gate. A release needs, for the exact tree it publishes, valid exceptions, a passing
 * `pnpm audit` and a successful security workflow run on the public CI mirror commit of that tree. The audit and the
 * GitHub API are stubbed: no network here.
 */

// Run from a git hook, the environment names the repository being committed to (GIT_DIR, …): dropped first.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

const made = [];
after(() => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

const SHA = 'a'.repeat(40);
const NOW = Date.parse('2026-10-23T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** A release tree with its export entries (blob ids as git computes them). */
function releaseTree({ exceptions = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-gate-'));
  made.push(dir);
  const files = {
    'package.json': JSON.stringify({ name: 'heopress', private: true, license: 'AGPL-3.0-only' }),
    'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
    'security/exceptions.json': JSON.stringify({ exceptions }),
    'src/index.ts': 'export const answer = 42;\n',
    '.github/workflows/security.yml': 'name: Security scans\n',
  };
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  const entries = Object.keys(files).map((file) => ({
    mode: '100644',
    object: execFileSync('git', ['hash-object', path.join(dir, file)], { encoding: 'utf8' }).trim(),
    file,
  }));
  return { dir, entries };
}

const cleanAudit = () => ({
  advisories: {},
  muted: [],
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }, dependencies: 800, totalDependencies: 800 },
});
const run = (mirrorSha, overrides = {}) => ({
  id: 7,
  run_number: 7,
  run_attempt: 1,
  head_sha: mirrorSha,
  path: SECURITY_WORKFLOW,
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  run_started_at: new Date(NOW - DAY).toISOString(),
  html_url: 'https://github.example.com/web-casa/HeoPress/actions/runs/7',
  ...overrides,
});

/** The jobs of a complete, successful run of the security workflow. */
const JOB_NAMES = [
  'Trusted ref (main, a public CI mirror branch or a release tag)',
  'Exceptions are complete and none has expired',
  'pnpm audit (high and critical; project audit ignores dropped)',
  'gitleaks (secrets in the tree)',
  'Trivy (cms image, high and critical)',
  'Trivy (site-classic image, high and critical)',
  'Trivy (postgres image, high and critical)',
  'Security scan result (an unavailable scanner is not completed, never passed)',
];
const allJobs = () => JOB_NAMES.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
const releasedBlob = (tree) => tree.entries.find((e) => e.file === SECURITY_WORKFLOW).object;

const gate = (tree, { audit = cleanAudit, runs = (sha) => [run(sha)], now = NOW, blob = releasedBlob(tree), jobs = allJobs } = {}) => {
  const asked = [];
  const result = releaseSecurityGate({
    sha: SHA,
    treeDir: tree.dir,
    entries: tree.entries,
    now,
    audit,
    runsFor: (mirrorSha) => {
      asked.push(mirrorSha);
      return runs(mirrorSha);
    },
    workflowBlobAt: (mirrorSha) => {
      asked.push(`blob@${mirrorSha}`);
      return blob;
    },
    jobsOf: () => jobs(),
  });
  return { result, asked };
};
const gateError = (tree, opts) => {
  try {
    gate(tree, opts);
  } catch (err) {
    return err.message;
  }
  assert.fail('expected the gate to stop the release');
};

test('the mirror commit is computed from the tree as ci-mirror builds it: the same tree gives the same commit, another tree another', () => {
  const tree = releaseTree();
  const a = mirrorCommitOf({ treeDir: tree.dir, entries: tree.entries, sha: SHA });
  const b = mirrorCommitOf({ treeDir: tree.dir, entries: tree.entries, sha: SHA });
  assert.match(a.commit, /^[0-9a-f]{40}$/);
  assert.deepEqual(a, b);
  const other = releaseTree();
  fs.writeFileSync(path.join(other.dir, 'src/index.ts'), 'export const answer = 43;\n');
  other.entries.find((e) => e.file === 'src/index.ts').object = execFileSync('git', ['hash-object', path.join(other.dir, 'src/index.ts')], { encoding: 'utf8' }).trim();
  assert.notEqual(mirrorCommitOf({ treeDir: other.dir, entries: other.entries, sha: SHA }).commit, a.commit);
});

test('a successful, recent security run on the mirror commit of the tree, valid exceptions and a clean audit pass', () => {
  const tree = releaseTree();
  const { result, asked } = gate(tree);
  const { commit } = mirrorCommitOf({ treeDir: tree.dir, entries: tree.entries, sha: SHA });
  assert.deepEqual(asked, [commit, `blob@${commit}`]);
  assert.equal(result.mirrorSha, commit);
  assert.equal(result.run.url, 'https://github.example.com/web-casa/HeoPress/actions/runs/7');
});

test('no run, a run in progress, a failed run, a run too old or the run of another workflow or commit stops the release', () => {
  const tree = releaseTree();
  assert.match(gateError(tree, { runs: () => [] }), /no run of \.github\/workflows\/security\.yml on the mirror commit/);
  assert.match(gateError(tree, { runs: (s) => [run(s, { status: 'in_progress', conclusion: null })] }), /is in_progress: wait for it/);
  assert.match(gateError(tree, { runs: (s) => [run(s, { conclusion: 'failure' })] }), /concluded failure/);
  const old = new Date(NOW - (MAX_SCAN_AGE_DAYS + 1) * DAY).toISOString();
  assert.match(gateError(tree, { runs: (s) => [run(s, { run_started_at: old })] }), /older than 7 days/);
  assert.match(gateError(tree, { runs: (s) => [run(s, { path: '.github/workflows/ci.yml' })] }), /no run of/);
  assert.match(gateError(tree, { runs: () => [run('b'.repeat(40))] }), /no run of/);
  // The latest attempt decides: a successful first attempt does not hide a failed re-run.
  assert.match(gateError(tree, { runs: (s) => [run(s), run(s, { run_attempt: 2, conclusion: 'failure' })] }), /concluded failure/);
});

test('when GitHub cannot be read the scan is not established, never passed', () => {
  const tree = releaseTree();
  const message = gateError(tree, {
    runs: () => {
      throw new Error('gh: To get started with GitHub CLI, please run: gh auth login');
    },
  });
  assert.match(message, /could not be read \(gh\): gh: To get started/);
});

test('an expired exception, an uncovered high advisory or an audit that did not complete stops the release', () => {
  const expired = releaseTree({
    exceptions: [{ scanner: 'pnpm-audit', id: 'GHSA-aaaa', package: 'left-pad', versions: ['1.0.0'], owner: 'm', reason: 'r', reviewBy: '2026-10-01' }],
  });
  assert.match(gateError(expired), /expired: the review deadline 2026-10-01 has passed/);
  const tree = releaseTree();
  const high = () => ({
    ...cleanAudit(),
    advisories: { 1: { github_advisory_id: 'GHSA-bbbb', module_name: 'left-pad', severity: 'high', title: 'x', findings: [{ version: '1.0.0' }] } },
    metadata: { ...cleanAudit().metadata, vulnerabilities: { high: 1, critical: 0 } },
  });
  assert.match(gateError(tree, { audit: high }), /pnpm audit failed:\n {4}GHSA-bbbb left-pad@1\.0\.0 \(high\)/);
  assert.match(gateError(tree, { audit: () => undefined }), /pnpm audit not-completed/);
  assert.match(gateError(tree, { audit: () => ({ error: { code: 'ECONNREFUSED' } }) }), /pnpm audit not-completed/);
});

test('the run picked is the security workflow on that commit, from a mirror push or a manual run, latest attempt', () => {
  const sha = 'c'.repeat(40);
  assert.equal(pickSecurityRun([run(sha, { event: 'schedule' }), run(sha, { event: 'pull_request' })], sha), null);
  assert.equal(pickSecurityRun([run(sha, { event: 'workflow_dispatch', id: 9 })], sha).id, 9);
  assert.equal(pickSecurityRun(undefined, sha), null);
});

test('a run of another version of the workflow, or one that skipped a required scan, does not count', () => {
  const tree = releaseTree();
  // GitHub holds another blob for the run's workflow at the mirror commit than the released file.
  assert.match(gateError(tree, { blob: 'f'.repeat(40) }), /the security run's workflow \(\.github\/workflows\/security\.yml, blob ffffffffffff\) is not the released/);
  // A released workflow that no longer scans the postgres image (or whose result job was dropped) gives a green run
  // without those jobs: the gate's own list of required jobs refuses it.
  const withoutPostgres = () => allJobs().filter((j) => !j.name.startsWith('Trivy (postgres'));
  assert.match(gateError(tree, { jobs: withoutPostgres }), /no job matching \/\^Trivy \\\(postgres image\//);
  const skipped = () => allJobs().map((j) => (j.name.startsWith('gitleaks') ? { ...j, conclusion: 'skipped' } : j));
  assert.match(gateError(tree, { jobs: skipped }), /the job "gitleaks \(secrets in the tree\)" of the security run is completed\/skipped/);
  assert.equal(REQUIRED_JOBS.length, 7);
  // A release tree without the workflow file has nothing to bind the run to.
  const noWorkflow = releaseTree();
  noWorkflow.entries = noWorkflow.entries.filter((e) => e.file !== SECURITY_WORKFLOW);
  fs.rmSync(path.join(noWorkflow.dir, SECURITY_WORKFLOW));
  assert.match(gateError(noWorkflow, { blob: 'x' }), /is not in the release tree/);
});
