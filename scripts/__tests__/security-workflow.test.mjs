import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { pickRun } from '../ci-mirror.mjs';
import { REQUIRED_JOBS } from '../release-security-gate.mjs';

/**
 * P07 task 8.1: the security workflow keeps its guarantees — triggers (every public CI mirror push gets a run record),
 * read-only permissions, actions pinned by SHA, no persisted credentials, the scanners only through
 * scripts/security-scanners.mjs (configuration from outside the tree, nothing left out), and a result job that fails
 * on anything but success. The workflow is read as text: a change that weakens it fails here, in `pnpm check:all`.
 */
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflow = fs.readFileSync(path.join(repo, '.github/workflows/security.yml'), 'utf8');
const ci = fs.readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');

/** The text of each job (`  <name>:` under `jobs:` up to the next job). */
function jobs(text) {
  const body = text.slice(text.indexOf('\njobs:\n'));
  const out = {};
  let name = null;
  for (const line of body.split('\n').slice(2)) {
    const m = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (m) {
      name = m[1];
      out[name] = '';
    } else if (name) out[name] += `${line}\n`;
  }
  return out;
}
const runLines = (text) => text.split('\n').filter((l) => /^\s*(- )?run:|^\s{10,}\S/.test(l));

test('triggers: every push of a public CI mirror branch, nightly, by hand and from another workflow', () => {
  const on = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:'));
  assert.match(on, /\n {2}push:\n {4}branches: \['ci\/\*\*'\]\n/);
  assert.match(on, /\n {2}schedule:\n {4}- cron: '[^']+'/);
  assert.match(on, /\n {2}workflow_dispatch:\n/);
  assert.match(on, /\n {2}workflow_call:\n/);
  assert.doesNotMatch(on, /pull_request/);
});

test('read-only: contents read only, no write permission, no secret, no persisted credentials', () => {
  assert.match(workflow, /\npermissions:\n {2}contents: read\n\n/);
  assert.doesNotMatch(workflow, /:\s*write\b|write-all|secrets\./);
  const checkouts = workflow.match(/uses: actions\/checkout@/g).length;
  const noCredentials = workflow.match(/uses: actions\/checkout@[0-9a-f]{40} # v\d+\n {8}with:\n {10}persist-credentials: false\n/g)?.length ?? 0;
  assert.equal(noCredentials, checkouts, 'every checkout sets persist-credentials: false');
  assert.doesNotMatch(workflow, /continue-on-error/);
});

test('every action is pinned to a full commit SHA; the scanners to a version and SHA-256, gitleaks the same in ci.yml', () => {
  for (const text of [workflow, ci]) {
    for (const use of text.match(/uses: \S+/g)) assert.match(use, /@[0-9a-f]{40}$/, use);
  }
  const pin = (text, key) => new RegExp(`\\n {2}${key}: (\\S+)\\n`).exec(text)?.[1];
  for (const key of ['GITLEAKS_SHA256', 'TRIVY_SHA256']) assert.match(pin(workflow, key) ?? '', /^[0-9a-f]{64}$/, key);
  assert.equal(pin(ci, 'GITLEAKS_VERSION'), pin(workflow, 'GITLEAKS_VERSION'));
  assert.equal(pin(ci, 'GITLEAKS_SHA256'), pin(workflow, 'GITLEAKS_SHA256'));
  for (const text of [workflow, ci]) assert.match(text, /sha256sum -c -/);
});

test('the scanners run only through scripts/security-scanners.mjs, with nothing left out', () => {
  const j = jobs(workflow);
  assert.deepEqual(Object.keys(j), ['ref', 'exceptions', 'pnpm-audit', 'gitleaks', 'trivy', 'result']);
  assert.match(j['pnpm-audit'], /run: node scripts\/security-scanners\.mjs audit --dir \. --report /);
  assert.match(j.gitleaks, /run: node scripts\/security-scanners\.mjs gitleaks --dir \. --report "\$RUNNER_TEMP\/gitleaks\.json" --bin "\$RUNNER_TEMP\/gitleaks"/);
  assert.match(j.trivy, /run: node scripts\/security-scanners\.mjs trivy --dir \. --image /);
  for (const [name, text] of Object.entries(j)) {
    for (const line of runLines(text)) {
      // A scanner started directly would read its configuration from the tree.
      assert.doesNotMatch(line, /\b(gitleaks|trivy)"? (dir|git|detect|image|fs|repo)\b|pnpm audit/, `${name}: ${line.trim()}`);
    }
  }
  const code = workflow
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(code, /--ignore-unfixed|--ignorefile|\.trivyignore|[^s]\.gitleaks(\.toml|ignore)|trivy\.ya?ml|--gitleaks-ignore-path|--config /);
  for (const scan of ['pnpm-audit', 'gitleaks']) assert.match(j[scan], /run: node scripts\/check-security-scan\.mjs /);
  assert.match(j.trivy, /run: node scripts\/check-security-scan\.mjs trivy /);
  assert.match(j.exceptions, /run: node scripts\/check-security-scan\.mjs exceptions/);
  // The three product images.
  for (const image of ['cms', 'site-classic', 'postgres']) assert.match(j.trivy, new RegExp(`- image: ${image}\\n`));
});

test('the result job always runs, needs every scan and fails on anything but success', () => {
  const { result } = jobs(workflow);
  assert.match(result, /\n {4}if: always\(\)\n/);
  assert.match(result, /\n {4}needs: \[ref, exceptions, pnpm-audit, gitleaks, trivy\]\n/);
  assert.match(result, /if \[ "\$job" = success \]; then\n\s+verdict=passed/);
  assert.match(result, /exit "\$fail"/);
  // Every scan job but the matrix reports a status, so the result can tell "failed" from "not completed".
  for (const scan of ['exceptions', 'pnpm-audit', 'gitleaks']) assert.match(jobs(workflow)[scan], /outputs:\n {6}status: /);
});

test('manual runs are limited to trusted refs', () => {
  const { ref } = jobs(workflow);
  assert.match(ref, /refs\/heads\/main\|refs\/heads\/ci\/\*\|refs\/tags\/v\*\)/);
  for (const job of ['exceptions', 'pnpm-audit', 'gitleaks', 'trivy']) assert.match(jobs(workflow)[job], /\n {4}needs: ref\n/, job);
});

test('the public-mirror-ci status still comes from ci.yml: a security run on the same commit is never picked', () => {
  const record = { mirrorSha: 'f'.repeat(40), branch: 'ci/b-0123456789abcdef0123' };
  const base = { head_sha: record.mirrorSha, event: 'push', head_branch: record.branch, run_attempt: 1 };
  const runs = [
    { ...base, path: '.github/workflows/security.yml', run_number: 9, conclusion: 'failure' },
    { ...base, path: '.github/workflows/ci.yml', run_number: 4, conclusion: 'success' },
  ];
  assert.equal(pickRun(runs, record).path, '.github/workflows/ci.yml');
  assert.equal(pickRun([runs[0]], record), null);
});

const hasActionlint = !spawnSync('actionlint', ['-version']).error;
test('actionlint accepts the security workflow', { skip: hasActionlint ? false : 'actionlint is not installed' }, () => {
  const res = spawnSync('actionlint', [path.join(repo, '.github/workflows/security.yml')], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test('every job the release gate requires exists in the workflow under that name', () => {
  const names = [];
  for (const text of Object.values(jobs(workflow))) {
    const name = /^ {4}name: (.+)$/m.exec(text)?.[1];
    if (!name) continue;
    if (name.includes('${{ matrix.image }}')) {
      for (const m of text.matchAll(/- image: ([a-z-]+)\n/g)) names.push(name.replace('${{ matrix.image }}', m[1]));
    } else names.push(name);
  }
  for (const re of REQUIRED_JOBS) assert.ok(names.some((n) => re.test(n)), `${re} matches no job of security.yml (${names.join(' | ')})`);
});

test('the CI image checks find no package manager at all in the CMS and rendering-service images', () => {
  const checks = ci.split('\n').filter((l) => l.includes('! command -v npm'));
  assert.equal(checks.length, 2);
  for (const line of checks) {
    for (const tool of ['npm', 'npx', 'corepack', 'yarn', 'yarnpkg']) assert.ok(line.includes(`! command -v ${tool} `), `${tool}: ${line.trim()}`);
    // Not only off the PATH: their directories are gone too (node:24-trixie-slim ships /opt/yarn-v1.22.22 and
    // /usr/local/lib/node_modules/{npm,corepack}).
    for (const dir of ['npm', 'corepack', 'yarn']) assert.ok(line.includes(`test ! -e /usr/local/lib/node_modules/${dir} `), `${dir}: ${line.trim()}`);
    assert.ok(line.includes('test -z "$(ls -d /opt/yarn* 2>/dev/null)"'), line.trim());
  }
  // And the images take every published Debian fix: dist-upgrade, nothing kept back.
  for (const file of ['docker/Dockerfile', 'docker/postgres/Dockerfile']) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8');
    assert.match(text, /apt-get -y --no-install-recommends dist-upgrade/, file);
    // The simulation's output is captured first: a failing apt-get stops the build (the `&&` chain) instead of being
    // read as "nothing pending" by a grep at the end of a pipe.
    assert.match(text, /&& pending="\$\(apt-get -s dist-upgrade\)" \\\n\s*&& if printf '%s\\n' "\$pending" \| grep -E '\^Inst \|kept back'; then .*exit 1; fi/, file);
    assert.doesNotMatch(text, /apt-get -s dist-upgrade \|/, file);
    assert.doesNotMatch(text, /apt-get upgrade/, file);
  }
});
