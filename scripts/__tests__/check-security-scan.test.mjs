import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { auditIgnores, checkGitleaks, checkPnpmAudit, checkTrivy, imageOf, validateExceptions } from '../check-security-scan.mjs';
import { findingHash } from '../public-export.mjs';

// P07 task 8.1: scan results against security/exceptions.json (ADR-0017 §5).
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const script = path.join(repo, 'scripts/check-security-scan.mjs');
const TODAY = '2026-10-23';

const audit = (overrides = {}) => ({
  scanner: 'pnpm-audit',
  id: 'GHSA-aaaa-bbbb-cccc',
  package: 'left-pad',
  versions: ['1.3.0'],
  owner: 'maintainer',
  reason: 'not reachable from any shipped code path',
  reviewBy: '2026-12-31',
  ...overrides,
});

const auditReport = (advisories, counts = { info: 0, low: 0, moderate: 0, high: advisories.length, critical: 0 }) => ({
  actions: [],
  muted: [],
  advisories: Object.fromEntries(advisories.map((a, i) => [String(1000 + i), a])),
  metadata: { vulnerabilities: counts, dependencies: 10 },
});
const advisory = (overrides = {}) => ({
  id: 1000,
  github_advisory_id: 'GHSA-aaaa-bbbb-cccc',
  cves: ['CVE-2026-0001'],
  module_name: 'left-pad',
  severity: 'high',
  title: 'Prototype pollution',
  findings: [{ version: '1.3.0', paths: ['apps/cms > left-pad@1.3.0'] }],
  ...overrides,
});

test('a complete exception within its review deadline is valid', () => {
  const { problems, active } = validateExceptions({ exceptions: [audit()] }, TODAY);
  assert.deepEqual(problems, []);
  assert.equal(active.length, 1);
});

test('an expired exception fails and no longer covers its finding', () => {
  const doc = { exceptions: [audit({ reviewBy: '2026-10-22' })] };
  const { problems, active } = validateExceptions(doc, TODAY);
  assert.deepEqual(problems, [
    'exceptions[0] (pnpm-audit GHSA-aaaa-bbbb-cccc left-pad): expired: the review deadline 2026-10-22 has passed — review it, then renew or remove the exception',
  ]);
  assert.deepEqual(active, []);
  const result = checkPnpmAudit(auditReport([advisory()]), active);
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.problems, ['GHSA-aaaa-bbbb-cccc left-pad@1.3.0 (high): Prototype pollution']);
  // On its deadline day the exception still holds.
  assert.deepEqual(validateExceptions(doc, '2026-10-22').problems, []);
});

test('owner, versions, reason and review deadline are required of a vulnerability exception', () => {
  const doc = {
    exceptions: [
      audit({ owner: '', versions: [], reason: ' ', reviewBy: undefined }),
      audit({ scanner: 'trivy', id: 'CVE-2026-0002', package: '', reviewBy: '2026-13-01' }),
      audit({ scanner: 'npm', id: 'X' }),
      audit({ id: 'GHSA-far', reviewBy: '2027-06-01' }),
    ],
  };
  assert.deepEqual(validateExceptions(doc, TODAY).problems, [
    'exceptions[0] (pnpm-audit GHSA-aaaa-bbbb-cccc left-pad): owner is missing',
    'exceptions[0] (pnpm-audit GHSA-aaaa-bbbb-cccc left-pad): reason is missing',
    'exceptions[0] (pnpm-audit GHSA-aaaa-bbbb-cccc left-pad): versions must list the exact installed versions the exception covers',
    'exceptions[0] (pnpm-audit GHSA-aaaa-bbbb-cccc left-pad): reviewBy must be a date (YYYY-MM-DD)',
    'exceptions[1] (trivy CVE-2026-0002): package is missing',
    'exceptions[1] (trivy CVE-2026-0002): images must list the images the exception covers (cms, site-classic, postgres)',
    'exceptions[1] (trivy CVE-2026-0002): reviewBy must be a date (YYYY-MM-DD)',
    'exceptions[2] (npm X left-pad): scanner must be one of pnpm-audit, trivy, gitleaks',
    'exceptions[3] (pnpm-audit GHSA-far left-pad): reviewBy 2027-06-01 is more than 180 days ahead',
  ]);
});

test('a finding with a published fix is fixed, not excepted: only fixBlockedBy, reviewed within 30 days, covers it', () => {
  const fixed = { VulnerabilityID: 'CVE-2026-0003', PkgName: 'libfoo', InstalledVersion: '1.0-1', FixedVersion: '1.0-2', Severity: 'HIGH' };
  const base = audit({ scanner: 'trivy', id: 'CVE-2026-0003', package: 'libfoo', versions: ['1.0-1'], images: ['cms'], reviewBy: '2026-11-20' });
  const plain = validateExceptions({ exceptions: [base] }, TODAY).active;
  const result = checkTrivy(trivyReport([fixed]), plain);
  assert.equal(result.status, 'failed');
  assert.match(result.problems[0], /fixed in 1\.0-2 — a fix is published: take it \(an exception for a fixable finding needs fixBlockedBy/);
  const blocked = validateExceptions({ exceptions: [{ ...base, fixBlockedBy: 'fixed only by an upstream image rebuild' }] }, TODAY);
  assert.deepEqual(blocked.problems, []);
  assert.equal(checkTrivy(trivyReport([fixed]), blocked.active).status, 'passed');
  // fixBlockedBy allows a short wait only, and must say why.
  assert.match(validateExceptions({ exceptions: [{ ...base, fixBlockedBy: 'x', reviewBy: '2026-12-31' }] }, TODAY).problems[0], /more than 30 days ahead/);
  assert.match(validateExceptions({ exceptions: [{ ...base, fixBlockedBy: ' ' }] }, TODAY).problems[0], /fixBlockedBy must say why/);
  // The same for npm advisories with patched versions ("<0.0.0": none).
  const { active } = validateExceptions({ exceptions: [audit()] }, TODAY);
  assert.equal(checkPnpmAudit(auditReport([advisory({ patched_versions: '>=1.3.1' })]), active).status, 'failed');
  assert.equal(checkPnpmAudit(auditReport([advisory({ patched_versions: '<0.0.0' })]), active).status, 'passed');
});

test('a gitleaks exception needs its path; a review deadline is optional but enforced when given', () => {
  const g = { scanner: 'gitleaks', id: 'abc', owner: 'maintainer', reason: 'placeholder', path: '.env.example:3' };
  assert.deepEqual(validateExceptions({ exceptions: [g] }, TODAY).problems, []);
  assert.deepEqual(validateExceptions({ exceptions: [{ ...g, path: '' }] }, TODAY).problems, ['exceptions[0] (gitleaks abc): path is missing']);
  assert.match(validateExceptions({ exceptions: [{ ...g, reviewBy: '2026-01-01' }] }, TODAY).problems[0], /expired/);
});

test('an advisory pnpm ignores by configuration (ignoreGhsas or ignoreCves) needs a valid exception; duplicates fail', () => {
  const ignored = auditIgnores({ pnpm: { auditConfig: { ignoreGhsas: ['GHSA-zzzz'], ignoreCves: ['CVE-2026-9999'] } } });
  assert.deepEqual(ignored, ['GHSA-zzzz', 'CVE-2026-9999']);
  assert.deepEqual(validateExceptions({ exceptions: [] }, TODAY, { ignored }).problems, [
    'pnpm ignores GHSA-zzzz (pnpm.auditConfig) without a valid pnpm-audit exception in security/exceptions.json',
    'pnpm ignores CVE-2026-9999 (pnpm.auditConfig) without a valid pnpm-audit exception in security/exceptions.json',
  ]);
  const both = [audit({ id: 'GHSA-zzzz' }), audit({ id: 'CVE-2026-9999' })];
  assert.deepEqual(validateExceptions({ exceptions: both }, TODAY, { ignored }).problems, []);
  // An expired exception does not cover an ignore either.
  assert.equal(validateExceptions({ exceptions: [both[0], { ...both[1], reviewBy: '2026-10-01' }] }, TODAY, { ignored }).problems.length, 2);
  assert.deepEqual(auditIgnores({}), []);
  assert.match(validateExceptions({ exceptions: [audit(), audit()] }, TODAY).problems[0], /duplicate/);
  // The same advisory and package in two images with different installed versions: two exceptions, two reasons.
  const debian12 = audit({ scanner: 'trivy', id: 'CVE-2026-76642', package: 'mount', versions: ['2.38.1-5+deb12u3'], images: ['cms'], reason: 'node base image' });
  const debian13 = { ...debian12, versions: ['2.41.5-0+deb13u1'], images: ['postgres'], reason: 'postgres base image' };
  assert.deepEqual(validateExceptions({ exceptions: [debian12, debian13] }, TODAY).problems, []);
  assert.match(validateExceptions({ exceptions: [debian12, { ...debian13, versions: ['2.41.5-0+deb13u1', '2.38.1-5+deb12u3'], images: ['postgres', 'cms'] }] }, TODAY).problems[0], /duplicate/);
  // The same version for another image is another exception, with its own reason.
  assert.deepEqual(validateExceptions({ exceptions: [debian12, { ...debian12, images: ['postgres'], reason: 'other' }] }, TODAY).problems, []);
  assert.deepEqual(validateExceptions({}, TODAY).problems, ['security exceptions: "exceptions" must be a list']);
});

test('pnpm audit: only high and critical findings count; an exception covers its advisory, package and versions only', () => {
  const { active } = validateExceptions({ exceptions: [audit()] }, TODAY);
  assert.equal(checkPnpmAudit(auditReport([advisory()]), active).status, 'passed');
  // Matched by CVE as well as by GHSA.
  const byCve = validateExceptions({ exceptions: [audit({ id: 'CVE-2026-0001' })] }, TODAY).active;
  assert.equal(checkPnpmAudit(auditReport([advisory()]), byCve).status, 'passed');
  const other = checkPnpmAudit(auditReport([advisory({ findings: [{ version: '1.3.1' }] })]), active);
  assert.deepEqual(other.problems, ['GHSA-aaaa-bbbb-cccc left-pad@1.3.1 (high): Prototype pollution']);
  const moderate = auditReport([advisory({ severity: 'moderate' })], { moderate: 1, high: 0, critical: 0 });
  assert.equal(checkPnpmAudit(moderate, []).status, 'passed');
  assert.equal(checkPnpmAudit(auditReport([advisory({ severity: 'critical' })]), []).status, 'failed');
});

test('pnpm audit: an error, a missing, empty or inconsistent report is not completed, never passed', () => {
  for (const report of [
    undefined,
    [],
    { error: { code: 'ERR_PNPM_AUDIT_BAD_RESPONSE' } },
    { advisories: {} },
    { advisories: [], metadata: { vulnerabilities: {}, totalDependencies: 5 } },
    auditReport([], { high: 2, critical: 0 }),
    { ...auditReport([]), metadata: { vulnerabilities: { high: 0 }, dependencies: 0, totalDependencies: 0 } },
  ]) {
    assert.equal(checkPnpmAudit(report, []).status, 'not-completed', JSON.stringify(report));
  }
});

test('pnpm audit: an advisory pnpm ignores leaves the counts high; with a valid exception for it that is a pass, not "not completed"', () => {
  // pnpm drops an ignored advisory from the list but not from the counts.
  const report = auditReport([], { info: 0, low: 0, moderate: 0, high: 1, critical: 0 });
  assert.equal(checkPnpmAudit(report, [], { ignored: ['GHSA-zzzz'] }).status, 'passed');
  assert.equal(checkPnpmAudit(report, []).status, 'not-completed');
  // Another, listed advisory is still judged on its own.
  const listed = auditReport([advisory()], { high: 2, critical: 0 });
  assert.equal(checkPnpmAudit(listed, [], { ignored: ['GHSA-zzzz'] }).status, 'failed');
});

test('pnpm audit: an ignore does not switch the count check off — a truncated report is still not completed', () => {
  // One advisory is legitimately ignored (and excepted); the report lost the list but counts two high advisories:
  // the second is unrelated and unexcepted, so the report cannot pass.
  const truncated = auditReport([], { info: 0, low: 0, moderate: 0, high: 2, critical: 0 });
  const result = checkPnpmAudit(truncated, [], { ignored: ['GHSA-zzzz'] });
  assert.equal(result.status, 'not-completed');
  assert.match(result.problems[0], /the counts name 2 high or critical advisories; the report lists 0 and 1 are ignored by configuration/);
  // Critical counts too; a report from the scans (ignores dropped) is checked strictly.
  assert.equal(checkPnpmAudit(auditReport([advisory()], { high: 1, critical: 1 }), [], { ignored: ['GHSA-zzzz'] }).status, 'failed');
  assert.equal(checkPnpmAudit(auditReport([advisory()], { high: 1, critical: 1 }), []).status, 'not-completed');
});

test('the ignores of both copies are read: package.json and pnpm-workspace.yaml, quoted keys and flow lists included', () => {
  const ws = "packages:\n  - 'apps/*'\n'auditConfig':\n  \"ignoreCves\": [CVE-2026-1111, 'CVE-2026-2222']\n  ignoreGhsas:\n    - \"GHSA-ws\"\n";
  assert.deepEqual(auditIgnores({ pnpm: { auditConfig: { ignoreGhsas: ['GHSA-pkg'] } } }, ws).sort(), ['CVE-2026-1111', 'CVE-2026-2222', 'GHSA-pkg', 'GHSA-ws']);
  assert.throws(() => auditIgnores({}, 'auditConfig: *alias\n'), /cannot be read|not a mapping/);
});

const trivyReport = (vulns) => ({
  SchemaVersion: 2,
  ArtifactName: 'heopress-cms:scan',
  Results: [{ Target: 'heopress-cms:scan (debian 12.15)', Class: 'os-pkgs', Vulnerabilities: vulns }],
});

test('Trivy: high and critical findings need an exception for that package version and image; no results is not completed', () => {
  const vuln = { VulnerabilityID: 'CVE-2026-0003', PkgName: 'libfoo', InstalledVersion: '1.0-1', Severity: 'HIGH' };
  const trivyException = (extra = {}) => audit({ scanner: 'trivy', id: 'CVE-2026-0003', package: 'libfoo', versions: ['1.0-1'], images: ['cms'], ...extra });
  const { active } = validateExceptions({ exceptions: [trivyException()] }, TODAY);
  assert.equal(checkTrivy(trivyReport([vuln]), active).status, 'passed');
  assert.deepEqual(checkTrivy(trivyReport([vuln]), []).problems, ['CVE-2026-0003 libfoo@1.0-1 (high) in heopress-cms:scan: heopress-cms:scan (debian 12.15)']);
  assert.equal(checkTrivy(trivyReport([{ ...vuln, Severity: 'MEDIUM' }]), []).status, 'passed');
  // The exception names cms: it does not cover the same package version in the postgres image.
  const postgres = { ...trivyReport([vuln]), ArtifactName: 'heopress-postgres:scan' };
  assert.equal(checkTrivy(postgres, active).status, 'failed');
  // A report of the postgres image checked "as cms" is refused: the image is the report's own artifact.
  const mismatch = checkTrivy(postgres, active, { image: 'cms' });
  assert.equal(mismatch.status, 'failed');
  assert.deepEqual(mismatch.problems, ['the report is of heopress-postgres:scan (image postgres), not of the image cms it is checked as']);
  assert.equal(checkTrivy(trivyReport([vuln]), active, { image: 'cms' }).status, 'passed');
  assert.equal(imageOf('ghcr.io/example/heopress-site-classic:scan'), 'site-classic');
  for (const report of [
    undefined,
    { SchemaVersion: 2, ArtifactName: 'x' },
    { SchemaVersion: 2, ArtifactName: 'x', Results: [] },
    { Results: [] },
    { SchemaVersion: 2, ArtifactName: 'x', Results: [{}] },
    // No operating-system packages: the image was not really scanned.
    { SchemaVersion: 2, ArtifactName: 'x', Results: [{ Target: 'Node.js', Class: 'lang-pkgs' }] },
  ]) {
    assert.equal(checkTrivy(report, []).status, 'not-completed');
  }
});

test('gitleaks: a reviewed finding stays excepted only while its line is unchanged; no report is not completed', () => {
  const lines = { 'docs/a.md': ['', 'token = "placeholder-value-123456"'] };
  const readLine = (file, n) => lines[file]?.[n - 1] ?? '';
  const finding = { File: './docs/a.md', RuleID: 'generic-api-key', StartLine: 2 };
  const id = findingHash('docs/a.md', 'generic-api-key', lines['docs/a.md'][1]);
  const active = [{ scanner: 'gitleaks', id, path: 'docs/a.md:2', owner: 'm', reason: 'placeholder' }];
  assert.equal(checkGitleaks([finding], active, readLine).status, 'passed');
  lines['docs/a.md'][1] = 'token = "a-real-looking-value-654321"';
  const changed = checkGitleaks([finding], active, readLine);
  assert.equal(changed.status, 'failed');
  assert.match(changed.problems[0], /^docs\/a\.md:2 generic-api-key \(review id [0-9a-f]{64}\)$/);
  assert.equal(checkGitleaks({ error: 'x' }, [], readLine).status, 'not-completed');
  assert.equal(checkGitleaks([{ File: 'a' }], [], readLine).status, 'not-completed');
});

/** A throwaway repository root holding package.json and security/exceptions.json. */
function fixtureRoot(t, exceptions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-security-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'security'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', private: true }));
  fs.writeFileSync(path.join(dir, 'security/exceptions.json'), JSON.stringify({ exceptions }));
  return dir;
}

const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: '' } });

test('the command exits 1 on an expired exception, 2 on a missing report, 0 when everything passes', (t) => {
  const root = fixtureRoot(t, [audit({ reviewBy: '2026-10-01' })]);
  const expired = run(['exceptions', '--root', root, '--today', TODAY]);
  assert.equal(expired.status, 1);
  assert.match(expired.stderr, /\[security\] exceptions: failed/);
  assert.match(expired.stderr, /expired: the review deadline 2026-10-01 has passed/);

  const report = path.join(root, 'audit.json');
  fs.writeFileSync(report, JSON.stringify(auditReport([advisory()])));
  assert.equal(run(['pnpm-audit', '--root', root, '--today', TODAY, '--report', report]).status, 1);
  assert.equal(run(['pnpm-audit', '--root', root, '--today', '2026-09-30', '--report', report]).status, 0);
  const missing = run(['trivy', '--root', root, '--today', '2026-09-30', '--report', path.join(root, 'none.json')]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /trivy: not-completed/);
});

test('the repository exceptions file is complete (deadlines aside, which the nightly scan enforces)', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(repo, 'security/exceptions.json'), 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const { problems } = validateExceptions(doc, new Date().toISOString().slice(0, 10), { ignored: auditIgnores(pkg) });
  assert.deepEqual(problems.filter((p) => !/expired|days ahead/.test(p)), []);
});
