import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, sites, systemEvents, type Database } from '@heopress/database';
import { runScheduledSlot } from '@heopress/runtime/node';
import { reportSiteRuns } from '../services/ops/site-runs';
import { scheduledJobReporter } from '../services/ops/system-events';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/** Run events (HeoPress P07a task 11.1): one site event per site and final state; one system event per run. */

const SITES = ['site_runs_a', 'site_runs_b', 'site_runs_c'];

describe.skipIf(!hasDbIntegrationUrl)('site run events', () => {
  let db: Database;
  let sqlConn: Parameters<typeof runScheduledSlot>[3]['sql'];
  const DAY = Math.floor(Date.now() / 86_400_000) * 86_400_000 - 86_400_000;
  let slot = 0;
  const nextSlot = () => new Date(DAY + 3 * 3_600_000 + (slot += 1) * 1000);

  beforeAll(async () => {
    db = await connectDbIntegration('site-runs');
    sqlConn = (db as unknown as { $client: typeof sqlConn }).$client;
  });
  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, SITES));
    await db.insert(sites).values(SITES.map((id) => ({ id, name: id })));
  });
  afterAll(async () => {
    if (db) await db.delete(sites).where(inArray(sites.id, SITES));
  });

  const siteEvents = (siteId: string) =>
    runSiteTransaction(db, siteId, (tx) => tx.select({ metadata: auditLog.metadata }).from(auditLog).where(and(eq(auditLog.siteId, siteId), eq(auditLog.event, 'site_job_run'))));
  const jobEvents = (job: string) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.platform_reader', 'on', true)`);
      return tx.select().from(systemEvents).where(sql`${systemEvents.data}->>'job' = ${job}`);
    });

  it('two audits of a site leave two site events; partial none; lost recorded as interrupted', async () => {
    await reportSiteRuns(db, 'site-audit', [{ siteId: SITES[0]!, status: 'done' }]);
    await reportSiteRuns(db, 'site-audit', [{ siteId: SITES[0]!, status: 'done' }, { siteId: SITES[1]!, status: 'partial' }, { siteId: SITES[2]!, status: 'lost' }]);
    await new Promise((r) => setTimeout(r, 300));
    expect(await siteEvents(SITES[0]!)).toHaveLength(2);
    expect(await siteEvents(SITES[1]!)).toHaveLength(0);
    expect((await siteEvents(SITES[2]!))[0]!.metadata).toMatchObject({ job: 'site-audit', status: 'interrupted' });
  });

  it('a run over three sites: one event per site, one system event for the run', async () => {
    const job = `test-sweep-${Date.now()}`;
    const outcome = await runScheduledSlot(
      job,
      nextSlot(),
      async () => reportSiteRuns(db, job, [{ siteId: SITES[0]!, status: 'done' }, { siteId: SITES[1]!, status: 'done' }, { siteId: SITES[2]!, status: 'failed', error: 'boom' }]),
      { sql: sqlConn, report: scheduledJobReporter(db) },
    );
    expect(outcome).toBe('failed');
    await new Promise((r) => setTimeout(r, 300));
    for (const id of SITES) expect((await siteEvents(id)).filter((e) => (e.metadata as { job?: string }).job === job)).toHaveLength(1);
    const events = await jobEvents(job);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: 'error', source: 'scheduler', event: 'scheduled_job_failed' });
    expect(events[0]!.data).toMatchObject({ sites: { done: 2, failed: 1 } });
  });
});
