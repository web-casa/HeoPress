import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { batchPlanItems, items, roles, users, userSites, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { dispatchAsAgent } from '../middleware/agent-dispatch';
import { setRuntimeFactory } from '../middleware/runtime';
import { AgentAccessService } from '../services/agent-access/agent-access-service';
import type { Dispatch } from '../services/agent-access/mcp-tool-runner';
import { COOLING_OFF_MS, PLAN_TTL_MS, PlanService, type PlanDrafter } from '../services/agent-plans/plan-service';
import { __resetPermissionProcessCacheForTests } from '../services/permission-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * HeoPress P10 tasks 3.1–3.4 (and the plan parts of 7.3) against the real database: plans submitted through the
 * agent MCP endpoint, approval only by a person (solo with a second factor and a cooling-off period, team with
 * different approvers), approvals bound to the plan hash, canary first, per-site re-checks and results (conflict,
 * forbidden), cancel, expiry, and concurrent runs.
 */

const JWT_SECRET = 'p10-plans-secret';
const BASE = 'https://cms.example.com';
const MCP = `${BASE}/api/v1/agents/mcp`;
const CODE = '123456';

describe.skipIf(!hasDbIntegrationUrl)('P10 batch plans — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let clock = Date.now();
  let mode: 'solo' | 'team' = 'solo';
  let bootstrapId = '';

  beforeAll(async () => {
    db = await connectDbIntegration('p10-batch-plans');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development', HEOPRESS_PUBLIC_URL: BASE, HEOPRESS_API_RATE_LIMIT: '100000' };
    setRuntimeFactory(() => createRuntime(env));
  });
  afterAll(() => setRuntimeFactory(null));
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'p10bp', jwtSecret: JWT_SECRET });
    __resetPermissionProcessCacheForTests();
    clock = Date.now();
    mode = 'solo';
    // adminA administers both sites (the drafter); adminB administers both too (a second person).
    const adminRole = async (siteId: string) => (await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, siteId), eq(roles.adminAccess, true))).limit(1))[0]!.id;
    await db.insert(userSites).values([
      { userId: fx.users.adminA.id, siteId: fx.sites.b, roleId: await adminRole(fx.sites.b) },
      { userId: fx.users.adminB.id, siteId: fx.sites.a, roleId: await adminRole(fx.sites.a) },
    ]);
    const [boot] = await db.select({ id: users.id }).from(users).where(eq(users.isBootstrap, true)).limit(1);
    bootstrapId = boot!.id;
  });
  afterEach(async () => {
    await db.execute(sql`DELETE FROM lumibase_batch_plans WHERE drafted_by LIKE 'usr_p10bp_%'`);
    await db.execute(sql`DELETE FROM lumibase_agent_grants WHERE user_id LIKE 'usr_p10bp_%'`);
    if (fx) await fx.teardown();
  });

  // ── helpers ─────────────────────────────────────────────────────────

  const access = () => new AgentAccessService({ db, jwtSecret: JWT_SECRET });

  const dispatchAs =
    (userId: string, grantId: string | null): Dispatch =>
    async (siteId, r) => {
      const headers: Record<string, string> = { 'x-heopress-site': siteId, ...(r.headers ?? {}) };
      if (r.json !== undefined) headers['content-type'] = 'application/json';
      const res = await dispatchAsAgent(new Request(`${BASE}${r.path}`, { method: r.method, headers, body: r.json !== undefined ? JSON.stringify(r.json) : undefined }), { userId, grantId }, env as never);
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
    };

  const service = () =>
    new PlanService({
      db,
      access: access(),
      dispatchAs,
      verifySecondFactor: async (_u, code) => code === CODE,
      approvalMode: async () => mode,
      now: () => new Date(clock),
    });

  async function pat(groups = ['read', 'content', 'publish'], siteKeys: Array<'a' | 'b'> = ['a', 'b']) {
    return access().createPersonalToken(fx.users.adminA.id, { name: 'plans', siteIds: siteKeys.map((k) => fx.sites[k]), toolGroups: groups }, MCP);
  }

  async function drafter(groups?: string[]): Promise<PlanDrafter> {
    const t = await pat(groups);
    return { userId: fx.users.adminA.id, grantId: t.grant.id, via: 'pat' };
  }

  const versionOf = async (id: string) => (await db.select({ version: items.version }).from(items).where(eq(items.id, id)))[0]!.version;

  async function updatePlan(d: PlanDrafter, siteKeys: Array<'a' | 'b'> = ['a', 'b']) {
    const perSite: Record<string, Record<string, unknown>> = {};
    for (const k of siteKeys) perSite[fx.sites[k]] = { id: fx.items[k], expectedVersion: await versionOf(fx.items[k]) };
    return service().submit(d, { operation: 'content_update', arguments: { collection: SHARED.collection, data: { title: 'Planned title' } }, perSite, siteIds: siteKeys.map((k) => fx.sites[k]), scopeKind: 'siteIds' }, 'test');
  }

  async function deletePlan(d: PlanDrafter, siteKeys: Array<'a' | 'b'> = ['a']) {
    const perSite: Record<string, Record<string, unknown>> = {};
    for (const k of siteKeys) perSite[fx.sites[k]] = { id: fx.items[k], expectedVersion: await versionOf(fx.items[k]) };
    return service().submit(d, { operation: 'content_delete', arguments: { collection: SHARED.collection }, perSite, siteIds: siteKeys.map((k) => fx.sites[k]), scopeKind: 'siteIds' }, 'test');
  }

  async function rpc(token: string, name: string, args: Record<string, unknown>) {
    const res = await app.request(
      MCP,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) },
      env,
    );
    const body = (await res.json()) as { result?: { structuredContent?: Record<string, unknown> } };
    return { status: res.status, value: (body.result?.structuredContent ?? {}) as Record<string, unknown> & { code?: string; data?: Record<string, unknown> } };
  }

  // ── submission through MCP; no agent approval ───────────────────────

  it('an agent submits through MCP, reads its plan, and no agent channel can approve it', async () => {
    const token = (await pat()).token;
    const perSite = { [fx.sites.a]: { id: fx.items.a, expectedVersion: await versionOf(fx.items.a) }, [fx.sites.b]: { id: fx.items.b, expectedVersion: await versionOf(fx.items.b) } };
    const submitted = await rpc(token, 'plans_submit', { scope: { siteIds: [fx.sites.b, fx.sites.a] }, operation: 'content_update', arguments: { collection: SHARED.collection, data: { title: 'T' } }, perSite });
    const plan = submitted.value.data as { id: string; status: string; riskTier: string; scope: { siteIds: string[]; confirmation: string }; planHash: string };
    expect(plan).toMatchObject({ status: 'pending_approval', riskTier: 'low' });
    expect(plan.scope.siteIds).toEqual([fx.sites.a, fx.sites.b].sort());
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);

    // A missing expected version is refused before anything is stored.
    const noVersion = await rpc(token, 'plans_submit', { scope: { siteIds: [fx.sites.a] }, operation: 'content_update', arguments: { collection: SHARED.collection, id: fx.items.a, data: {} } });
    expect(noVersion.value.code).toBe('INVALID_ARGUMENTS');

    const got = await rpc(token, 'plans_get', { scope: { planId: plan.id } });
    expect((got.value.data as { id: string }).id).toBe(plan.id);

    // No approval tool exists; the decision endpoints refuse a token, an API key and an internal agent request.
    const list = await app.request(MCP, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }, env);
    const names = ((await list.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
    expect(names.filter((n) => /approve|confirm|execute|cancel/.test(n))).toEqual([]);
    expect((await rpc(token, 'plans_approve', { scope: { planId: plan.id } })).value.code).toBe('UNKNOWN_TOOL');
    for (const bearer of [token, fx.apiKeys.aEditor.token]) {
      const res = await app.request(`/api/v1/agent-plans/${plan.id}/approve`, { method: 'POST', headers: fx.headers('a', bearer), body: JSON.stringify({ secondFactor: CODE }) }, env);
      expect([401, 403]).toContain(res.status);
    }
    const internal = await dispatchAs(fx.users.adminA.id, null)(fx.sites.a, { method: 'POST', path: `/api/v1/agent-plans/${plan.id}/approve`, json: { secondFactor: CODE } });
    expect(internal.status).toBe(403);
    expect((await service().view(plan.id)).plan.status).toBe('pending_approval');

    // A person in Studio sees it.
    const session = await fx.session('adminA', 'a');
    const seen = await app.request(`/api/v1/agent-plans/${plan.id}`, { headers: fx.headers('a', session) }, env);
    expect(seen.status).toBe(200);
    expect(((await seen.json()) as { data: { viewer: { canApprove: boolean; needsSecondFactor: boolean } } }).data.viewer).toMatchObject({ canApprove: true, needsSecondFactor: true });
    // Another user's token cannot read the plan.
    const other = await access().createPersonalToken(fx.users.adminB.id, { name: 'b', siteIds: [fx.sites.a], toolGroups: ['read'] }, MCP);
    expect((await rpc(other.token, 'plans_get', { scope: { planId: plan.id } })).value.code).toBe('PLAN_NOT_FOUND');
  });

  it('Studio lists the plan, previews the per-site diff and a person rejects it', async () => {
    const d = await drafter();
    const plan = await updatePlan(d);
    const session = await fx.session('adminB', 'a');
    const list = await app.request('/api/v1/agent-plans', { headers: fx.headers('a', session) }, env);
    expect(((await list.json()) as { data: Array<{ id: string }> }).data.map((p) => p.id)).toContain(plan.plan.id);
    const preview = await app.request(`/api/v1/agent-plans/${plan.plan.id}/preview`, { headers: fx.headers('a', session) }, env);
    const rows = ((await preview.json()) as { data: { items: Array<{ siteId: string; stale: boolean; changes: Array<{ field: string; proposed: unknown }> }> } }).data.items;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ stale: false, changes: [{ field: 'title', proposed: 'Planned title' }] });
    // Someone who belongs to neither site does not see it.
    const onlyA = await updatePlan(d, ['a']);
    const stranger = await app.request(`/api/v1/agent-plans/${onlyA.plan.id}`, { headers: fx.headers('b', await fx.session('onlyB', 'b')) }, env);
    expect([403, 404]).toContain(stranger.status);
    const noReason = await app.request(`/api/v1/agent-plans/${plan.plan.id}/reject`, { method: 'POST', headers: fx.headers('a', session), body: '{}' }, env);
    expect(noReason.status).toBe(400);
    const rejected = await app.request(`/api/v1/agent-plans/${plan.plan.id}/reject`, { method: 'POST', headers: fx.headers('a', session), body: JSON.stringify({ reason: 'not now' }) }, env);
    expect(rejected.status).toBe(200);
    expect(((await rejected.json()) as { data: { status: string } }).data.status).toBe('rejected');
  });

  // ── solo mode ───────────────────────────────────────────────────────

  it('solo: the drafter approves only with a second factor, then each site runs once', async () => {
    const d = await drafter();
    const plan = await updatePlan(d);
    const s = service();
    await expect(s.approve(plan.plan.id, d.userId)).rejects.toMatchObject({ code: 'SECOND_FACTOR_REQUIRED', status: 403 });
    await expect(s.approve(plan.plan.id, d.userId, { secondFactor: '000000' })).rejects.toMatchObject({ code: 'SECOND_FACTOR_REQUIRED' });
    // Someone without administrator access to every site is not eligible.
    await expect(s.approve(plan.plan.id, fx.users.onlyA.id)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE', status: 403 });
    const approved = await s.approve(plan.plan.id, d.userId, { secondFactor: CODE });
    expect(approved.plan.status).toBe('approved');
    expect(approved.approvals[0]).toMatchObject({ verification: 'totp', current: true });

    const vA = await versionOf(fx.items.a);
    const done = await s.execute(plan.plan.id, fx.users.adminB.id);
    expect(done.plan.status).toBe('completed');
    expect(done.items.map((i) => i.status)).toEqual(['succeeded', 'succeeded']);
    expect(await versionOf(fx.items.a)).toBe(vA + 1);
    // A second run is refused; nothing runs twice.
    await expect(s.execute(plan.plan.id, d.userId)).rejects.toMatchObject({ code: 'NOT_APPROVED' });
    expect(await versionOf(fx.items.a)).toBe(vA + 1);
    expect((await s.view(plan.plan.id)).items.every((i) => i.attempts === 1)).toBe(true);
  });

  it('a site changed by someone else after approval returns conflict; the other site runs', async () => {
    const d = await drafter();
    const plan = await updatePlan(d);
    const s = service();
    await s.approve(plan.plan.id, d.userId, { secondFactor: CODE });
    // Someone edits site B's item.
    const edit = await dispatchAs(fx.users.adminB.id, null)(fx.sites.a, {
      method: 'PATCH',
      path: `/api/v1/items/${SHARED.collection}/${fx.items.a}`,
      json: { data: { title: 'Edited meanwhile' }, expectedVersion: await versionOf(fx.items.a) },
    });
    expect(edit.status).toBe(200);
    const done = await s.execute(plan.plan.id, d.userId);
    const byId = Object.fromEntries(done.items.map((i) => [i.siteId, i]));
    expect(byId[fx.sites.a]!.status).toBe('conflict');
    expect(byId[fx.sites.b]!.status).toBe('succeeded');
    expect(done.plan.status).toBe('completed');
  });

  it('solo highest tier: cooling-off can be cancelled and then nothing runs', async () => {
    const d = await drafter();
    const plan = await deletePlan(d);
    expect(plan.plan).toMatchObject({ riskTier: 'highest', highRisk: true, requiresCanary: true });
    const s = service();
    const approved = await s.approve(plan.plan.id, d.userId, { secondFactor: CODE });
    expect(approved.plan.status).toBe('cooling_off');
    expect(approved.plan.coolingOffUntil!.getTime() - clock).toBe(COOLING_OFF_MS);
    await expect(s.execute(plan.plan.id, d.userId)).rejects.toMatchObject({ code: 'COOLING_OFF' });
    const cancelled = await s.cancel(plan.plan.id, d.userId, 'changed my mind');
    expect(cancelled.plan.status).toBe('cancelled');
    clock += COOLING_OFF_MS + 1000;
    await expect(s.execute(plan.plan.id, d.userId)).rejects.toMatchObject({ code: 'NOT_APPROVED' });
    expect((await db.select({ id: items.id, deletedAt: items.deletedAt }).from(items).where(eq(items.id, fx.items.a)))[0]!.deletedAt).toBeNull();
  });

  it('high risk runs its canary first; the rest waits for a person to confirm; cancel keeps finished results', async () => {
    const d = await drafter();
    const plan = await deletePlan(d, ['a', 'b']);
    expect(plan.items.filter((i) => i.canary).map((i) => i.siteId)).toEqual([[fx.sites.a, fx.sites.b].sort()[0]]);
    const s = service();
    await s.approve(plan.plan.id, d.userId, { secondFactor: CODE });
    clock += COOLING_OFF_MS + 1000;
    const canary = await s.execute(plan.plan.id, d.userId);
    expect(canary.plan.status).toBe('canary_review');
    expect(canary.items.find((i) => i.canary)!.status).toBe('succeeded');
    expect(canary.items.find((i) => !i.canary)!.status).toBe('pending');
    await expect(s.execute(plan.plan.id, d.userId)).rejects.toMatchObject({ code: 'NOT_APPROVED' });
    const cancelled = await s.cancel(plan.plan.id, d.userId, 'enough');
    expect(cancelled.items.find((i) => i.canary)!.status).toBe('succeeded');
    expect(cancelled.items.find((i) => !i.canary)!.status).toBe('cancelled');
  });

  it('after the canary is confirmed the rest runs', async () => {
    const d = await drafter();
    const plan = await deletePlan(d, ['a', 'b']);
    const s = service();
    await s.approve(plan.plan.id, d.userId, { secondFactor: CODE });
    clock += COOLING_OFF_MS + 1000;
    await s.execute(plan.plan.id, d.userId);
    await expect(s.confirmCanary(plan.plan.id, fx.users.onlyA.id)).rejects.toMatchObject({ code: 'NOT_ELIGIBLE' });
    expect((await s.confirmCanary(plan.plan.id, d.userId)).plan.status).toBe('approved');
    const done = await s.execute(plan.plan.id, d.userId);
    expect(done.plan.status).toBe('completed');
    expect(done.items.map((i) => i.status)).toEqual(['succeeded', 'succeeded']);
  });

  // ── team mode ───────────────────────────────────────────────────────

  it('team: the drafter cannot approve; the highest tier needs two different approvers', async () => {
    mode = 'team';
    const d = await drafter();
    const low = await updatePlan(d);
    const s = service();
    await expect(s.approve(low.plan.id, d.userId, { secondFactor: CODE })).rejects.toMatchObject({ code: 'SELF_APPROVAL', status: 403 });
    expect((await s.approve(low.plan.id, fx.users.adminB.id)).plan.status).toBe('approved');

    const high = await deletePlan(d);
    expect(high.plan.requiredApprovals).toBe(2);
    const first = await s.approve(high.plan.id, fx.users.adminB.id);
    expect(first.plan.status).toBe('pending_approval');
    await expect(s.approve(high.plan.id, fx.users.adminB.id)).rejects.toMatchObject({ code: 'SAME_APPROVER', status: 403 });
    await expect(s.approve(high.plan.id, d.userId, { secondFactor: CODE })).rejects.toMatchObject({ code: 'SELF_APPROVAL' });
    const second = await s.approve(high.plan.id, bootstrapId);
    // Team mode has no cooling-off: the second approver is the extra check.
    expect(second.plan.status).toBe('approved');
    expect(second.approvalsCurrent).toBe(2);
  });

  it('switching the mode only affects plans submitted afterwards', async () => {
    const d = await drafter();
    const before = await updatePlan(d);
    mode = 'team';
    const after = await updatePlan(d);
    const s = service();
    expect((await s.approve(before.plan.id, d.userId, { secondFactor: CODE })).plan.status).toBe('approved');
    await expect(s.approve(after.plan.id, d.userId, { secondFactor: CODE })).rejects.toMatchObject({ code: 'SELF_APPROVAL' });
  });

  // ── hash binding, expiry, concurrency, re-checks ────────────────────

  it('a revision after approval invalidates it; a change behind the service is refused', async () => {
    const d = await drafter();
    const plan = await updatePlan(d, ['a']);
    const s = service();
    await s.approve(plan.plan.id, d.userId, { secondFactor: CODE });
    const revised = await s.revise(d, plan.plan.id, { siteIds: [fx.sites.a, fx.sites.b], perSite: { [fx.sites.a]: { id: fx.items.a, expectedVersion: await versionOf(fx.items.a) }, [fx.sites.b]: { id: fx.items.b, expectedVersion: await versionOf(fx.items.b) } } });
    expect(revised.plan).toMatchObject({ status: 'pending_approval', revision: 2, siteCount: 2 });
    expect(revised.approvalsCurrent).toBe(0);
    expect(revised.plan.planHash).not.toBe(plan.plan.planHash);
    await expect(s.execute(plan.plan.id, d.userId)).rejects.toMatchObject({ code: 'NOT_APPROVED' });

    // Someone edits the stored target list directly: neither approval nor execution accepts it.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.agent_access', 'on', true)`);
      await tx.update(batchPlanItems).set({ arguments: { id: fx.items.a, expectedVersion: 99 } }).where(and(eq(batchPlanItems.planId, plan.plan.id), eq(batchPlanItems.siteId, fx.sites.a)));
    });
    await expect(s.approve(plan.plan.id, d.userId, { secondFactor: CODE })).rejects.toMatchObject({ code: 'PLAN_TAMPERED' });
    // An approval for an older hash is refused as well.
    await expect(s.approve(plan.plan.id, d.userId, { secondFactor: CODE, planHash: plan.plan.planHash })).rejects.toMatchObject({ code: 'PLAN_CHANGED' });
  });

  it('an expired plan is refused and marked expired', async () => {
    const d = await drafter();
    const plan = await updatePlan(d);
    const s = service();
    await s.approve(plan.plan.id, d.userId, { secondFactor: CODE });
    clock += PLAN_TTL_MS + 1000;
    await expect(s.execute(plan.plan.id, d.userId)).rejects.toMatchObject({ code: 'NOT_APPROVED' });
    expect((await s.view(plan.plan.id)).plan.status).toBe('expired');
  });

  it('two concurrent runs produce each site at most once', async () => {
    const d = await drafter();
    const plan = await updatePlan(d);
    const s = service();
    await s.approve(plan.plan.id, d.userId, { secondFactor: CODE });
    const vA = await versionOf(fx.items.a);
    const vB = await versionOf(fx.items.b);
    const outcomes = await Promise.allSettled([s.execute(plan.plan.id, d.userId), service().execute(plan.plan.id, fx.users.adminB.id)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const refused = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect(['PLAN_ALREADY_RUNNING', 'NOT_APPROVED']).toContain((refused.reason as { code: string }).code);
    expect(await versionOf(fx.items.a)).toBe(vA + 1);
    expect(await versionOf(fx.items.b)).toBe(vB + 1);
  });

  it('permissions are re-checked per site: a lost membership is reported for that site, a revoked authorization for all', async () => {
    const d = await drafter();
    const plan = await updatePlan(d);
    const s = service();
    await s.approve(plan.plan.id, d.userId, { secondFactor: CODE });
    await db.delete(userSites).where(and(eq(userSites.userId, d.userId), eq(userSites.siteId, fx.sites.b)));
    const done = await s.execute(plan.plan.id, d.userId);
    const byId = Object.fromEntries(done.items.map((i) => [i.siteId, i]));
    expect(byId[fx.sites.a]!.status).toBe('succeeded');
    expect(byId[fx.sites.b]).toMatchObject({ status: 'forbidden', result: { code: 'NOT_A_MEMBER' } });
    expect(done.plan.siteCount).toBe(2);

    const plan2 = await updatePlan(d, ['a']);
    await s.approve(plan2.plan.id, d.userId, { secondFactor: CODE });
    await access().revokeGrant(d.userId, d.grantId!);
    const refused = await s.execute(plan2.plan.id, d.userId);
    expect(refused.items[0]).toMatchObject({ status: 'forbidden', result: { code: 'AUTHORIZATION_REVOKED' } });
  });
});
