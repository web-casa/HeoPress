/**
 * The security gate of a public release (P07 task 8.1, ADR-0017 §5): a release needs a passing security scan of the
 * exact tree it publishes. scripts/public-release.mjs runs it in `prepare` and again in `push`.
 *
 * 1. Locally, on the export of the released commit: `security/exceptions.json` is complete and none has expired
 *    today, and `pnpm audit` of its lockfile (scripts/security-scanners.mjs: no project audit ignores, the public
 *    registry) has no high or critical advisory that a valid exception does not cover. The export itself has already
 *    run gitleaks with the trusted configuration (scripts/public-export.mjs).
 * 2. In the public repository: the mirror commit of that tree — what `node scripts/ci-mirror.mjs push` makes of the
 *    commit: a fixed identity, date and message, so it is computed here from the tree and binds it — has a
 *    successful run of `.github/workflows/security.yml` (pnpm audit, gitleaks and Trivy over the images) that started
 *    at most `maxAgeDays` ago. The run must be of the released workflow file (its path, and the blob GitHub holds
 *    for it at the mirror commit, equal the exported `.github/workflows/security.yml`), and every scan job this gate
 *    requires (`REQUIRED_JOBS`, defined here in the maintainer's checkout, not in the released tree) must have
 *    completed successfully. Read with `gh api` (GET only); no write to any repository.
 * 3. What the gate trusts in the released tree (the workflow, scanners, checker and exceptions) is reviewed by the
 *    maintainer at release time: scripts/release-trust-review.mjs.
 *
 * Anything that cannot be established (gh missing or not signed in, the audit service unreachable, no run yet, a run
 * still in progress) stops the release: an unavailable scan is not a passed one.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { auditIgnores, checkPnpmAudit, validateExceptions } from './check-security-scan.mjs';
import { buildMirrorCommit } from './ci-mirror.mjs';
import { runAudit } from './security-scanners.mjs';

export const SECURITY_WORKFLOW = '.github/workflows/security.yml';
export const MAX_SCAN_AGE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLIC_REPO = process.env.HEOPRESS_PUBLIC_REPO ?? 'web-casa/HeoPress';

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

/** `pnpm audit` of the tree's lockfile (the workflow's trusted invocation); the parsed report, or undefined. */
export function auditTree(treeDir) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-release-audit-'));
  try {
    const report = path.join(work, 'pnpm-audit.json');
    runAudit({ dir: treeDir, report });
    return readJson(report);
  } catch {
    return undefined;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** Problems of the local part: the exceptions on `today` and the audit report `audit(treeDir)` returns. */
export function localScanProblems({ treeDir, today, audit = auditTree }) {
  const doc = readJson(path.join(treeDir, 'security/exceptions.json'));
  const pkg = readJson(path.join(treeDir, 'package.json'));
  if (doc === undefined) return ['security/exceptions.json is missing from the release tree or not JSON'];
  if (pkg === undefined) return ['package.json is missing from the release tree or not JSON'];
  let ignored;
  try {
    const ws = path.join(treeDir, 'pnpm-workspace.yaml');
    ignored = auditIgnores(pkg, fs.existsSync(ws) ? fs.readFileSync(ws, 'utf8') : '');
  } catch (err) {
    return [`the audit ignores cannot be read: ${err.message}`];
  }
  const { problems, active } = validateExceptions(doc, today, { ignored });
  // The audit runs without the project's ignores (scripts/security-scanners.mjs): every counted advisory is listed.
  const result = checkPnpmAudit(audit(treeDir), active, { ignored: [] });
  if (result.status !== 'passed') problems.push(`pnpm audit ${result.status}:\n    ${result.problems.join('\n    ')}`);
  return problems;
}

/** The latest attempt of the security workflow's run on `mirrorSha` (a mirror push or a manual run), or null. */
export function pickSecurityRun(runs, mirrorSha) {
  const own = (Array.isArray(runs) ? runs : []).filter(
    (r) => r.head_sha === mirrorSha && r.path === SECURITY_WORKFLOW && ['push', 'workflow_dispatch'].includes(r.event),
  );
  own.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt);
  return own[0] ?? null;
}

/** Problems with the evidence: a completed, successful run that started at most `maxAgeDays` before `now`. */
export function evidenceProblems(run, { mirrorSha, now, maxAgeDays = MAX_SCAN_AGE_DAYS }) {
  const which = `${SECURITY_WORKFLOW} on the mirror commit ${mirrorSha.slice(0, 12)}`;
  if (!run) return [`no run of ${which}: run \`node scripts/ci-mirror.mjs push\` for the released commit and wait for its scans`];
  if (run.status !== 'completed') return [`the run of ${which} is ${run.status}: wait for it (${run.html_url})`];
  if (run.conclusion !== 'success') return [`the run of ${which} concluded ${run.conclusion}: fix or except its findings (${run.html_url})`];
  const started = Date.parse(run.run_started_at ?? run.created_at ?? '');
  if (!Number.isFinite(started) || now - started > maxAgeDays * DAY_MS) {
    return [`the run of ${which} is older than ${maxAgeDays} days: run the workflow again on that commit (${run.html_url})`];
  }
  return [];
}

/** The mirror commit of a release tree, built as `ci-mirror.mjs push` builds it (deterministic), in a scratch repository. */
export function mirrorCommitOf({ treeDir, entries, sha }) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-release-mirror-'));
  try {
    const gitDir = path.join(work, 'mirror.git');
    execFileSync('git', ['init', '--quiet', '--bare', gitDir]);
    return buildMirrorCommit({ gitDir, out: treeDir, entries, sha });
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/** `gh api <path>` (a GET: reading only), parsed. */
function ghGet(apiPath, jq) {
  return JSON.parse(execFileSync('gh', ['api', apiPath, '-q', jq], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

/** `gh api <path> -q <jq>` (a GET) as text. */
function ghText(apiPath, jq) {
  return execFileSync('gh', ['api', apiPath, '-q', jq], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

/**
 * The jobs a security run must have completed successfully, whatever the released workflow says: a workflow that
 * dropped a scan (or the image matrix) produces a successful run without them, and the gate — run from the
 * maintainer's checkout, not from the released tree — refuses it.
 */
export const REQUIRED_JOBS = [
  /^Exceptions are complete/,
  /^pnpm audit/,
  /^gitleaks/,
  /^Trivy \(cms image/,
  /^Trivy \(site-classic image/,
  /^Trivy \(postgres image/,
  /^Security scan result/,
];

/** Problems with the jobs of the run: every required job present, completed and successful. */
export function jobProblems(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const problems = [];
  for (const re of REQUIRED_JOBS) {
    const job = list.find((j) => re.test(String(j?.name ?? '')));
    if (!job) problems.push(`the security run has no job matching ${re}: the released workflow does not run every scan`);
    else if (job.status !== 'completed' || job.conclusion !== 'success') problems.push(`the job "${job.name}" of the security run is ${job.status}/${job.conclusion}`);
  }
  return problems;
}

/**
 * The gate: throws when the release tree has no passing security scan; returns the evidence otherwise. `audit`,
 * `runsFor` (the workflow runs of a commit SHA) and `now` are replaceable for tests.
 */
export function releaseSecurityGate({
  sha,
  treeDir,
  entries,
  now = Date.now(),
  maxAgeDays = MAX_SCAN_AGE_DAYS,
  audit = auditTree,
  runsFor = (mirrorSha) => ghGet(`repos/${PUBLIC_REPO}/actions/runs?head_sha=${mirrorSha}&per_page=100`, '.workflow_runs'),
  workflowBlobAt = (mirrorSha) => ghText(`repos/${PUBLIC_REPO}/contents/${SECURITY_WORKFLOW}?ref=${mirrorSha}`, '.sha'),
  jobsOf = (runId) => ghGet(`repos/${PUBLIC_REPO}/actions/runs/${runId}/jobs?per_page=100`, '.jobs'),
}) {
  const today = new Date(now).toISOString().slice(0, 10);
  const problems = localScanProblems({ treeDir, today, audit });
  const { tree, commit: mirrorSha } = mirrorCommitOf({ treeDir, entries, sha });
  let run = null;
  try {
    run = pickSecurityRun(runsFor(mirrorSha), mirrorSha);
    const evidence = evidenceProblems(run, { mirrorSha, now, maxAgeDays });
    problems.push(...evidence);
    if (evidence.length === 0) {
      // The run is of the workflow file of the released tree: the blob GitHub holds at the mirror commit for the
      // run's path is the one exported (a run of another workflow, or of another version of it, does not count).
      const released = entries.find((e) => e.file === SECURITY_WORKFLOW)?.object;
      const ran = workflowBlobAt(mirrorSha);
      if (!released) problems.push(`${SECURITY_WORKFLOW} is not in the release tree`);
      else if (run.path !== SECURITY_WORKFLOW || ran !== released) {
        problems.push(`the security run's workflow (${run.path}, blob ${String(ran).slice(0, 12)}) is not the released ${SECURITY_WORKFLOW} (blob ${released.slice(0, 12)})`);
      }
      problems.push(...jobProblems(jobsOf(run.id)));
    }
  } catch (err) {
    problems.push(`the security workflow runs of ${PUBLIC_REPO} could not be read (gh): ${err.message.split('\n')[0]}`);
  }
  if (problems.length) throw new Error(`the security gate is not passed (P07 8.1; docs/dev/security-scanning.md):\n  ${problems.join('\n  ')}`);
  return { mirrorSha, tree, run: { id: run.id, url: run.html_url, startedAt: run.run_started_at ?? run.created_at }, checkedAt: new Date(now).toISOString() };
}
