import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, scopedDatabase, systemState, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import { setAuditLogQueue } from '../modules/audit/worker';
import { setApprovalMode } from '../services/flow-drafts/flow-draft-service';
import { setRuntimeFactory } from '../middleware/runtime';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * HeoPress P10: changing the instance approval mode (ADR-0012; used by batch plans and flow drafts) writes its
 * audit row in the same transaction as the change.
 *
 * Regression: the row used to go through the async audit queue. The Studio batch-plan E2E switches the mode back
 * in its last request; that queued job outlived the server and was replayed after the next run had reset the
 * database, so the worker logged `batch insert failed for audit_log` (foreign key on `site_id`). Now nothing is
 * queued, the row exists when the call returns, and an unchanged mode writes nothing.
 */

const JWT_SECRET = 'p10-approval-mode-secret';

describe.skipIf(!hasDbIntegrationUrl)('P10 approval mode — DB integration', () => {
  let db: Database; // the application role: the code under test
  let fixtures: Database; // the owner: test data and stored-row checks
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let original: 'solo' | 'team' = 'solo';
  let created = false;

  beforeAll(async () => {
    db = await connectDbIntegration('p10-approval-mode');
    fixtures = await connectDbFixtures('p10-approval-mode');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  afterAll(() => setRuntimeFactory(null));
  beforeEach(async () => {
    fx = await createCrossSiteFixture(fixtures, { prefix: 'p10am', jwtSecret: JWT_SECRET });
    created = (await fixtures.insert(systemState).values({ id: 'singleton', adminPath: '/p10am-admin' }).onConflictDoNothing().returning({ id: systemState.id })).length > 0;
    const [row] = await fixtures.select({ mode: systemState.approvalMode }).from(systemState).where(eq(systemState.id, 'singleton'));
    original = (row?.mode as 'solo' | 'team' | undefined) ?? 'solo';
  });
  afterEach(async () => {
    if (created) await fixtures.delete(systemState).where(eq(systemState.id, 'singleton'));
    else await fixtures.update(systemState).set({ approvalMode: original }).where(eq(systemState.id, 'singleton'));
    vi.restoreAllMocks();
    if (fx) await fx.teardown();
  });

  /** The route's handle: the application role in the site's scope. */
  const siteDb = (siteId: string) => scopedDatabase(db, { site: siteId });

  it('PUT /flow-drafts/approval-mode records the change in the audit log without an insert failure', async () => {
    const errors = vi.spyOn(console, 'error');
    const target = original === 'solo' ? 'team' : 'solo';
    expect(await setApprovalMode(siteDb(fx.sites.a), fx.sites.a, target, fx.users.adminA.id)).toBe(target);
    const logged = errors.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.includes('audit'));
    expect(logged).toEqual([]);
    const rows = await fixtures.select().from(auditLog).where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'approval_mode_changed')));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.metadata).toMatchObject({ from: original, to: target, by: fx.users.adminA.id });
  });

  it('with the async audit queue installed, nothing is queued: the row is written with the change; no-op writes nothing', async () => {
    const jobs: unknown[] = [];
    setAuditLogQueue({ enqueue: async (_q: string, _k: string, job: unknown) => void jobs.push(job) } as never);
    try {
      const target = original === 'solo' ? 'team' : 'solo';
      await setApprovalMode(siteDb(fx.sites.b), fx.sites.b, target, fx.users.adminB.id);
      await setApprovalMode(siteDb(fx.sites.b), fx.sites.b, target, fx.users.adminB.id);
      expect(jobs).toEqual([]);
      const rows = await fixtures.select().from(auditLog).where(and(eq(auditLog.siteId, fx.sites.b), eq(auditLog.event, 'approval_mode_changed')));
      expect(rows).toHaveLength(1);
      const [state] = await fixtures.select({ mode: systemState.approvalMode }).from(systemState).where(eq(systemState.id, 'singleton'));
      expect(state!.mode).toBe(target);
    } finally {
      setAuditLogQueue(undefined);
    }
  });
});
