import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { agentGrants, batchPlans, items, roles, translationGroupMembers, translationGroups, userSites, type Database } from '@heopress/database';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { serve } from '@hono/node-server';
import { createRuntime } from '@heopress/runtime/node';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { AgentAccessService } from '../services/agent-access/agent-access-service';
import { ItemService } from '../services/item-service';
import { DEFAULT_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from '../services/mcp-service';
import { __resetPermissionProcessCacheForTests } from '../services/permission-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * HeoPress P10 quality gate (ADR-0017) for the agent MCP endpoint, against the real database:
 *
 * - task 7.1: per supported protocol version — negotiation, the response shape of a tool call, cancellation (a
 *   `notifications/cancelled` is accepted with 202 and changes nothing), the JSON-RPC error format, and the
 *   `MCP-Protocol-Version` header; the official SDK client (the pinned version) completes a session;
 * - task 7.2: one test per security class — no token, a wrong token, an expired, a revoked token, insufficient
 *   scope, a token for site A naming site B, a read-only token writing or publishing, a foreign `Origin`, another
 *   person taking over an operation identifier (plan id, idempotency key), and error output without secrets or
 *   internal configuration — each asserting that nothing changed.
 *
 * The compatibility matrix: docs/zh-CN/agents/mcp-compatibility.md.
 */

const JWT_SECRET = 'p10-sec-jwt-0';
const BASE = 'https://cms.example.com';
const MCP = `${BASE}/api/v1/agents/mcp`;

type Rpc = { jsonrpc: string; id: unknown; result?: Record<string, unknown> & { isError?: boolean; structuredContent?: Record<string, unknown> & { code?: string; data?: unknown } }; error?: { code: number; message: string; data?: Record<string, unknown> } };

describe.skipIf(!hasDbIntegrationUrl)('P10 MCP protocol and security — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('p10-mcp-protocol-security');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'production', HEOPRESS_PUBLIC_URL: BASE, HEOPRESS_API_RATE_LIMIT: '100000', CORS_ALLOWED_ORIGINS: 'https://studio.example.com' };
    setRuntimeFactory(() => createRuntime(env));
  });
  afterAll(() => setRuntimeFactory(null));
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'p10ms', jwtSecret: JWT_SECRET });
    __resetPermissionProcessCacheForTests();
  });
  afterEach(async () => {
    await db.execute(sql`DELETE FROM lumibase_batch_plans WHERE drafted_by LIKE 'usr_p10ms_%'`);
    await db.execute(sql`DELETE FROM lumibase_agent_grants WHERE user_id LIKE 'usr_p10ms_%'`);
    if (fx) await fx.teardown();
  });

  // ── helpers ─────────────────────────────────────────────────────────

  const access = () => new AgentAccessService({ db, jwtSecret: JWT_SECRET });
  const pat = (user: 'adminA' | 'adminB' | 'both' | 'onlyA', siteKeys: Array<'a' | 'b'>, groups: string[]) =>
    access().createPersonalToken(fx.users[user].id, { name: `sec-${user}`, siteIds: siteKeys.map((k) => fx.sites[k]), toolGroups: groups }, MCP);

  async function post(body: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(MCP, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }, env);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, json: (text ? JSON.parse(text) : null) as Rpc | null };
  }
  const bearer = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });
  const call = (token: string, name: string, args: Record<string, unknown>, extra: Record<string, string> = {}) =>
    post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, bearer(token, extra));

  /** What a successful attack would change: the items of both sites (ids, versions, titles, statuses) and plans. */
  async function snapshot() {
    const rows = await db
      .select({ id: items.id, version: items.version, status: items.status, title: sql<string>`${items.data}->>'title'` })
      .from(items)
      .where(inArray(items.siteId, [fx.sites.a, fx.sites.b]))
      .orderBy(items.id);
    const plans = await db.select({ id: batchPlans.id }).from(batchPlans).where(sql`${batchPlans.draftedBy} LIKE 'usr_p10ms_%'`);
    return JSON.stringify({ rows, plans: plans.length });
  }
  const update = (siteKey: 'a' | 'b', title = 'Changed by an attacker') => ({ siteId: fx.sites[siteKey], collection: SHARED.collection, id: fx.items[siteKey], expectedVersion: 1, data: { title } });

  // ── 7.1 protocol versions, response, cancellation, errors ───────────

  it.each(SUPPORTED_PROTOCOL_VERSIONS.map((v) => [v]))('protocol %s: negotiation, tool result shape, cancellation and error format', async (version) => {
    const { token } = await pat('adminA', ['a'], ['read', 'content']);
    const headers = bearer(token, { 'mcp-protocol-version': version });
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'conformance', version: '0' } } }, bearer(token));
    expect(init.status).toBe(200);
    expect(init.json).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'heopress-agents' } } });
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, headers)).status).toBe(202);

    const got = await post({ jsonrpc: '2.0', id: 'g1', method: 'tools/call', params: { name: 'content_get', arguments: { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a } } }, headers);
    expect(got.status).toBe(200);
    expect(got.json!.id).toBe('g1');
    const result = got.json!.result!;
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(result.structuredContent) }]);
    expect((result.structuredContent!.data as { id: string }).id).toBe(fx.items.a);

    // A tool error is a result with isError, not a JSON-RPC error.
    const toolError = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'content_update', arguments: { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a, data: {} } } }, headers);
    expect(toolError.status).toBe(200);
    expect(toolError.json!.result).toMatchObject({ isError: true, structuredContent: { code: 'VERSION_REQUIRED' } });

    // Cancellation: a notification, accepted with 202 and no body; it does not touch anything.
    const before = await snapshot();
    const cancelled = await post({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'g1', reason: 'user aborted' } }, headers);
    expect(cancelled.status).toBe(202);
    expect(cancelled.text).toBe('');
    expect(await snapshot()).toBe(before);

    // JSON-RPC errors: code and message, the request id echoed (null when it cannot be read).
    const parse = await post('{"jsonrpc":', headers);
    expect(parse.json).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: expect.any(String) } });
    const invalid = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }], headers);
    expect(invalid.json!.error!.code).toBe(-32600);
    const unknown = await post({ jsonrpc: '2.0', id: 3, method: 'resources/list' }, headers);
    expect(unknown.json).toMatchObject({ jsonrpc: '2.0', id: 3, error: { code: -32601 } });
    const badParams = await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { arguments: {} } }, headers);
    expect(badParams.json).toMatchObject({ id: 4, error: { code: -32602 } });
    const forbidden = await call(token, 'content_get', { siteId: fx.sites.b, collection: SHARED.collection, id: fx.items.b }, { 'mcp-protocol-version': version });
    expect(forbidden.status).toBe(403);
    expect(forbidden.json).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32003, data: { code: expect.any(String) } } });
    expect((await post({ jsonrpc: '2.0', id: 5, method: 'ping' }, headers)).json).toEqual({ jsonrpc: '2.0', id: 5, result: {} });
  });

  it('an unsupported version asked at initialize gets the default; an unsupported MCP-Protocol-Version header is 400', async () => {
    const { token } = await pat('adminA', ['a'], ['read']);
    const init = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'old', version: '0' } } }, bearer(token));
    expect(init.json!.result!.protocolVersion).toBe(DEFAULT_PROTOCOL_VERSION);
    const bad = await post({ jsonrpc: '2.0', id: 2, method: 'ping' }, bearer(token, { 'mcp-protocol-version': '1999-01-01' }));
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32600, data: { supported: [...SUPPORTED_PROTOCOL_VERSIONS] } } });
  });

  it('the pinned MCP SDK client completes a session: initialize, list, call', async () => {
    const { token } = await pat('adminA', ['a'], ['read']);
    const fetchFn = (url: string | URL | Request, init?: RequestInit) => Promise.resolve(app.request(String(url instanceof Request ? url.url : url), init, env));
    const transport = new StreamableHTTPClientTransport(new URL(MCP), { requestInit: { headers: { authorization: `Bearer ${token}` } }, fetch: fetchFn as typeof fetch });
    const client = new Client({ name: 'conformance', version: '0' });
    await client.connect(transport);
    const negotiated = transport.protocolVersion;
    expect(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).toContain(negotiated);
    // The SDK may know newer versions than the server; the server answers with one it supports.
    expect(typeof LATEST_PROTOCOL_VERSION).toBe('string');
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain('content_get');
    const got = await client.callTool({ name: 'content_get', arguments: { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a } });
    expect(got.isError).toBe(false);
    await client.close();
  });

  it('the scripted conformance run (apps/cms/scripts/mcp-conformance.mjs) passes over real HTTP, including the single-site draft → publish demo', async () => {
    // adminA administers A: create the draft and publish it through the same steps an external agent takes.
    const { token } = await pat('adminA', ['a'], ['read', 'content', 'publish']);
    const server = serve({ fetch: (req) => app.fetch(req, env), port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    try {
      const script = path.resolve(__dirname, '../../scripts/mcp-conformance.mjs');
      const { stdout } = await promisify(execFile)(process.execPath, [script, '--write', fx.sites.a, '--collection', SHARED.collection], {
        env: { ...process.env, HEOPRESS_MCP_URL: `http://127.0.0.1:${port}/api/v1/agents/mcp`, HEOPRESS_MCP_TOKEN: token },
        cwd: path.resolve(__dirname, '../..'),
      }).catch((err: { stdout?: string }) => ({ stdout: err.stdout ?? '' }));
      expect(stdout).not.toContain(token);
      const report = JSON.parse(stdout) as { ok: boolean; steps: Array<{ name: string; ok: boolean; detail?: Record<string, unknown> }> };
      expect(report.steps.filter((st) => !st.ok)).toEqual([]);
      expect(report.ok).toBe(true);
      expect(SUPPORTED_PROTOCOL_VERSIONS as readonly unknown[]).toContain(report.steps[0]!.detail!.protocolVersion);
      expect(report.steps.map((st) => st.name)).toContain('content_publish (single site, expected version)');
      expect(report.steps.at(-1)!.detail).toMatchObject({ status: 'published' });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }, 60_000);

  // ── 7.2 security classes (each: refused, nothing changed) ───────────

  it('no token: 401 with the resource metadata, nothing changed', async () => {
    const before = await snapshot();
    const res = await post({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'content_update', arguments: update('a') } });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata="https://cms.example.com/.well-known/oauth-protected-resource/api/v1/agents/mcp"');
    expect(await snapshot()).toBe(before);
  });

  it('a wrong token (garbage, a forged personal token, a Studio session token): 401 invalid_token, nothing changed', async () => {
    const { token } = await pat('adminA', ['a'], ['read', 'content']);
    const before = await snapshot();
    const forged = `${token.slice(0, -4)}${token.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
    for (const t of ['not-a-token', forged, await fx.session('adminA', 'a')]) {
      const res = await call(t, 'content_update', update('a'));
      expect(res.status, t.slice(0, 8)).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    }
    expect(await snapshot()).toBe(before);
  });

  it('an expired token: 401, nothing changed', async () => {
    const { token, grant } = await pat('adminA', ['a'], ['read', 'content']);
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.agent_access', 'on', true)`);
      await tx.update(agentGrants).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(agentGrants.id, grant.id));
    });
    const before = await snapshot();
    expect((await call(token, 'content_update', update('a'))).status).toBe(401);
    expect(await snapshot()).toBe(before);
  });

  it('a revoked token: 401, nothing changed', async () => {
    const { token, grant } = await pat('adminA', ['a'], ['read', 'content']);
    expect(await access().revokeGrant(fx.users.adminA.id, grant.id)).toBe(true);
    const before = await snapshot();
    expect((await call(token, 'content_update', update('a'))).status).toBe(401);
    expect(await snapshot()).toBe(before);
  });

  it('insufficient scope (a tool group not granted): 403 insufficient_scope, nothing changed', async () => {
    const { token } = await pat('adminA', ['a'], ['read', 'content']);
    const before = await snapshot();
    const res = await call(token, 'site_update_seo_settings', { siteId: fx.sites.a, settings: { titleTemplate: 'x' }, expectedVersion: 1 });
    expect(res.status).toBe(403);
    expect(res.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(await snapshot()).toBe(before);
  });

  it('a token for site A naming site B (as siteId, in a plan scope or in perSite): refused, nothing changed', async () => {
    // adminA administers only A in the fixture; make the person an administrator of B too, so only the token limits it.
    const [adminRoleB] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, fx.sites.b), eq(roles.adminAccess, true))).limit(1);
    await db.insert(userSites).values({ userId: fx.users.adminA.id, siteId: fx.sites.b, roleId: adminRoleB!.id });
    const wide = await pat('adminA', ['b'], ['read']);
    expect((await call(wide.token, 'content_get', { siteId: fx.sites.b, collection: SHARED.collection, id: fx.items.b })).status).toBe(200);
    const { token } = await pat('adminA', ['a'], ['read', 'content', 'publish']);
    const before = await snapshot();
    expect((await call(token, 'content_update', update('b'))).status).toBe(403);
    expect((await call(token, 'content_publish', { siteId: fx.sites.b, collection: SHARED.collection, id: fx.items.b, expectedVersion: 1 })).status).toBe(403);
    const plan = await call(token, 'plans_submit', { scope: { siteIds: [fx.sites.b] }, operation: 'content_update', arguments: { collection: SHARED.collection, data: { title: 'x' } }, perSite: { [fx.sites.b]: { id: fx.items.b, expectedVersion: 1 } } });
    expect(plan.status).toBe(403);
    expect(await snapshot()).toBe(before);
  });

  it('a read-only token writing or publishing: refused, nothing changed', async () => {
    const { token } = await pat('adminA', ['a'], ['read']);
    const before = await snapshot();
    for (const [name, args] of [
      ['content_update', update('a')],
      ['content_publish', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a, expectedVersion: 1 }],
      ['content_create', { siteId: fx.sites.a, collection: SHARED.collection, data: { title: 'New', slug: 'ro-new' }, idempotencyKey: 'ro-1' }],
      ['content_delete', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a, expectedVersion: 1 }],
    ] as const) {
      expect((await call(token, name, args as Record<string, unknown>)).status, name).toBe(403);
    }
    expect(await snapshot()).toBe(before);
  });

  it('a foreign Origin is refused before authentication (403), the own origin and an allowed CORS origin pass', async () => {
    const { token } = await pat('adminA', ['a'], ['read', 'content']);
    const before = await snapshot();
    const evil = await call(token, 'content_update', update('a'), { origin: 'https://evil.example.net' });
    expect(evil.status).toBe(403);
    expect(evil.json).toMatchObject({ error: { code: -32003, data: { code: 'ORIGIN_NOT_ALLOWED' } } });
    // Loopback is no exception in production (DNS rebinding targets exactly that).
    expect((await call(token, 'content_get', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a }, { origin: 'http://localhost:3000' })).status).toBe(403);
    expect(await snapshot()).toBe(before);
    expect((await call(token, 'content_get', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a }, { origin: BASE })).status).toBe(200);
    expect((await call(token, 'content_get', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a }, { origin: 'https://studio.example.com' })).status).toBe(200);
  });

  it('another person cannot take over an operation identifier: a plan id, or an idempotency key', async () => {
    // Two people on site A, each with an own token.
    const mine = await pat('adminA', ['a'], ['read', 'content']);
    const theirs = await pat('both', ['a'], ['read', 'content']);
    const submitted = await call(mine.token, 'plans_submit', { scope: { siteIds: [fx.sites.a] }, operation: 'content_update', arguments: { collection: SHARED.collection, data: { title: 'Mine' } }, perSite: { [fx.sites.a]: { id: fx.items.a, expectedVersion: 1 } } });
    const planId = (submitted.json!.result!.structuredContent!.data as { id: string }).id;
    const created = await call(mine.token, 'content_create', { siteId: fx.sites.a, collection: SHARED.collection, data: { title: 'Mine', slug: 'takeover-mine' }, idempotencyKey: 'shared-key-1' });
    const myItem = (created.json!.result!.structuredContent!.data as { id: string }).id;
    const before = await snapshot();
    const [planBefore] = await db.select().from(batchPlans).where(eq(batchPlans.id, planId));

    // Reading or revising the plan as the other person: not found, the plan is unchanged.
    expect((await call(theirs.token, 'plans_get', { scope: { planId } })).json!.result!.structuredContent!.code).toBe('PLAN_NOT_FOUND');
    const revise = await call(theirs.token, 'plans_revise', { scope: { planId }, arguments: { collection: SHARED.collection, data: { title: 'Theirs' } } });
    expect(revise.json!.result!.structuredContent!.code).toBe('PLAN_NOT_FOUND');
    const [planAfter] = await db.select().from(batchPlans).where(eq(batchPlans.id, planId));
    expect(planAfter).toEqual(planBefore);
    expect(await snapshot()).toBe(before);

    // The same idempotency key from the other person is theirs alone: never a replay of my item.
    const replay = await call(theirs.token, 'content_create', { siteId: fx.sites.a, collection: SHARED.collection, data: { title: 'Mine', slug: 'takeover-theirs' }, idempotencyKey: 'shared-key-1' });
    const out = replay.json!.result!.structuredContent!;
    expect(JSON.stringify(out)).not.toContain(myItem);
    const [mineRow] = await db.select({ title: sql<string>`${items.data}->>'title'`, userCreated: items.userCreated }).from(items).where(eq(items.id, myItem));
    expect(mineRow).toEqual({ title: 'Mine', userCreated: fx.users.adminA.id });
  });

  it('error output carries no secret or internal configuration', async () => {
    const { token } = await pat('adminA', ['a'], ['read', 'content']);
    const answers = [
      await post('{"broken', bearer(token)),
      await call(token, 'content_update', update('b')),
      await call(token, 'content_get', { siteId: fx.sites.a, collection: 'no_such_collection', id: 'x' }),
      await call(token, 'content_update', { ...update('a'), expectedVersion: 999 }),
      await call(token, 'no_such_tool', {}),
      await call(`${token}x`, 'content_get', {}),
      await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, bearer(token, { origin: 'https://evil.example.net' })),
    ];
    const secrets = [token, JWT_SECRET, String(process.env.DATABASE_URL ?? '\u0000none'), String(process.env.DATABASE_OWNER_URL ?? '\u0000none')];
    for (const a of answers) {
      const text = a.text + JSON.stringify([...a.headers.entries()]);
      for (const s of secrets) expect(text.includes(s)).toBe(false);
      expect(text).not.toMatch(/postgres(ql)?:\/\/|password|stack|at \S+ \(|\.ts:\d+|node_modules|SELECT |INSERT /i);
    }
  });

  it('language scope (site-scope): an agent edits the zh-CN member; the English member of the same translation group is untouched', async () => {
    const svc = new ItemService({ db, siteId: fx.sites.a });
    const zh = (await svc.create(SHARED.collection, { data: { title: '中文版', slug: 'lang-scope', locale: 'zh-CN' } })) as { id: string; version: number };
    const [en] = await db.select().from(items).where(eq(items.id, fx.items.a));
    // A group and its members in one transaction (the group's site list is checked at commit).
    await db.transaction(async (tx) => {
      const [group] = await tx.insert(translationGroups).values({ siteId: fx.sites.a, siteIds: [fx.sites.a], sourceItemId: en!.id }).returning();
      await tx.insert(translationGroupMembers).values([
        { itemId: en!.id, groupId: group!.id, siteId: fx.sites.a, collectionId: en!.collectionId, locale: 'en', role: 'source' },
        { itemId: zh.id, groupId: group!.id, siteId: fx.sites.a, collectionId: en!.collectionId, locale: 'zh-CN' },
      ]);
    });
    const { token } = await pat('adminA', ['a'], ['read', 'content']);
    const res = await call(token, 'content_update', { siteId: fx.sites.a, collection: SHARED.collection, id: zh.id, expectedVersion: zh.version, data: { title: '中文版（Agent 修改）' } });
    expect(res.json!.result!.isError, JSON.stringify(res.json)).toBe(false);
    const [enAfter] = await db.select().from(items).where(eq(items.id, en!.id));
    expect({ version: enAfter!.version, data: enAfter!.data }).toEqual({ version: en!.version, data: en!.data });
    const [zhAfter] = await db.select({ title: sql<string>`${items.data}->>'title'` }).from(items).where(eq(items.id, zh.id));
    expect(zhAfter!.title).toBe('中文版（Agent 修改）');
  });

  it('an API key cannot draft a plan or create sites, and a plan item for an unauthorized site stays out', async () => {
    const before = await snapshot();
    const key = fx.apiKeys.aEditor.token;
    const plan = await call(key, 'plans_submit', { scope: { siteIds: [fx.sites.a] }, operation: 'content_update', arguments: { collection: SHARED.collection, data: { title: 'x' } }, perSite: { [fx.sites.a]: { id: fx.items.a, expectedVersion: 1 } } });
    expect([403]).toContain(plan.status);
    const site = await call(key, 'sites_create', { scope: { instance: true }, id: 'p10ms-new', name: 'New', idempotencyKey: 'k1' });
    expect(site.status).toBe(403);
    expect(await snapshot()).toBe(before);
    const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(items).where(and(eq(items.siteId, fx.sites.a)));
    expect(count!.n).toBeGreaterThan(0);
  });
});
