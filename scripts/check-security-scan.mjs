#!/usr/bin/env node
/**
 * Security scan results and their exceptions (P07 task 8.1, ADR-0017 §5).
 *
 * The nightly and pre-release workflow (.github/workflows/security.yml) runs `pnpm audit`, gitleaks and Trivy;
 * this script decides each result from the scanner's JSON report and `security/exceptions.json`:
 *
 * - **passed**: the report is complete and every high or critical finding (any gitleaks finding) is covered by
 *   an exception that is valid today;
 * - **failed**: a finding no valid exception covers, or an exception that is incomplete or expired (an expired
 *   exception fails every check, also when nothing matches it any more);
 * - **not completed**: the report is missing or is not a complete scanner report (the scanner or the service
 *   behind it — the npm audit endpoint, the Trivy vulnerability database — was unavailable). Never a pass.
 *
 * An exception names the scanner, the advisory or finding `id`, its `owner`, the `reason` and the review
 * deadline `reviewBy` (YYYY-MM-DD, at most 180 days ahead; the day after it the exception has expired). A
 * vulnerability exception (pnpm-audit, trivy) also names the `package` and the exact installed `versions` it
 * covers, and a trivy exception the `images` it covers (it covers no other image). A finding with a published fix
 * (Trivy FixedVersion, npm patched versions) is to be fixed: an exception covers it only with `fixBlockedBy` (why
 * the fix cannot be taken yet) and a review within 30 days. A gitleaks exception names the `path` and its id is the
 * review id of the finding (SHA-256 of path,
 * rule and the exact line, as in the public export), so any change to the line makes it a new finding. An
 * advisory pnpm itself ignores (`pnpm.auditConfig.ignoreGhsas` or `ignoreCves`) needs a valid pnpm-audit exception
 * too; the workflow's audit (scripts/security-scanners.mjs) drops those ignores, so such an advisory is reported and
 * judged against the exceptions like any other.
 *
 * The scanners run through scripts/security-scanners.mjs, with configuration from outside the scanned tree.
 *
 * Usage:
 *   node scripts/check-security-scan.mjs exceptions
 *   node scripts/check-security-scan.mjs pnpm-audit --report <pnpm audit --json output> [--ignores-dropped]
 *   node scripts/check-security-scan.mjs trivy --report <trivy --format json output> [--image <cms|site-classic|postgres>]
 *   node scripts/check-security-scan.mjs gitleaks --report <gitleaks json report> --scan-root <scanned dir>
 *   options: --root <repo> --exceptions <file> --today <YYYY-MM-DD>
 * Exit status: 0 passed, 1 failed, 2 not completed. With GITHUB_OUTPUT set, `status=<passed|failed|not-completed>`
 * is written to it; with GITHUB_STEP_SUMMARY set, the result is appended to the job summary.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { allAuditIgnores } from './pnpm-audit-config.mjs';
import { findingHash } from './public-export.mjs';

export const SCANNERS = ['pnpm-audit', 'trivy', 'gitleaks'];
const VULNERABILITY_SCANNERS = new Set(['pnpm-audit', 'trivy']);
export const MAX_REVIEW_DAYS = 180;
/** A finding with a published fix may be excepted only with fixBlockedBy, and for this long at most. */
export const MAX_FIX_BLOCKED_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A YYYY-MM-DD calendar date as UTC milliseconds, or null. */
function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value ? null : ms;
}

const filled = (v) => typeof v === 'string' && v.trim() !== '';

/**
 * Validate the exceptions document on `today` (YYYY-MM-DD). Returns the problems and the exceptions valid
 * today (complete and not expired); `ignored` are the advisories (GHSA or CVE) pnpm ignores by configuration.
 */
export function validateExceptions(doc, today, { ignored = [] } = {}) {
  const problems = [];
  const active = [];
  const todayMs = parseDate(today);
  if (todayMs === null) throw new Error(`invalid date for today: ${today}`);
  const list = doc?.exceptions;
  if (!Array.isArray(list)) return { problems: ['security exceptions: "exceptions" must be a list'], active };
  const seen = new Set();
  for (const [i, e] of list.entries()) {
    const label = `exceptions[${i}] (${e?.scanner ?? '?'} ${e?.id ?? '?'}${e?.package ? ` ${e.package}` : ''})`;
    const own = [];
    if (!SCANNERS.includes(e?.scanner)) own.push(`scanner must be one of ${SCANNERS.join(', ')}`);
    for (const field of ['id', 'owner', 'reason']) if (!filled(e?.[field])) own.push(`${field} is missing`);
    const vulnerability = VULNERABILITY_SCANNERS.has(e?.scanner);
    if (vulnerability) {
      if (!filled(e?.package)) own.push('package is missing');
      if (!Array.isArray(e?.versions) || e.versions.length === 0 || !e.versions.every(filled)) {
        own.push('versions must list the exact installed versions the exception covers');
      }
    }
    if (e?.scanner === 'gitleaks' && !filled(e?.path)) own.push('path is missing');
    // A Trivy exception covers the images it names only: a reason given for one image says nothing about another.
    if (e?.scanner === 'trivy' && (!Array.isArray(e?.images) || e.images.length === 0 || !e.images.every(filled))) {
      own.push('images must list the images the exception covers (cms, site-classic, postgres)');
    }
    // A finding with a fix is fixed, not excepted — unless the fix cannot be taken yet, said in fixBlockedBy, for a
    // short while.
    const fixBlocked = e?.fixBlockedBy !== undefined;
    if (fixBlocked && !filled(e.fixBlockedBy)) own.push('fixBlockedBy must say why the published fix cannot be taken yet');
    // A vulnerability exception always has a review deadline; a reviewed gitleaks finding is bound to the exact
    // line, so its deadline is optional (and enforced when given).
    let expired = false;
    if (vulnerability || e?.reviewBy !== undefined) {
      const deadline = parseDate(e?.reviewBy);
      if (deadline === null) own.push('reviewBy must be a date (YYYY-MM-DD)');
      else if (deadline < todayMs) {
        expired = true;
        own.push(`expired: the review deadline ${e.reviewBy} has passed — review it, then renew or remove the exception`);
      } else if (deadline - todayMs > MAX_REVIEW_DAYS * DAY_MS) {
        own.push(`reviewBy ${e.reviewBy} is more than ${MAX_REVIEW_DAYS} days ahead`);
      } else if (fixBlocked && deadline - todayMs > MAX_FIX_BLOCKED_DAYS * DAY_MS) {
        own.push(`reviewBy ${e.reviewBy} is more than ${MAX_FIX_BLOCKED_DAYS} days ahead (a fix exists: fixBlockedBy allows a short wait only)`);
      }
    }
    // The same advisory and package may be excepted twice for different installed versions (two images built on
    // different base images, each with its own reason); a version covered twice is a duplicate.
    const versions = Array.isArray(e?.versions) && e.versions.length ? e.versions : [''];
    const images = e?.scanner === 'trivy' && Array.isArray(e?.images) && e.images.length ? e.images : [''];
    const keys = versions.flatMap((v) => images.map((im) => `${e?.scanner}\u0000${e?.id}\u0000${e?.package ?? ''}\u0000${v}\u0000${im}`));
    if (keys.some((k) => seen.has(k))) own.push('duplicate of an earlier exception (same scanner, id, package, version and image)');
    for (const k of keys) seen.add(k);
    for (const p of own) problems.push(`${label}: ${p}`);
    if (own.length === 0 && !expired) active.push(e);
  }
  for (const id of ignored) {
    if (!active.some((e) => e.scanner === 'pnpm-audit' && e.id === id)) {
      problems.push(`pnpm ignores ${id} (pnpm.auditConfig) without a valid pnpm-audit exception in security/exceptions.json`);
    }
  }
  return { problems, active };
}

/**
 * How a finding stands against the exceptions: `covered`, `fixable` (an exception matches, but the finding has a
 * published fix and the exception gives no fixBlockedBy) or `open`. A Trivy exception matches its images only.
 */
function cover(active, { scanner, ids, pkg, version, image, fixable }) {
  const matching = active.filter(
    (e) => e.scanner === scanner && ids.includes(e.id) && e.package === pkg && e.versions.includes(version) && (scanner !== 'trivy' || e.images.includes(image)),
  );
  if (matching.length === 0) return 'open';
  if (fixable && !matching.some((e) => filled(e.fixBlockedBy))) return 'fixable';
  return 'covered';
}

const FIXABLE_NOTE = 'a fix is published: take it (an exception for a fixable finding needs fixBlockedBy and a review within 30 days)';

const SEVERE = new Set(['high', 'critical']);

/**
 * The advisories pnpm ignores by configuration: `ignoreGhsas` and `ignoreCves` of package.json `pnpm.auditConfig`
 * (pnpm 9) and of pnpm-workspace.yaml `auditConfig` (pnpm 10+), keys quoted or not.
 */
export function auditIgnores(pkg, workspaceText = '') {
  return allAuditIgnores(pkg, workspaceText);
}

/**
 * Result of a `pnpm audit --json` report: { status, problems, excepted }. Pass and fail come from the advisories and
 * the exceptions. The counts must agree with the list: pnpm counts each advisory once, and leaves an advisory it
 * ignores by configuration (`ignored`) out of the list but in the counts — so more high and critical advisories
 * counted than listed plus ignored is an incomplete report, whatever is ignored. (The scans themselves audit with
 * the ignores removed and pass `ignored: []`, the strictest form.)
 */
export function checkPnpmAudit(report, active, { ignored = [] } = {}) {
  const incomplete = (why) => ({ status: 'not-completed', problems: [`pnpm audit did not complete: ${why}`], excepted: [] });
  if (!report || typeof report !== 'object' || Array.isArray(report)) return incomplete('no JSON report');
  if (report.error) return incomplete(`the audit reported an error (${report.error.code ?? report.error.summary ?? 'unknown'})`);
  const counts = report.metadata?.vulnerabilities;
  if (!report.advisories || typeof report.advisories !== 'object' || Array.isArray(report.advisories) || !counts || typeof counts !== 'object') {
    return incomplete('the report has no advisories or vulnerability counts');
  }
  if (!(Number(report.metadata.totalDependencies ?? report.metadata.dependencies) > 0)) return incomplete('the report audited no dependency');
  const advisories = Object.values(report.advisories);
  const severe = advisories.filter((a) => SEVERE.has(String(a?.severity).toLowerCase()));
  const counted = (Number(counts.high) || 0) + (Number(counts.critical) || 0);
  if (counted > severe.length + ignored.length) {
    return incomplete(`the counts name ${counted} high or critical advisories; the report lists ${severe.length} and ${ignored.length} are ignored by configuration`);
  }
  const problems = [];
  const excepted = [];
  for (const a of severe) {
    const ids = [a.github_advisory_id, ...(a.cves ?? [])].filter(filled);
    const versions = [...new Set((a.findings ?? []).map((f) => f.version))];
    if (ids.length === 0 || versions.length === 0) return incomplete(`advisory ${a.id ?? '?'} has no identifier or no installed version`);
    for (const version of versions) {
      const label = `${ids[0]} ${a.module_name}@${version} (${a.severity}): ${a.title ?? ''}`.trim();
      // npm's "<0.0.0" means no patched version.
      const fixable = filled(a.patched_versions) && a.patched_versions.trim() !== '<0.0.0';
      const state = cover(active, { scanner: 'pnpm-audit', ids, pkg: a.module_name, version, fixable });
      if (state === 'covered') excepted.push(label);
      else if (state === 'fixable') problems.push(`${label} — ${FIXABLE_NOTE}`);
      else problems.push(label);
    }
  }
  return { status: problems.length ? 'failed' : 'passed', problems, excepted };
}

/** The image a Trivy report is about: `heopress-<image>:<tag>` gives `<image>`. */
export function imageOf(artifactName) {
  return String(artifactName ?? '').replace(/:[^/:]*$/, '').replace(/^.*\//, '').replace(/^heopress-/, '');
}

/**
 * Result of a Trivy JSON report (`trivy image --format json`): { status, problems, excepted }. An exception covers
 * the images it lists only (`image`: by default from the report's artifact name); a finding with a FixedVersion is
 * covered only by an exception with fixBlockedBy.
 */
export function checkTrivy(report, active, { image } = {}) {
  const incomplete = (why) => ({ status: 'not-completed', problems: [`Trivy did not complete: ${why}`], excepted: [] });
  if (!report || typeof report !== 'object' || Array.isArray(report)) return incomplete('no JSON report');
  if (typeof report.SchemaVersion !== 'number' || !filled(report.ArtifactName)) return incomplete('not a Trivy report (no schema version or artifact)');
  // An image always has packages: a report without results scanned nothing.
  if (!Array.isArray(report.Results) || report.Results.length === 0) return incomplete(`no scan results for ${report.ArtifactName}`);
  if (!report.Results.every((r) => filled(r?.Target) && filled(r?.Class))) return incomplete('a result has no target or class');
  // The images are Debian based: a scan that found no operating-system packages did not look at the image.
  if (!report.Results.some((r) => r.Class === 'os-pkgs')) return incomplete(`no operating-system packages scanned in ${report.ArtifactName}`);
  // The image is the report's own artifact; a caller naming another image would let that image's exceptions apply.
  const artifactImage = imageOf(report.ArtifactName);
  if (image !== undefined && image !== artifactImage) {
    return { status: 'failed', problems: [`the report is of ${report.ArtifactName} (image ${artifactImage}), not of the image ${image} it is checked as`], excepted: [] };
  }
  const problems = [];
  const excepted = [];
  for (const result of report.Results) {
    for (const v of result?.Vulnerabilities ?? []) {
      if (!SEVERE.has(String(v?.Severity).toLowerCase())) continue;
      const label = `${v.VulnerabilityID} ${v.PkgName}@${v.InstalledVersion} (${String(v.Severity).toLowerCase()}) in ${report.ArtifactName}: ${result.Target}${v.PkgPath ? ` (${v.PkgPath})` : ''}${v.FixedVersion ? `, fixed in ${v.FixedVersion}` : ''}`;
      const state = cover(active, {
        scanner: 'trivy',
        ids: [v.VulnerabilityID],
        pkg: v.PkgName,
        version: v.InstalledVersion,
        image: artifactImage,
        fixable: filled(v.FixedVersion),
      });
      if (state === 'covered') excepted.push(label);
      else if (state === 'fixable') problems.push(`${label} — ${FIXABLE_NOTE}`);
      else problems.push(label);
    }
  }
  return { status: problems.length ? 'failed' : 'passed', problems, excepted };
}

/**
 * Result of a gitleaks JSON report (run with `--redact`): `readLine(file, n)` returns line n of a scanned file.
 * Only the place, the rule and the review id are reported, never the matched text.
 */
export function checkGitleaks(findings, active, readLine) {
  if (!Array.isArray(findings)) return { status: 'not-completed', problems: ['gitleaks did not complete: no JSON report'], excepted: [] };
  const problems = [];
  const excepted = [];
  for (const f of findings) {
    const file = String(f?.File ?? '').replace(/^\.\//, '');
    if (!file || !filled(f?.RuleID) || !Number.isInteger(f?.StartLine)) {
      return { status: 'not-completed', problems: ['gitleaks did not complete: a finding has no file, rule or line'], excepted: [] };
    }
    const id = findingHash(file, f.RuleID, readLine(file, f.StartLine));
    const label = `${file}:${f.StartLine} ${f.RuleID} (review id ${id})`;
    if (active.some((e) => e.scanner === 'gitleaks' && e.id === id)) excepted.push(label);
    else problems.push(label);
  }
  return { status: problems.length ? 'failed' : 'passed', problems, excepted };
}

const EXIT = { passed: 0, failed: 1, 'not-completed': 2 };

function readReport(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const command = argv[0];
  const root = path.resolve(arg('--root') ?? process.cwd());
  const today = arg('--today') ?? new Date().toISOString().slice(0, 10);
  const exceptionsFile = path.resolve(root, arg('--exceptions') ?? 'security/exceptions.json');
  if (![...SCANNERS, 'exceptions'].includes(command)) {
    console.error('usage: check-security-scan.mjs <exceptions|pnpm-audit|trivy|gitleaks> [--report <file>] [--scan-root <dir>] [--root <repo>] [--exceptions <file>] [--today YYYY-MM-DD]');
    process.exit(2);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const wsFile = path.join(root, 'pnpm-workspace.yaml');
  let ignored = [];
  const configProblems = [];
  try {
    ignored = auditIgnores(pkg, fs.existsSync(wsFile) ? fs.readFileSync(wsFile, 'utf8') : '');
  } catch (err) {
    configProblems.push(`the audit ignores cannot be read: ${err.message}`);
  }
  const doc = readReport(exceptionsFile);
  const validated = doc === undefined
    ? { problems: [`${path.relative(root, exceptionsFile)} is missing or not JSON`], active: [] }
    : validateExceptions(doc, today, { ignored });
  const exceptionProblems = [...configProblems, ...validated.problems];
  const { active } = validated;

  let result = { status: 'passed', problems: [], excepted: [] };
  if (command !== 'exceptions') {
    const reportFile = arg('--report');
    const report = reportFile ? readReport(path.resolve(reportFile)) : undefined;
    // --ignores-dropped: the report comes from scripts/security-scanners.mjs, which audits without the project's
    // ignores, so every counted advisory must be listed.
    if (command === 'pnpm-audit') result = checkPnpmAudit(report, active, { ignored: argv.includes('--ignores-dropped') ? [] : ignored });
    else if (command === 'trivy') result = checkTrivy(report, active, { image: arg('--image') });
    else {
      const scanRoot = path.resolve(arg('--scan-root') ?? root);
      const readLine = (file, n) => {
        const abs = path.resolve(scanRoot, file);
        if (abs !== scanRoot && !abs.startsWith(`${scanRoot}${path.sep}`)) return '';
        return fs.existsSync(abs) ? (fs.readFileSync(abs, 'utf8').split('\n')[n - 1] ?? '') : '';
      };
      result = checkGitleaks(report, active, readLine);
    }
  }
  const status = result.status === 'not-completed' ? 'not-completed' : exceptionProblems.length || result.status === 'failed' ? 'failed' : 'passed';
  const lines = [...exceptionProblems, ...result.problems];
  const title = `[security] ${command}: ${status} (${today})`;
  (status === 'passed' ? console.log : console.error)(title);
  for (const p of lines) console.error(`  ✖ ${p}`);
  for (const p of result.excepted) console.log(`  · excepted: ${p}`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `status=${status}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [`### ${command}: ${status}`, '', ...lines.map((p) => `- ✖ ${p}`), ...result.excepted.map((p) => `- excepted: ${p}`), ''];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md.join('\n')}\n`);
  }
  process.exit(EXIT[status]);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
