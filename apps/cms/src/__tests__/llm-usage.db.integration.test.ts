import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { auditLog, llmAttempts, llmCalls, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { lateUsage } from '../services/llm/ledger';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Model usage and manual reconciliation (HeoPress P04 task 7.4; design
 * "模型提供方实施方案", T9 and "接口"), through the whole app: usage by
 * provider and model with unknown liabilities and the debt carried over from
 * earlier months; a person's conclusion only on an attempt that has ended and
 * whose cost is unknown (or a revision of their own), with operator, evidence
 * and every earlier conclusion kept; a late automatic result never overwrites
 * it; a batch "not billed" answers per attempt; site administrators only, and
 * only their own site's ledger.
 */

const JWT_SECRET = 'llm-usage-test-secret';
const KEK = Buffer.alloc(32, 7).toString('base64');
const NOW_PERIOD = new Date().toISOString().slice(0, 7);
const OLD_PERIOD = '2020-01';

describe.skipIf(!hasDbIntegrationUrl)('model usage and reconciliation — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('llm-usage');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development', ENCRYPTION_KEY: KEK, LLM_PRICE_CURRENCY: 'USD' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'llmu', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const as = async (who: 'adminA' | 'adminB' | 'onlyA', site: 'a' | 'b') => fx.headers(site, await fx.session(who, site));
  const call = (pathname: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(`/api/v1/llm${pathname}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const codeOf = async (res: Response) => ((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code;
  const dataOf = async <T>(res: Response) => {
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { data: T }).data;
  };

  const snapshot = (name: string, model: string) => ({ name, model, pricing: { kind: 'per_1m_tokens', inputMicros: 1, outputMicros: 1 }, currency: 'USD' });
  let seq = 0;
  /** One attempt on its own call, as the gateway would have left it. */
  const attempt = async (site: string, over: Partial<typeof llmAttempts.$inferInsert> & { name?: string; model?: string }) => {
    const { name = 'Primary', model = 'model-a', ...rest } = over;
    const [c] = await db
      .insert(llmCalls)
      .values({ siteId: site, callKey: `k${++seq}`, taskType: 'chat', originKind: 'test', requestDigest: 'd', candidates: [], deadlineAt: new Date(), status: 'failed', terminalReason: 'TEST' })
      .returning();
    const [row] = await db
      .insert(llmAttempts)
      .values({
        siteId: site, callId: c!.id, seq: 1, position: 0, source: 'instance', instanceRef: 'llm-default', snapshot: snapshot(name, model),
        requestDigest: 'd', period: NOW_PERIOD, outcome: 'failed_transferable', billing: 'unknown', reservedMicros: 30, ...rest,
      })
      .returning();
    return row!;
  };

  it('usage of a month: by provider and model, unknown liabilities, and the debt carried over from earlier months', async () => {
    const a = await as('adminA', 'a');
    await call('/settings', 'PUT', a, { currency: 'USD', monthlyBudgetMicros: 1_000, budgetTimezone: 'UTC' });
    await attempt(fx.sites.a, { outcome: 'succeeded', billing: 'settled', actualMicros: 100, reservedMicros: 80, inputTokens: 1200, outputTokens: 300 });
    await attempt(fx.sites.a, { outcome: 'in_flight', billing: 'reserved', reservedMicros: 50 });
    await attempt(fx.sites.a, { billing: 'unknown', reservedMicros: 30, errorCode: 'PROVIDER_HTTP_429' });
    await attempt(fx.sites.a, { billing: 'cancelled', actualMicros: 0, reservedMicros: 40 });
    await attempt(fx.sites.a, { name: 'Backup', model: 'model-b', billing: 'unknown', reservedMicros: 7 });
    await attempt(fx.sites.a, { period: OLD_PERIOD, billing: 'unknown', reservedMicros: 20 });
    await attempt(fx.sites.b, { billing: 'unknown', reservedMicros: 999 });

    const u = await dataOf<{
      period: string; committedMicros: number; remainingMicros: number;
      byModel: Array<Record<string, unknown>>; carriedOver: Array<Record<string, unknown>>;
    }>(await call('/usage', 'GET', a));
    expect(u.period).toBe(NOW_PERIOD);
    expect(u.byModel).toEqual([
      { source: 'instance', providerId: null, instanceRef: 'llm-default', name: 'Backup', model: 'model-b', attempts: 1, settledCount: 0, settledMicros: 0, reservedCount: 0, reservedMicros: 0, unknownCount: 1, unknownMicros: 7, cancelledCount: 0, inputTokens: 0, outputTokens: 0, withoutUsageCount: 1 },
      { source: 'instance', providerId: null, instanceRef: 'llm-default', name: 'Primary', model: 'model-a', attempts: 4, settledCount: 1, settledMicros: 100, reservedCount: 1, reservedMicros: 50, unknownCount: 1, unknownMicros: 30, cancelledCount: 1, inputTokens: 1200, outputTokens: 300, withoutUsageCount: 2 },
    ]);
    expect(u.carriedOver).toEqual([{ period: OLD_PERIOD, unknownCount: 1, reservedCount: 0, micros: 20 }]);
    // Settled 100 + reserved 50 + unknown 30 + 7 + last years' unknown 20; site B's never counts.
    expect(u.committedMicros).toBe(207);
    expect(u.remainingMicros).toBe(793);
    // An earlier month on its own; a malformed one is refused.
    expect((await dataOf<{ byModel: unknown[] }>(await call(`/usage?period=${OLD_PERIOD}`, 'GET', a))).byModel).toHaveLength(1);
    expect((await call('/usage?period=2026-13', 'GET', a)).status).toBe(400);
  });

  it('a person concludes an unknown cost, with evidence; a revision keeps the earlier conclusion; a late result never overwrites it', async () => {
    const a = await as('adminA', 'a');
    const unknown = await attempt(fx.sites.a, { billing: 'unknown', reservedMicros: 30 });
    const inFlight = await attempt(fx.sites.a, { outcome: 'in_flight', billing: 'reserved' });
    const settled = await attempt(fx.sites.a, { outcome: 'succeeded', billing: 'settled', actualMicros: 5, settledBy: 'auto' });
    const reconcile = (id: string, body: unknown) => call(`/attempts/${id}/reconcile`, 'POST', a, body);

    expect(await codeOf(await reconcile(inFlight.id, { conclusion: 'cancelled', evidence: 'console', version: inFlight.version }))).toBe('NOT_PENDING');
    expect(await codeOf(await reconcile(settled.id, { conclusion: 'cancelled', evidence: 'console', version: settled.version }))).toBe('NOT_PENDING');
    expect((await reconcile(unknown.id, { conclusion: 'cancelled', evidence: '  ', version: unknown.version })).status).toBe(400);
    expect((await reconcile(unknown.id, { conclusion: 'settled', evidence: 'invoice', version: unknown.version })).status).toBe(400);
    expect(await codeOf(await reconcile(unknown.id, { conclusion: 'cancelled', evidence: 'console', version: unknown.version + 1 }))).toBe('VERSION_CONFLICT');
    expect((await reconcile('missing', { conclusion: 'cancelled', evidence: 'console', version: 0 })).status).toBe(404);

    const first = await dataOf<{ version: number; billing: string; settledBy: string; actualMicros: number; overspend: boolean; reconciliation: Record<string, unknown> }>(
      await reconcile(unknown.id, { conclusion: 'settled', actualMicros: 45, evidence: 'invoice 2026-10 line 3', version: unknown.version }),
    );
    expect(first).toMatchObject({ billing: 'settled', settledBy: 'manual', actualMicros: 45, overspend: true });
    expect(first.reconciliation).toMatchObject({ conclusion: 'settled', actualMicros: 45, evidence: 'invoice 2026-10 line 3', revisions: [] });
    expect(first.reconciliation.operator).toBeTruthy();
    // Above the reservation: recorded in full and alerted.
    const alerts = await db.select().from(auditLog).where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'llm_cost_over_reservation')));
    expect(alerts).toHaveLength(1);

    // The same version again: someone else already concluded.
    expect(await codeOf(await reconcile(unknown.id, { conclusion: 'cancelled', evidence: 'x', version: unknown.version }))).toBe('VERSION_CONFLICT');
    const revised = await dataOf<{ billing: string; actualMicros: number; reconciliation: { revisions: Array<Record<string, unknown>> } }>(
      await reconcile(unknown.id, { conclusion: 'cancelled', evidence: 'credited by the provider', version: first.version }),
    );
    expect(revised).toMatchObject({ billing: 'cancelled', actualMicros: 0 });
    expect(revised.reconciliation.revisions).toEqual([expect.objectContaining({ conclusion: 'settled', actualMicros: 45, evidence: 'invoice 2026-10 line 3' })]);

    // A usage report arriving now is kept beside the conclusion, not applied.
    await runSiteTransaction(db, fx.sites.a, (tx) => lateUsage(tx, unknown, { sent: true, usage: { complete: true, inputTokens: 9, outputTokens: 9 } }));
    const [row] = await db.select().from(llmAttempts).where(eq(llmAttempts.id, unknown.id));
    expect(row).toMatchObject({ billing: 'cancelled', actualMicros: 0, settledBy: 'manual' });
    expect(row!.lateResult).toMatchObject({ usage: { complete: true, inputTokens: 9 } });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'llm_attempt_reconciled')));
    expect(audits).toHaveLength(2);
  });

  it('a batch confirms one provider’s pending attempts in a range as not billed, answering for each; the carried debt goes', async () => {
    const a = await as('adminA', 'a');
    await call('/settings', 'PUT', a, { currency: 'USD', monthlyBudgetMicros: 1_000, budgetTimezone: 'UTC' });
    const at = (iso: string) => new Date(iso);
    const inRange = [
      await attempt(fx.sites.a, { errorCode: 'PROVIDER_HTTP_429', createdAt: at('2020-01-10T00:00:00Z'), period: OLD_PERIOD, reservedMicros: 20 }),
      await attempt(fx.sites.a, { errorCode: 'PROVIDER_HTTP_429', createdAt: at('2020-01-11T00:00:00Z'), period: OLD_PERIOD, reservedMicros: 20 }),
    ];
    const otherCode = await attempt(fx.sites.a, { errorCode: 'TIMEOUT', createdAt: at('2020-01-12T00:00:00Z'), period: OLD_PERIOD });
    const outside = await attempt(fx.sites.a, { errorCode: 'PROVIDER_HTTP_429', createdAt: at('2020-02-01T00:00:00Z'), period: '2020-02' });
    const flying = await attempt(fx.sites.a, { outcome: 'in_flight', billing: 'reserved', errorCode: 'PROVIDER_HTTP_429', createdAt: at('2020-01-13T00:00:00Z'), period: OLD_PERIOD });
    const otherSite = await attempt(fx.sites.b, { errorCode: 'PROVIDER_HTTP_429', createdAt: at('2020-01-10T00:00:00Z'), period: OLD_PERIOD });

    const pending = await dataOf<Array<{ id: string }>>(await call('/attempts?pending=1', 'GET', a));
    expect(pending.map((p) => p.id).sort()).toEqual([...inRange.map((r) => r.id), otherCode.id, outside.id].sort());

    const batch = { instanceRef: 'llm-default', from: '2020-01-01T00:00:00Z', to: '2020-02-01T00:00:00Z', errorCode: 'PROVIDER_HTTP_429', evidence: 'rate limits are not billed (provider FAQ)' };
    expect((await call('/attempts/reconcile', 'POST', a, { ...batch, providerId: 'p' })).status).toBe(400);
    const out = await dataOf<{ results: Array<{ id: string; result: string }>; more: boolean }>(await call('/attempts/reconcile', 'POST', a, batch));
    expect(out).toEqual({ results: inRange.map((r) => ({ id: r.id, result: 'reconciled' })), more: false });
    for (const r of inRange) {
      const [row] = await db.select().from(llmAttempts).where(eq(llmAttempts.id, r.id));
      expect(row).toMatchObject({ billing: 'cancelled', settledBy: 'manual', reconciliation: expect.objectContaining({ batch: true, evidence: batch.evidence }) });
    }
    for (const r of [otherCode, outside, flying, otherSite]) {
      const [row] = await db.select().from(llmAttempts).where(eq(llmAttempts.id, r.id));
      expect(row!.billing, r.id).toBe(r.billing);
    }
    // Confirmed not billed: last year's debt no longer weighs on this month.
    const u = await dataOf<{ carriedOver: Array<{ period: string; micros: number }> }>(await call('/usage', 'GET', a));
    expect(u.carriedOver).toEqual([
      { period: OLD_PERIOD, unknownCount: 1, reservedCount: 1, micros: 60 },
      { period: '2020-02', unknownCount: 1, reservedCount: 0, micros: 30 },
    ]);
  });

  it('the ledger pages by its exact order: attempts microseconds apart, and at the same instant, are each listed once', async () => {
    const a = await as('adminA', 'a');
    const ids: string[] = [];
    for (const ts of ['2026-01-01 00:00:00.123900+00', '2026-01-01 00:00:00.123800+00', '2026-01-01 00:00:00.123800+00', '2026-01-01 00:00:00.123100+00']) {
      const row = await attempt(fx.sites.a, {});
      await db.execute(sql`UPDATE lumibase_llm_attempts SET created_at = ${ts}::timestamptz WHERE id = ${row.id}`);
      ids.push(row.id);
    }
    const seen: string[] = [];
    let before: string | null = null;
    do {
      const res = await call(`/attempts?limit=1${before ? `&before=${before}` : ''}`, 'GET', a);
      const page = (await res.json()) as { data: Array<{ id: string }>; meta: { next: string | null } };
      seen.push(...page.data.map((d) => d.id));
      before = page.meta.next;
    } while (before && seen.length < 10);
    expect(seen).toHaveLength(4);
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(seen[0]).toBe(ids[0]);
    expect(seen[3]).toBe(ids[3]);
  });

  it("only the site's administrators see or reconcile its ledger, and only their own", async () => {
    const pendingA = await attempt(fx.sites.a, { billing: 'unknown' });
    const onlyA = await as('onlyA', 'a');
    expect((await call('/usage', 'GET', onlyA)).status).toBe(403);
    expect((await call('/attempts', 'GET', onlyA)).status).toBe(403);
    expect((await call(`/attempts/${pendingA.id}/reconcile`, 'POST', onlyA, { conclusion: 'cancelled', evidence: 'x', version: 0 })).status).toBe(403);
    const b = await as('adminB', 'b');
    expect(await dataOf<unknown[]>(await call('/attempts', 'GET', b))).toEqual([]);
    expect((await call(`/attempts/${pendingA.id}/reconcile`, 'POST', b, { conclusion: 'cancelled', evidence: 'x', version: 0 })).status).toBe(404);
    const batch = await dataOf<{ results: unknown[] }>(
      await call('/attempts/reconcile', 'POST', b, { instanceRef: 'llm-default', from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z', evidence: 'x' }),
    );
    expect(batch.results).toEqual([]);
    const [row] = await db.select().from(llmAttempts).where(eq(llmAttempts.id, pendingA.id));
    expect(row!.billing).toBe('unknown');
  });
});
