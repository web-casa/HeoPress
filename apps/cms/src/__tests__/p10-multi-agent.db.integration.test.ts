import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { batchPlans, items, roles, userSites, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { AgentAccessService } from '../services/agent-access/agent-access-service';
import { __resetPermissionProcessCacheForTests } from '../services/permission-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * HeoPress P10 task 6.1: two people, each with a different external agent, acting at the same time on the agent MCP
 * endpoint. Person 1 (`onlyA`, editor of site A) connects "Agent One" through OAuth (dynamic registration + PKCE);
 * person 2 (`adminA`, administrator of A and B) connects "Agent Two" with a personal access token. Calls are fired
 * concurrently. Cross-permission calls are refused, a concurrent edit of the same item lets exactly one write through
 * and answers the other with 409, and a multi-site change only becomes a plan waiting for a person's approval.
 */

const JWT_SECRET = 'p10-multi-secret';
const BASE = 'https://cms.example.com';
const MCP = `${BASE}/api/v1/agents/mcp`;
const REDIRECT = 'http://127.0.0.1:33419/callback';

type Rpc = { status: number; isError?: boolean; value: Record<string, unknown> & { code?: string; status?: number; data?: unknown }; errorCode?: string };

describe.skipIf(!hasDbIntegrationUrl)('P10 multi-user, multi-agent — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  const fetchFn = (url: string | URL, init?: RequestInit) => Promise.resolve(app.request(String(url), init, env));

  beforeAll(async () => {
    db = await connectDbIntegration('p10-multi-agent');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development', HEOPRESS_PUBLIC_URL: BASE, HEOPRESS_API_RATE_LIMIT: '100000', HEOPRESS_OAUTH_REGISTER_LIMIT: '1000' };
    setRuntimeFactory(() => createRuntime(env));
  });
  afterAll(() => setRuntimeFactory(null));
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'p10ma', jwtSecret: JWT_SECRET });
    __resetPermissionProcessCacheForTests();
    const [adminB] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, fx.sites.b), eq(roles.adminAccess, true))).limit(1);
    await db.insert(userSites).values({ userId: fx.users.adminA.id, siteId: fx.sites.b, roleId: adminB!.id });
  });
  afterEach(async () => {
    await db.execute(sql`DELETE FROM lumibase_batch_plans WHERE drafted_by LIKE 'usr_p10ma_%'`);
    await db.execute(sql`DELETE FROM lumibase_agent_grants WHERE user_id LIKE 'usr_p10ma_%'`);
    await db.execute(sql`DELETE FROM lumibase_agent_idempotency WHERE subject LIKE 'user:usr_p10ma_%'`);
    if (fx) await fx.teardown();
  });

  /** Agent One: person `onlyA` through OAuth, consenting to site A with read + content. */
  async function agentOne(): Promise<string> {
    const prm = await discoverOAuthProtectedResourceMetadata(MCP, {}, fetchFn);
    const meta = (await discoverAuthorizationServerMetadata(prm.authorization_servers![0]!, { fetchFn }))!;
    const client = await registerClient(BASE, {
      metadata: meta,
      clientMetadata: { client_name: 'Agent One', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
      fetchFn,
    });
    const { authorizationUrl, codeVerifier } = await startAuthorization(BASE, { metadata: meta, clientInformation: client, redirectUrl: REDIRECT, state: 's1', resource: new URL(MCP) });
    const consent = new URL((await app.request(authorizationUrl.href, {}, env)).headers.get('location')!);
    const session = await fx.session('onlyA', 'a');
    const decided = await app.request(
      '/api/v1/agent-access/consent',
      { method: 'POST', headers: fx.headers('a', session), body: JSON.stringify({ request: consent.searchParams.get('request'), approve: true, siteIds: [fx.sites.a], toolGroups: ['read', 'content'] }) },
      env,
    );
    expect(decided.status).toBe(200);
    const code = new URL(((await decided.json()) as { data: { redirectTo: string } }).data.redirectTo).searchParams.get('code')!;
    const tokens = await exchangeAuthorization(BASE, { metadata: meta, clientInformation: client, authorizationCode: code, codeVerifier, redirectUri: REDIRECT, resource: new URL(MCP), fetchFn });
    return tokens.access_token;
  }

  /** Agent Two: person `adminA` with a personal access token for sites A and B. */
  async function agentTwo(): Promise<string> {
    const t = await new AgentAccessService({ db, jwtSecret: JWT_SECRET }).createPersonalToken(fx.users.adminA.id, { name: 'Agent Two', siteIds: [fx.sites.a, fx.sites.b], toolGroups: ['read', 'content', 'publish'] }, MCP);
    return t.token;
  }

  async function call(token: string, name: string, args: Record<string, unknown>): Promise<Rpc> {
    const res = await app.request(
      MCP,
      { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) },
      env,
    );
    const body = (await res.json().catch(() => null)) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> }; error?: { data?: { code?: string } } } | null;
    return { status: res.status, isError: body?.result?.isError, value: (body?.result?.structuredContent ?? {}) as Rpc['value'], errorCode: body?.error?.data?.code };
  }

  const itemRow = async (id: string) => (await db.select({ version: items.version, data: items.data }).from(items).where(eq(items.id, id)))[0]!;

  it('both agents work at once; cross-permission calls are refused and change nothing', async () => {
    const [one, two] = await Promise.all([agentOne(), agentTwo()]);
    const beforeB = await itemRow(fx.items.b);
    const [readA1, readA2, oneOnB, oneWriteB, twoOnB] = await Promise.all([
      call(one, 'content_get', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a }),
      call(two, 'content_get', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a }),
      call(one, 'content_get', { siteId: fx.sites.b, collection: SHARED.collection, id: fx.items.b }),
      call(one, 'content_update', { siteId: fx.sites.b, collection: SHARED.collection, id: fx.items.b, expectedVersion: beforeB.version, data: { title: 'Agent One on B' } }),
      call(two, 'content_get', { siteId: fx.sites.b, collection: SHARED.collection, id: fx.items.b }),
    ]);
    expect(readA1.isError).toBe(false);
    expect(readA2.isError).toBe(false);
    expect(twoOnB.isError).toBe(false);
    for (const r of [oneOnB, oneWriteB]) {
      expect(r.status).toBe(403);
      expect(r.errorCode).toBe('SITE_NOT_AUTHORIZED');
    }
    expect(await itemRow(fx.items.b)).toEqual(beforeB);

    // A forged identity does not borrow the other person's rights: Agent One naming person 2 is still person 1.
    const forged = await call(one, 'content_get', { siteId: fx.sites.b, collection: SHARED.collection, id: fx.items.b, userId: fx.users.adminA.id });
    expect(forged.status).toBe(403);

    // Agent One cannot see or touch a plan Agent Two drafted.
    const v = await itemRow(fx.items.a);
    const plan = await call(two, 'plans_submit', {
      scope: { siteIds: [fx.sites.a, fx.sites.b] },
      operation: 'content_update',
      arguments: { collection: SHARED.collection, data: { title: 'Planned' } },
      perSite: { [fx.sites.a]: { id: fx.items.a, expectedVersion: v.version }, [fx.sites.b]: { id: fx.items.b, expectedVersion: beforeB.version } },
    });
    const planId = (plan.value.data as { id: string }).id;
    expect((await call(one, 'plans_get', { scope: { planId } })).value.code).toBe('PLAN_NOT_FOUND');
    expect((await call(one, 'plans_revise', { scope: { planId }, arguments: { collection: SHARED.collection, data: { title: 'Hijack' } } })).value.code).toBe('PLAN_NOT_FOUND');
  });

  it('a concurrent edit of the same item lets one write through and answers the other with 409', async () => {
    const [one, two] = await Promise.all([agentOne(), agentTwo()]);
    const before = await itemRow(fx.items.a);
    const edit = (token: string, title: string) => call(token, 'content_update', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a, expectedVersion: before.version, data: { title } });
    const results = await Promise.all([edit(one, 'Title from Agent One'), edit(two, 'Title from Agent Two')]);
    const ok = results.filter((r) => r.isError === false);
    const conflicts = results.filter((r) => r.isError === true);
    expect(ok).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.value.status).toBe(409);
    expect(conflicts[0]!.value.code).toMatch(/CONFLICT/);
    const after = await itemRow(fx.items.a);
    expect(after.version).toBe(before.version + 1);
    const winner = results[0]!.isError === false ? 'Title from Agent One' : 'Title from Agent Two';
    expect((after.data as { title: string }).title).toBe(winner);

    // The loser re-reads and retries on the new version.
    const loser = results[0]!.isError === false ? two : one;
    const retry = await call(loser, 'content_update', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a, expectedVersion: after.version, data: { title: 'Merged by hand' } });
    expect(retry.isError).toBe(false);
  });

  it('a batch operation is never written directly: it becomes a plan that waits for a person', async () => {
    const [one, two] = await Promise.all([agentOne(), agentTwo()]);
    const a0 = await itemRow(fx.items.a);
    const b0 = await itemRow(fx.items.b);
    const [direct, oneMulti, submitted] = await Promise.all([
      call(two, 'content_update', { siteId: [fx.sites.a, fx.sites.b], collection: SHARED.collection, id: fx.items.a, expectedVersion: a0.version, data: { title: 'All sites' } }),
      call(one, 'plans_submit', {
        scope: { siteIds: [fx.sites.a, fx.sites.b] },
        operation: 'content_update',
        arguments: { collection: SHARED.collection, data: { title: 'All sites' } },
        perSite: { [fx.sites.a]: { id: fx.items.a, expectedVersion: a0.version }, [fx.sites.b]: { id: fx.items.b, expectedVersion: b0.version } },
      }),
      call(two, 'plans_submit', {
        scope: { siteIds: [fx.sites.a, fx.sites.b] },
        operation: 'content_update',
        arguments: { collection: SHARED.collection, data: { title: 'All sites' } },
        perSite: { [fx.sites.a]: { id: fx.items.a, expectedVersion: a0.version }, [fx.sites.b]: { id: fx.items.b, expectedVersion: b0.version } },
      }),
    ]);
    expect(direct.value.code).toBe('PLAN_REQUIRED');
    // Agent One's grant does not cover site B: its plan is refused, not narrowed to A.
    expect(oneMulti.isError === true || oneMulti.status === 403).toBe(true);
    expect(submitted.isError).toBe(false);
    const plan = submitted.value.data as { id: string; status: string };
    expect(plan.status).toBe('pending_approval');

    // No agent channel can approve: no tool, and the approval endpoint refuses both tokens.
    expect((await call(two, 'plans_approve', { scope: { planId: plan.id } })).value.code).toBe('UNKNOWN_TOOL');
    for (const bearer of [one, two]) {
      const res = await app.request(`/api/v1/agent-plans/${plan.id}/approve`, { method: 'POST', headers: fx.headers('a', bearer), body: JSON.stringify({ secondFactor: '123456' }) }, env);
      expect([401, 403]).toContain(res.status);
    }
    const [row] = await db.select({ status: batchPlans.status }).from(batchPlans).where(eq(batchPlans.id, plan.id));
    expect(row!.status).toBe('pending_approval');
    expect(await itemRow(fx.items.a)).toEqual(a0);
    expect(await itemRow(fx.items.b)).toEqual(b0);
  });
});
