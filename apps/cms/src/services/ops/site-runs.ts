import type { Database } from '@heopress/database';
import type { ScheduledJobResult } from '@heopress/runtime/node';
import { AuditLogger } from '../../modules/audit/logger';

/**
 * Per-site runs of the P07 workers (site audit, link scan, reachability check) as one scheduled result (HeoPress P07a
 * task 11.1): each site that reached a final state leaves one site run event in its own audit log (`done`, `failed`,
 * `lost` as interrupted; `partial` — work left for the next slot — leaves none); the run as a whole is failed when any
 * site failed or was interrupted, else incomplete when any has work left, else succeeded.
 */
export interface SiteRun {
  siteId: string;
  status: 'done' | 'partial' | 'failed' | 'lost';
  error?: string;
}

export function resultOfSiteRuns(runs: readonly SiteRun[]): ScheduledJobResult {
  const sites: Record<string, number> = {};
  for (const r of runs) sites[r.status] = (sites[r.status] ?? 0) + 1;
  const failed = (sites.failed ?? 0) + (sites.lost ?? 0);
  if (failed > 0) {
    return { status: 'failed', reason: `${sites.failed ?? 0} site(s) failed, ${sites.lost ?? 0} interrupted`, sites };
  }
  if ((sites.partial ?? 0) > 0) return { status: 'incomplete', reason: `${sites.partial} site(s) to continue`, sites };
  return { status: 'succeeded', sites };
}

const SITE_STATUS: Record<Exclude<SiteRun['status'], 'partial'>, 'succeeded' | 'failed' | 'interrupted'> = { done: 'succeeded', failed: 'failed', lost: 'interrupted' };

/** Write the site run events, then answer the scheduled result. */
export async function reportSiteRuns(db: Database, job: string, runs: readonly SiteRun[]): Promise<ScheduledJobResult> {
  for (const run of runs) {
    if (run.status === 'partial') continue;
    await new AuditLogger({ db, siteId: run.siteId }).write({
      event: 'site_job_run',
      metadata: { job, status: SITE_STATUS[run.status], ...(run.error ? { error: run.error.slice(0, 500) } : {}) },
    });
  }
  return resultOfSiteRuns(runs);
}
