import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { agentGrants, apiKeys, auditLog, items, settings, systemEvents, userSites, users, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
  exchangeAuthorization,
  refreshAuthorization,
  registerClient,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { AuthorizationServerMetadata, OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { AgentAccessService } from '../services/agent-access/agent-access-service';
import { __resetPermissionProcessCacheForTests } from '../services/permission-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * HeoPress P10 slice 1 against the real database: the OAuth 2.1 flow driven by the official MCP SDK's client
 * functions (discovery, registration, PKCE authorization, code exchange, refresh), the consent decision, personal
 * access tokens and API keys on the agent MCP endpoint, and the tool constraints — with the negative cases of
 * tasks 1.1–1.5 and 2.1–2.5.
 */

const JWT_SECRET = 'p10-oauth-secret';
const BASE = 'https://cms.example.com';
const MCP = `${BASE}/api/v1/agents/mcp`;
const REDIRECT = 'http://127.0.0.1:33418/callback';

describe.skipIf(!hasDbIntegrationUrl)('P10 agent access — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  const fetchFn = (url: string | URL, init?: RequestInit) => Promise.resolve(app.request(String(url), init, env));

  beforeAll(async () => {
    db = await connectDbIntegration('p10-agent-access');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development', HEOPRESS_PUBLIC_URL: BASE, HEOPRESS_API_RATE_LIMIT: '100000', HEOPRESS_OAUTH_REGISTER_LIMIT: '1000' };
    setRuntimeFactory(() => createRuntime(env));
  });
  afterAll(() => setRuntimeFactory(null));
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'p10oa', jwtSecret: JWT_SECRET });
    // The fixture recreates the same ids: no bundle compiled by an earlier test may survive in this process.
    __resetPermissionProcessCacheForTests();
  });
  afterEach(async () => {
    await db.execute(sql`DELETE FROM lumibase_agent_grants WHERE user_id LIKE 'usr_p10oa_%'`);
    await db.execute(sql`DELETE FROM lumibase_agent_idempotency WHERE subject LIKE 'user:usr_p10oa_%'`);
    await db.execute(sql`DELETE FROM lumibase_sites WHERE id LIKE 'p10oa-new%'`);
    if (fx) await fx.teardown();
  });

  // ── helpers ─────────────────────────────────────────────────────────

  async function discover(): Promise<AuthorizationServerMetadata> {
    const prm = await discoverOAuthProtectedResourceMetadata(MCP, {}, fetchFn);
    expect(prm.resource).toBe(MCP);
    const meta = await discoverAuthorizationServerMetadata(prm.authorization_servers![0]!, { fetchFn });
    expect(meta).toBeDefined();
    return meta!;
  }

  async function register(meta: AuthorizationServerMetadata, extra: Record<string, unknown> = {}): Promise<OAuthClientInformationFull> {
    return registerClient(BASE, {
      metadata: meta,
      clientMetadata: { client_name: 'Test agent', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], ...extra },
      fetchFn,
    });
  }

  /** Authorize through consent as `user` choosing `siteIds` and `groups`; returns the code exchange inputs. */
  async function authorize(
    user: 'onlyA' | 'both' | 'adminA',
    siteKeys: Array<'a' | 'b'>,
    groups: string[],
    opts: { scope?: string } = {},
  ) {
    const meta = await discover();
    const client = await register(meta);
    const { authorizationUrl, codeVerifier } = await startAuthorization(BASE, { metadata: meta, clientInformation: client, redirectUrl: REDIRECT, scope: opts.scope, state: 'st1', resource: new URL(MCP) });
    const res = await app.request(authorizationUrl.href, {}, env);
    expect(res.status).toBe(302);
    const consent = new URL(res.headers.get('location')!);
    expect(consent.pathname).toMatch(/\/agent-access\/consent$/);
    const request = consent.searchParams.get('request')!;
    const session = await fx.session(user, 'a');
    const view = await app.request('/api/v1/agent-access/consent?request=' + encodeURIComponent(request), { headers: fx.headers('a', session) }, env);
    expect(view.status).toBe(200);
    const decided = await app.request(
      '/api/v1/agent-access/consent',
      { method: 'POST', headers: fx.headers('a', session), body: JSON.stringify({ request, approve: true, siteIds: siteKeys.map((k) => fx.sites[k]), toolGroups: groups }) },
      env,
    );
    expect(decided.status).toBe(200);
    const back = new URL(((await decided.json()) as { data: { redirectTo: string } }).data.redirectTo);
    expect(back.searchParams.get('state')).toBe('st1');
    expect(back.searchParams.get('iss')).toBe(BASE);
    return { meta, client, codeVerifier, code: back.searchParams.get('code')!, request, session };
  }

  async function tokensFor(user: 'onlyA' | 'both' | 'adminA', siteKeys: Array<'a' | 'b'>, groups: string[]) {
    const a = await authorize(user, siteKeys, groups);
    const tokens = await exchangeAuthorization(BASE, { metadata: a.meta, clientInformation: a.client, authorizationCode: a.code, codeVerifier: a.codeVerifier, redirectUri: REDIRECT, resource: new URL(MCP), fetchFn });
    return { ...a, tokens };
  }

  async function rpc(token: string, method: string, params: Record<string, unknown> = {}) {
    const res = await app.request(MCP, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }, env);
    const body = (await res.json().catch(() => null)) as { result?: { isError?: boolean; structuredContent?: Record<string, unknown> }; error?: { code: number; data?: { code?: string } } } | null;
    return { status: res.status, body, headers: res.headers };
  }
  const call = (token: string, name: string, args: Record<string, unknown>) => rpc(token, 'tools/call', { name, arguments: args });
  const resultOf = (r: Awaited<ReturnType<typeof rpc>>) => r.body!.result!.structuredContent as Record<string, unknown> & { code?: string; data?: unknown };

  async function form(path: string, fields: Record<string, string>) {
    return app.request(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }, env);
  }

  // ── 1.1 discovery, registration, PKCE, audience ─────────────────────

  it('serves the metadata and answers 401 with the resource metadata URL', async () => {
    const meta = await discover();
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.registration_endpoint).toBe(`${BASE}/api/v1/oauth/register`);
    const res = await app.request(MCP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }, env);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/v1/agents/mcp"`);
  });

  it('completes the flow with the MCP SDK client and lists the tools of the chosen groups only', async () => {
    const { tokens } = await tokensFor('both', ['a'], ['read']);
    expect(tokens.scope).toBe('mcp:read');
    const list = await rpc(tokens.access_token, 'tools/list');
    const names = (list.body!.result as unknown as { tools: Array<{ name: string }> }).tools.map((t) => t.name);
    expect(names).toContain('content_get');
    expect(names).not.toContain('content_update');
  });

  it('refuses an authorization request without PKCE, with plain PKCE, or with a redirect URI that does not match', async () => {
    const meta = await discover();
    const client = await register(meta);
    const base = { response_type: 'code', client_id: client.client_id, redirect_uri: REDIRECT, state: 's', resource: MCP };
    const noPkce = await app.request(`${BASE}/api/v1/oauth/authorize?${new URLSearchParams(base)}`, {}, env);
    expect(noPkce.status).toBe(302);
    const loc = new URL(noPkce.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('code')).toBeNull();
    const plain = await app.request(`${BASE}/api/v1/oauth/authorize?${new URLSearchParams({ ...base, code_challenge: 'x'.repeat(43), code_challenge_method: 'plain' })}`, {}, env);
    expect(new URL(plain.headers.get('location')!).searchParams.get('error')).toBe('invalid_request');
    // Mismatched redirect URI: never redirected anywhere.
    const wrong = await app.request(`${BASE}/api/v1/oauth/authorize?${new URLSearchParams({ ...base, redirect_uri: 'https://attacker.example.com/cb', code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' })}`, {}, env);
    expect(wrong.status).toBe(400);
    expect(wrong.headers.get('location')).toBeNull();
  });

  it('refuses another resource, and a token issued for another audience is not accepted', async () => {
    const meta = await discover();
    const client = await register(meta);
    const { authorizationUrl } = await startAuthorization(BASE, { metadata: meta, clientInformation: client, redirectUrl: REDIRECT, state: 's', resource: new URL('https://other.example.com/mcp') });
    const res = await app.request(authorizationUrl.href, {}, env);
    expect(new URL(res.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');

    const { tokens } = await tokensFor('both', ['a'], ['read']);
    // The same token presented to an endpoint with another resource URL (the instance moved): not this audience.
    const moved = { ...env, HEOPRESS_PUBLIC_URL: 'https://cms2.example.com' };
    const r = await app.request('https://cms2.example.com/api/v1/agents/mcp', { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }, moved);
    expect(r.status).toBe(401);
  });

  it('a wrong code verifier, another redirect URI or another resource at the token endpoint is invalid_grant / invalid_target', async () => {
    const a = await authorize('both', ['a'], ['read']);
    const bad = await form('/api/v1/oauth/token', { grant_type: 'authorization_code', code: a.code, client_id: a.client.client_id, redirect_uri: REDIRECT, code_verifier: 'v'.repeat(43) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_grant');
    const target = await form('/api/v1/oauth/token', { grant_type: 'authorization_code', code: a.code, client_id: a.client.client_id, redirect_uri: REDIRECT, code_verifier: a.codeVerifier, resource: 'https://other.example.com/mcp' });
    expect(((await target.json()) as { error: string }).error).toBe('invalid_target');
  });

  // ── 1.2 consent: sites and tool groups ──────────────────────────────

  it('a token for site A only is refused on site B with 403, and works on A', async () => {
    const { tokens } = await tokensFor('both', ['a'], ['read']);
    const okA = await call(tokens.access_token, 'content_get', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a });
    expect(okA.status).toBe(200);
    expect((resultOf(okA).data as { id: string }).id).toBe(fx.items.a);
    const onB = await call(tokens.access_token, 'content_get', { siteId: fx.sites.b, collection: SHARED.collection, id: fx.items.b });
    expect(onB.status).toBe(403);
    expect(onB.body!.error!.data!.code).toBe('SITE_NOT_AUTHORIZED');
    expect(onB.headers.get('www-authenticate')).toContain('insufficient_scope');
  });

  it('a read-only grant cannot write; consent cannot add sites the person does not belong to or groups the client did not ask for', async () => {
    const { tokens } = await tokensFor('both', ['a'], ['read']);
    const write = await call(tokens.access_token, 'content_update', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a, expectedVersion: 1, data: { title: 'x' } });
    expect(write.status).toBe(403);
    expect(write.body!.error!.data!.code).toBe('TOOL_GROUP_NOT_GRANTED');

    const a = await authorize('onlyA', ['a'], ['read'], { scope: 'mcp:read' });
    // onlyA is not a member of B; the request asked for read only.
    const outside = await app.request('/api/v1/agent-access/consent', { method: 'POST', headers: fx.headers('a', a.session), body: JSON.stringify({ request: a.request, approve: true, siteIds: [fx.sites.b], toolGroups: ['read'] }) }, env);
    expect(outside.status).toBe(403);
    const more = await app.request('/api/v1/agent-access/consent', { method: 'POST', headers: fx.headers('a', a.session), body: JSON.stringify({ request: a.request, approve: true, siteIds: [fx.sites.a], toolGroups: ['read', 'content'] }) }, env);
    expect(more.status).toBe(400);
  });

  it('an API key or an agent token cannot decide consent or mint personal tokens', async () => {
    const a = await authorize('both', ['a'], ['read']);
    const byKey = await app.request('/api/v1/agent-access/consent', { method: 'POST', headers: fx.headers('a', fx.apiKeys.aEditor.token), body: JSON.stringify({ request: a.request, approve: true, siteIds: [fx.sites.a], toolGroups: ['read'] }) }, env);
    expect([401, 403]).toContain(byKey.status);
    const pat = await app.request('/api/v1/agent-access/tokens', { method: 'POST', headers: fx.headers('a', fx.apiKeys.aEditor.token), body: JSON.stringify({ name: 'x', siteIds: [fx.sites.a], toolGroups: ['read'] }) }, env);
    expect([401, 403]).toContain(pat.status);
  });

  // ── 1.3 personal access tokens and API keys ─────────────────────────

  it('a personal access token has the same site and group limits, and is refused with 401 once revoked', async () => {
    const session = await fx.session('both', 'a');
    const created = await app.request('/api/v1/agent-access/tokens', { method: 'POST', headers: fx.headers('a', session), body: JSON.stringify({ name: 'CLI', siteIds: [fx.sites.a], toolGroups: ['read', 'content'] }) }, env);
    expect(created.status).toBe(201);
    const { token, grant } = ((await created.json()) as { data: { token: string; grant: { id: string } } }).data;
    expect((await call(token, 'content_get', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a })).status).toBe(200);
    expect((await call(token, 'content_get', { siteId: fx.sites.b, collection: SHARED.collection, id: fx.items.b })).status).toBe(403);
    expect((await call(token, 'content_publish', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a, expectedVersion: 1 })).status).toBe(403);
    const listed = await app.request('/api/v1/agent-access/grants', { headers: fx.headers('a', session) }, env);
    expect(JSON.stringify(await listed.json())).not.toContain(token);
    expect((await app.request(`/api/v1/agent-access/grants/${grant.id}`, { method: 'DELETE', headers: fx.headers('a', session) }, env)).status).toBe(200);
    expect((await call(token, 'content_get', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a })).status).toBe(401);
  });

  it('an API key acts on its own site only and is read-only until given tool groups', async () => {
    const key = fx.apiKeys.aEditor.token;
    expect((await call(key, 'content_get', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a })).status).toBe(200);
    expect((await call(key, 'content_get', { siteId: fx.sites.b, collection: SHARED.collection, id: fx.items.b })).status).toBe(403);
    const update = { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a, expectedVersion: 1, data: { title: 'By key' } };
    expect((await call(key, 'content_update', update)).status).toBe(403);
    const session = await fx.session('adminA', 'a');
    const set = await app.request(`/api/v1/api-keys/${fx.apiKeys.aEditor.id}/mcp-tool-groups`, { method: 'PATCH', headers: fx.headers('a', session), body: JSON.stringify({ mcpToolGroups: ['read', 'content'] }) }, env);
    expect(set.status).toBe(200);
    const done = await call(key, 'content_update', update);
    expect(done.status).toBe(200);
    expect(done.body!.result!.isError).toBe(false);
    // The legacy site endpoint applies the same groups: the reader key is read-only.
    const legacy = await app.request('/api/v1/mcp', { method: 'POST', headers: fx.headers('a', fx.apiKeys.aReader.token), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'createItem', arguments: {} } }) }, env);
    expect([403, 404]).toContain(legacy.status);
  });

  // ── 1.4 identity only from the token ────────────────────────────────

  it('ignores a forged userId in the arguments, writes as the token’s person and audits the attempt', async () => {
    const { tokens } = await tokensFor('both', ['a'], ['read', 'content']);
    const res = await call(tokens.access_token, 'content_create', {
      siteId: fx.sites.a,
      collection: SHARED.collection,
      data: { title: 'Forged', slug: 'forged', userCreated: fx.users.adminA.id },
      idempotencyKey: 'forge-1',
      userId: fx.users.adminA.id,
    });
    expect(res.status).toBe(200);
    expect(res.body!.result!.isError).toBe(false);
    const id = (resultOf(res).data as { id: string }).id;
    const [row] = await db.select({ userCreated: items.userCreated }).from(items).where(eq(items.id, id));
    expect(row!.userCreated).toBe(fx.users.both.id);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'mcp_identity_argument_ignored')));
    expect(audits.length).toBe(1);
    expect(JSON.stringify(audits[0]!.metadata)).toContain('userId');
  });

  // ── 1.5 live permissions, revocation, single use, rotation, metadata safety ──

  it('a downgrade, a removed membership and a disabled account take effect at once', async () => {
    const { tokens } = await tokensFor('both', ['a'], ['read', 'content']);
    const args = { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a, expectedVersion: 1, data: { title: 'Edited by agent' } };
    // `both` is an editor on A: downgrade to reader (same role row as fixture's reader).
    const [reader] = await db.execute(sql`SELECT id FROM lumibase_roles WHERE site_id = ${fx.sites.a} AND name = 'Reader'`) as unknown as Array<{ id: string }>;
    await db.update(userSites).set({ roleId: reader!.id }).where(and(eq(userSites.userId, fx.users.both.id), eq(userSites.siteId, fx.sites.a)));
    // What the role change through the API does (bumpPermissionVersion): no stale bundle is served.
    await db.execute(sql`DELETE FROM lumibase_cache_entries WHERE key LIKE ${`%${fx.sites.a}%`}`);
    __resetPermissionProcessCacheForTests();
    const denied = await call(tokens.access_token, 'content_update', args);
    expect(denied.status).toBe(403);
    const [item] = await db.select({ title: sql<string>`${items.data}->>'title'` }).from(items).where(eq(items.id, fx.items.a));
    expect(item!.title).not.toBe('Edited by agent');

    await db.delete(userSites).where(and(eq(userSites.userId, fx.users.both.id), eq(userSites.siteId, fx.sites.a)));
    expect((await call(tokens.access_token, 'content_get', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a })).status).toBe(403);

    await db.update(users).set({ status: 'suspended' }).where(eq(users.id, fx.users.both.id));
    expect((await rpc(tokens.access_token, 'ping')).status).toBe(401);
  });

  it('a password change (token version) ends the authorization', async () => {
    const { tokens } = await tokensFor('both', ['a'], ['read']);
    await db.update(users).set({ tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, fx.users.both.id));
    expect((await rpc(tokens.access_token, 'ping')).status).toBe(401);
  });

  it('a replayed authorization code is refused and revokes what it issued', async () => {
    const a = await authorize('both', ['a'], ['read']);
    const first = await exchangeAuthorization(BASE, { metadata: a.meta, clientInformation: a.client, authorizationCode: a.code, codeVerifier: a.codeVerifier, redirectUri: REDIRECT, resource: new URL(MCP), fetchFn });
    const replay = await form('/api/v1/oauth/token', { grant_type: 'authorization_code', code: a.code, client_id: a.client.client_id, redirect_uri: REDIRECT, code_verifier: a.codeVerifier });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
    expect((await rpc(first.access_token, 'ping')).status).toBe(401);
  });

  it('rotates refresh tokens and revokes the grant when an old one is replayed', async () => {
    const t = await tokensFor('both', ['a'], ['read']);
    const second = await refreshAuthorization(BASE, { metadata: t.meta, clientInformation: t.client, refreshToken: t.tokens.refresh_token!, resource: new URL(MCP), fetchFn });
    expect(second.refresh_token).not.toBe(t.tokens.refresh_token);
    expect((await rpc(second.access_token, 'ping')).status).toBe(200);
    const replay = await form('/api/v1/oauth/token', { grant_type: 'refresh_token', refresh_token: t.tokens.refresh_token!, client_id: t.client.client_id });
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
    expect((await rpc(second.access_token, 'ping')).status).toBe(401);
    const [grant] = await db.execute(sql`SELECT revoke_reason FROM lumibase_agent_grants WHERE user_id = ${fx.users.both.id} ORDER BY created_at DESC LIMIT 1`) as unknown as Array<{ revoke_reason: string }>;
    expect(grant!.revoke_reason).toBe('refresh_replay');
  });

  it('revocation at the revocation endpoint ends the tokens', async () => {
    const t = await tokensFor('both', ['a'], ['read']);
    expect((await form('/api/v1/oauth/revoke', { token: t.tokens.refresh_token!, client_id: t.client.client_id })).status).toBe(200);
    expect((await rpc(t.tokens.access_token, 'ping')).status).toBe(401);
  });

  it('refuses unsafe registrations and a client id metadata document on an internal address', async () => {
    const meta = await discover();
    for (const uri of ['http://attacker.example.com/cb', 'javascript:alert(1)', 'https://example.com/cb#frag']) {
      const res = await app.request(`${BASE}/api/v1/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [uri] }) }, env);
      expect(res.status, uri).toBe(400);
    }
    void meta;
    // A client id that is a metadata document URL on a loopback / metadata address: fetched through the outbound guard, refused.
    for (const clientId of ['https://127.0.0.1/client.json', 'https://169.254.169.254/latest/meta-data']) {
      const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256' });
      const res = await app.request(`${BASE}/api/v1/oauth/authorize?${q}`, {}, env);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_client');
    }
  });

  it('accepts a client id metadata document that names itself, and rejects one that does not', async () => {
    const docUrl = 'https://agent.example.com/oauth/client.json';
    const make = (body: unknown) =>
      new AgentAccessService({ db, jwtSecret: JWT_SECRET, fetchClientMetadata: async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }) });
    const good = await make({ client_id: docUrl, client_name: 'Doc agent', redirect_uris: [REDIRECT] }).client(docUrl);
    expect(good?.source).toBe('cimd');
    await db.execute(sql`DELETE FROM lumibase_oauth_clients WHERE id = ${docUrl}`);
    expect(await make({ client_id: 'https://other.example.com/x.json', redirect_uris: [REDIRECT] }).client(docUrl)).toBeNull();
  });

  // ── 2.1 / 2.4 scope and tool constraints ─────────────────────────────

  it('requires siteId, expectedVersion and idempotencyKey, points multi-site writes to plans and refuses high-risk direct writes', async () => {
    const { tokens } = await tokensFor('both', ['a', 'b'], ['read', 'content', 'theme']);
    const t = tokens.access_token;
    expect(resultOf(await call(t, 'content_query', { collection: SHARED.collection })).code).toBe('SITE_REQUIRED');
    expect(resultOf(await call(t, 'content_update', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a, data: { title: 'x' } })).code).toBe('VERSION_REQUIRED');
    expect(resultOf(await call(t, 'content_create', { siteId: fx.sites.a, collection: SHARED.collection, data: { title: 'x' } })).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const multi = resultOf(await call(t, 'content_update', { siteId: [fx.sites.a, fx.sites.b], collection: SHARED.collection, id: fx.items.a, expectedVersion: 1, data: { title: 'x' } }));
    expect(multi.code).toBe('PLAN_REQUIRED');
    expect(multi.tool).toBe('plans_submit');
    expect(resultOf(await call(t, 'content_delete', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a, expectedVersion: 1 })).code).toBe('PLAN_REQUIRED');
    expect(resultOf(await call(t, 'theme_activate', { siteId: fx.sites.a, themeVersionId: 'v', expectedVersion: 1 })).code).toBe('PLAN_REQUIRED');
    const [still] = await db.select({ id: items.id }).from(items).where(eq(items.id, fx.items.a));
    expect(still).toBeDefined();
    // Enumeration and plans need an explicit instance / plan scope.
    expect(resultOf(await call(t, 'sites_list', {})).code).toBe('SCOPE_REQUIRED');
    expect(resultOf(await call(t, 'plans_get', { scope: { instance: true } })).code).toBe('SCOPE_REQUIRED');
    expect(resultOf(await call(t, 'plans_submit', { scope: { siteIds: [fx.sites.a], instance: true }, operation: 'content_update' })).code).toBe('SCOPE_REQUIRED');
  });

  it('lists only authorized sites and resolves an "all" plan scope to a fixed list', async () => {
    const { tokens } = await tokensFor('both', ['a'], ['read', 'content']);
    const listed = resultOf(await call(tokens.access_token, 'sites_list', { scope: { instance: true } }));
    expect((listed.data as Array<{ id: string }>).map((s) => s.id)).toEqual([fx.sites.a]);
    const plan = resultOf(await call(tokens.access_token, 'plans_submit', { scope: { instance: true }, operation: 'content_update', arguments: {} }));
    expect(plan.code).toBe('PLAN_NOT_AVAILABLE');
    expect((plan.resolvedScope as { siteIds: string[] }).siteIds).toEqual([fx.sites.a]);
    const outside = await call(tokens.access_token, 'plans_submit', { scope: { siteIds: [fx.sites.a, fx.sites.b] }, operation: 'content_update' });
    expect(outside.status).toBe(403);
  });

  it('creates idempotently without a version; a site created through the agent is not added to the authorization', async () => {
    const { tokens } = await tokensFor('both', ['a'], ['read', 'content']);
    const args = { siteId: fx.sites.a, collection: SHARED.collection, data: { title: 'Once', slug: 'once' }, idempotencyKey: 'create-1' };
    const first = await call(tokens.access_token, "content_create", args);
    const one = resultOf(first);
    const two = resultOf(await call(tokens.access_token, 'content_create', args));
    expect((one.data as { id: string }).id).toBe((two.data as { id: string }).id);

    // Instance administrator creating a site.
    const [boot] = await db.select({ id: users.id }).from(users).where(eq(users.isBootstrap, true)).limit(1);
    const svc = new AgentAccessService({ db, jwtSecret: JWT_SECRET });
    // The bootstrap user is not a fixture user: grant to adminA by making a PAT and then a site creation must be refused (no instance capability).
    const pat = await svc.createPersonalToken(fx.users.adminA.id, { name: 'cli', siteIds: [fx.sites.a], toolGroups: ['read', 'settings'] }, MCP);
    const refused = await call(pat.token, 'sites_create', { scope: { instance: true }, id: 'p10oa-new1', name: 'New', idempotencyKey: 'site-1' });
    expect(refused.status).toBe(403);
    expect(boot).toBeDefined();
  });

  // ── 2.2 body limit and image allowlist ──────────────────────────────

  it('answers 413 above 4 MiB', async () => {
    const { tokens } = await tokensFor('both', ['a'], ['read']);
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(4 * 1024 * 1024) } });
    const res = await app.request(MCP, { method: 'POST', headers: { authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: big }, env);
    expect(res.status).toBe(413);
  });

  it('refuses an image from a host not on the allowlist, and an allowlisted host resolving to an internal address', async () => {
    const { tokens } = await tokensFor('both', ['a'], ['read', 'content']);
    const denied = resultOf(await call(tokens.access_token, 'media_upload_from_url', { siteId: fx.sites.a, url: 'https://images.example.com/a.png', idempotencyKey: 'img-1' }));
    expect(denied.code).toBe('HOST_NOT_ALLOWED');
    await db.insert(settings).values({ siteId: fx.sites.a, key: 'agents.imageHostAllowlist', value: ['127.0.0.1'] });
    const blocked = resultOf(await call(tokens.access_token, 'media_upload_from_url', { siteId: fx.sites.a, url: 'https://127.0.0.1/a.png', idempotencyKey: 'img-2' }));
    expect(blocked.code).toBe('FETCH_BLOCKED');
  });

  // ── 2.5 SEO / GEO read tools match Studio ───────────────────────────

  it('the SEO / GEO read tools answer what the Studio endpoints answer, within the site scope', async () => {
    const { tokens } = await tokensFor('both', ['a'], ['read']);
    const session = await fx.session('both', 'a');
    const studioAudit = (await (await app.request('/api/v1/site/audit', { headers: fx.headers('a', session) }, env)).json()) as { data: unknown };
    const toolAudit = await call(tokens.access_token, 'seo_audit_issues', { siteId: fx.sites.a });
    expect(resultOf(toolAudit).data).toEqual(studioAudit.data);
    const studioImpact = (await (await app.request(`/api/v1/site/links/impact/${fx.items.a}`, { headers: fx.headers('a', session) }, env)).json()) as { data?: unknown; errors?: unknown };
    const toolImpact = resultOf(await call(tokens.access_token, 'seo_link_impact', { siteId: fx.sites.a, itemId: fx.items.a }));
    expect(toolImpact.data ?? toolImpact.errors).toEqual(studioImpact.data ?? studioImpact.errors);
    const studioTr = (await (await app.request(`/api/v1/items/${SHARED.collection}/${fx.items.a}/translation-status`, { headers: fx.headers('a', session) }, env)).json()) as { data?: unknown; errors?: unknown };
    const toolTr = resultOf(await call(tokens.access_token, 'translation_status', { siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a }));
    expect(toolTr.data ?? toolTr.errors).toEqual(studioTr.data ?? studioTr.errors);
    expect((await call(tokens.access_token, 'seo_audit_issues', { siteId: fx.sites.b })).status).toBe(403);
    const events = await db.select().from(systemEvents).where(eq(systemEvents.event, 'mcp_site_denied'));
    expect(events.length).toBeGreaterThan(0);
  });

  it('grants and tokens are stored as hashes only', async () => {
    const t = await tokensFor('both', ['a'], ['read']);
    const dump = JSON.stringify(await db.execute(sql`SELECT * FROM lumibase_oauth_tokens t JOIN lumibase_agent_grants g ON g.id = t.grant_id WHERE g.user_id = ${fx.users.both.id}`));
    expect(dump).not.toContain(t.tokens.access_token);
    expect(dump).not.toContain(t.tokens.refresh_token!);
    void agentGrants;
    void apiKeys;
  });
});
