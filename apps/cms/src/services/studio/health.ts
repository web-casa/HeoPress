/**
 * Site health (HeoPress P07a task 3.2; spec studio/network-summary "健康状态"): a status and the reasons for it — never
 * a score. The most serious rule that applies wins:
 *   - bad:     the last reachability check found an error; a domain not switched off is recorded `failed`, or still
 *              pending 24 hours after it was added;
 *   - warn:    the last reachability check found a warning; open error-level audit issues; the last audit run failed;
 *              active domains but none primary;
 *   - unknown: no reachability check and no audit run yet, or their results are not readable by the caller;
 *   - ok:      none of these.
 */
type HealthStatus = 'ok' | 'warn' | 'bad' | 'unknown';

interface HealthReason {
  code:
    | 'reachability_errors'
    | 'reachability_warnings'
    | 'domain_failed'
    | 'domain_pending'
    | 'audit_errors'
    | 'audit_failed'
    | 'no_primary_domain'
    | 'not_checked'
    | 'not_readable';
  count?: number;
  host?: string;
  detail?: string | null;
}

export interface Health {
  status: HealthStatus;
  /** At most three, most serious first. */
  reasons: HealthReason[];
}

export interface HealthInput {
  /** The last reachability report's counts; `null` none yet; `'unreadable'` not readable by the caller. */
  reachability: { errors: number; warnings: number } | null | 'unreadable';
  /** The last audit run and the open error issues the caller may see; `null` never run. */
  audit: { lastRunStatus: string | null; errorIssues: number } | null | 'unreadable';
  domains: ReadonlyArray<{ hostname: string; status: string; statusReason: string | null; createdAt: Date }>;
  primaryDomainState: 'set' | 'unset' | 'none';
  now: Date;
}

const DAY_MS = 86_400_000;

export function computeHealth(input: HealthInput): Health {
  const bad: HealthReason[] = [];
  const warn: HealthReason[] = [];
  const { reachability, audit } = input;

  if (reachability && reachability !== 'unreadable') {
    if (reachability.errors > 0) bad.push({ code: 'reachability_errors', count: reachability.errors });
    else if (reachability.warnings > 0) warn.push({ code: 'reachability_warnings', count: reachability.warnings });
  }
  for (const d of input.domains) {
    if (d.status === 'disabled') continue;
    if (d.status === 'failed') bad.push({ code: 'domain_failed', host: d.hostname, detail: d.statusReason });
    else if (d.status === 'pending' && input.now.getTime() - d.createdAt.getTime() > DAY_MS) bad.push({ code: 'domain_pending', host: d.hostname });
  }
  if (audit && audit !== 'unreadable') {
    if (audit.errorIssues > 0) warn.push({ code: 'audit_errors', count: audit.errorIssues });
    if (audit.lastRunStatus === 'failed') warn.push({ code: 'audit_failed' });
  }
  if (input.primaryDomainState === 'unset') warn.push({ code: 'no_primary_domain' });

  if (bad.length) return { status: 'bad', reasons: [...bad, ...warn].slice(0, 3) };
  if (warn.length) return { status: 'warn', reasons: warn.slice(0, 3) };
  if (reachability === 'unreadable' || audit === 'unreadable') return { status: 'unknown', reasons: [{ code: 'not_readable' }] };
  if (!reachability && !audit) return { status: 'unknown', reasons: [{ code: 'not_checked' }] };
  return { status: 'ok', reasons: [] };
}
