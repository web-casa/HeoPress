import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { aiConversations, roles, sites, userSites, type Database } from '@heopress/database';
import app from '../index';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Privilege-escalation suite of the v1 security review (HeoPress P13 task 3.3, docs/reviews/v1-security.md).
 *
 * The route matrix walks **every route the app mounts** (`app.routes`), so a route added later is covered without
 * being listed here, with the principals of the cross-site fixture:
 *
 *   1. anonymous — every route that is not declared public below answers 401; no route answers 5xx to a malformed
 *      anonymous request;
 *   2. site A's session or API key addressing site B — refused (401/403) on every non-public route;
 *   3. an editor of site A — refused (401/403) on every write of the administration surface (roles, policies,
 *      access, API keys, users, settings, domains, storage, plugins, themes, schema, model providers, backups, …);
 *   4. a read-only API key of site A — no write succeeds anywhere.
 *
 * Path parameters are placeholders and bodies are `{}`: the matrix checks that the refusal comes from authentication
 * and authorization, before any resource lookup or validation could answer. The targeted scenarios below use real
 * ids and valid bodies: the instance control plane, self-promotion, the Copilot conversations of another person
 * (finding S-3), the revalidation endpoint that was public (finding S-1) and malformed bodies answered 400 (S-4).
 */

const JWT_SECRET = 'authz-route-matrix-secret';
// A preview origin, so preview links answer by permission rather than "not configured".
const ENV = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development', HEOPRESS_PREVIEW_ORIGIN: 'https://preview.example.test' } as unknown as Record<string, unknown>;

/**
 * Routes reachable without a session or API key, by design. Each answers by its own rule (a token in the path or
 * body, a signature, a shared secret, an internal-peer check, a one-time setup) or serves public data.
 */
const PUBLIC = new Set([
  // Liveness, readiness, version, metrics (off by default) and the public template helper.
  'GET /health',
  'GET /health/live',
  'GET /health/ready',
  'GET /metrics',
  'GET /api/v1/utils/health',
  'GET /api/v1/utils/version',
  'POST /api/v1/utils/render-template',
  'GET /api/v1/system/version',
  // Whether changes are paused for an upgrade (active, reason, since), so Studio can say why a save is refused.
  'GET /api/v1/system/maintenance',
  // Development-only playground; 404 in production (routes/test-auth.ts).
  'GET /test-auth',
  // Internal peers only: the certificate gate (private source address) and preview reads (shared secret).
  'GET /internal/tls/ask',
  'POST /internal/preview/resolve',
  'POST /internal/preview/asset',
  'POST /internal/preview/branch-exchange',
  'POST /internal/preview/branch-resolve',
  // First-run setup (404 once initialized) and account recovery for a locked-out operator (rate limited).
  'GET /api/v1/setup/state',
  'GET /api/v1/setup/capabilities',
  'POST /api/v1/setup/complete',
  'POST /api/v1/admin/security/recover',
  'POST /api/v1/admin/security/forgot-path',
  'POST /api/v1/admin/security/reset-password',
  // Plugin public endpoints on a site's own domain (forms checked against the site's origins, callbacks signed).
  'GET /_ext/:plugin/:endpoint',
  'POST /_ext/:plugin/:endpoint',
  'PUT /_ext/:plugin/:endpoint',
  'PATCH /_ext/:plugin/:endpoint',
  'DELETE /_ext/:plugin/:endpoint',
  // Signed webhooks and the OAuth callbacks bound to a single-use state.
  'POST /api/v1/deployments/webhook/:provider',
  'POST /api/v1/integrations/git/webhook/:provider/:siteId/:integrationId',
  'GET /api/v1/integrations/git/oauth/:provider/callback',
  // MCP authorization server (OAuth 2.1 + PKCE) and the MCP endpoint, which authenticates every request itself.
  'GET /.well-known/oauth-protected-resource',
  'GET /.well-known/oauth-protected-resource/api/v1/agents/mcp',
  'GET /.well-known/oauth-authorization-server',
  'GET /api/v1/oauth/authorize',
  'POST /api/v1/oauth/token',
  'POST /api/v1/oauth/revoke',
  'POST /api/v1/oauth/register',
  'GET /api/v1/agents/mcp',
  'POST /api/v1/agents/mcp',
  // Token-in-path surfaces: shares, unsubscribe links, upload tokens.
  'GET /api/v1/shares/:token',
  'GET /api/v1/email/unsubscribe',
  'POST /api/v1/email/unsubscribe',
  'PUT /api/v1/files/upload/:key',
  // Public delivery and page-view counting.
  'GET /api/v1/deliver/llms.txt/:site_id',
  'GET /api/v1/deliver/page/:site_id/:slug',
  'POST /api/v1/pageviews/:site_id/hit',
  // Sign-in, registration (subscriber role, inactive until verified) and password reset.
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/verify-email',
  'POST /api/v1/auth/resend-verification',
  'POST /api/v1/auth/forgot-password',
  'POST /api/v1/auth/reset-password',
  'POST /api/v1/auth/verify-totp',
  // Realtime: a short-lived ticket in the query; Flow webhook triggers: the flow's own secret.
  'GET /api/v1/realtime',
  'POST /api/v1/flows/:id/trigger',
]);

/** The administration surface: an editor's writes here are refused before anything else is looked at. */
const ADMIN_WRITE_PREFIXES = [
  'roles', 'policies', 'permissions', 'access', 'api-keys', 'users', 'teams', 'settings', 'admin', 'extensions',
  'plugins', 'domains', 'storage-profiles', 'notification-channels', 'webhooks', 'llm', 'studio', 'integrations/git',
  'cdc', 'retention', 'deployments', 'config', 'flows', 'email', 'utils/cache', 'utils/revalidate', 'themes',
  'collections', 'relations', 'redirects', 'transform-presets', 'ingest/providers', 'materialize', 'site',
  'schema-permissions', 'typegen',
].map((p) => new RegExp(`^/api/v1/${p.replace('/', '\\/')}(/|$)`));

/** Writes under those prefixes that are editors' work: link updates of the items they edit. */
const EDITOR_WRITES = new Set(['POST /api/v1/site/links/impact/:itemId/update-links']);

type Route = { method: string; path: string };

function mountedRoutes(): Route[] {
  const seen = new Set<string>();
  const out: Route[] = [];
  for (const r of app.routes) {
    if (r.method === 'ALL') continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: r.path });
  }
  return out;
}

const fill = (path: string) => path.replace(/:[A-Za-z_]+(\{[^}]*\})?\??/g, 'zz_authz_probe').replace(/\*/g, 'zz');
const key = (r: Route) => `${r.method} ${r.path}`;
const isWrite = (r: Route) => r.method !== 'GET';

describe.skipIf(!hasDbIntegrationUrl)('privilege escalation — route matrix and targeted scenarios (DB integration)', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let logins = 0;
  const routes = mountedRoutes();

  const send = async (r: Route, headers: Record<string, string>): Promise<number> => {
    const body = r.method === 'GET' || r.method === 'DELETE' ? undefined : '{}';
    const res = await app.request(fill(r.path), { method: r.method, headers, ...(body ? { body } : {}) }, ENV);
    await res.arrayBuffer();
    return res.status;
  };
  const call = (method: string, path: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, ENV);
  // A new login for every request: a refused `DELETE /me/sessions` or `/auth/logout` must not end the next one's.
  const session = async (user: 'onlyA' | 'adminA', site: 'a' | 'b' = 'a') => fx.session(user, site, { login: `m${logins++}` });
  const anon = () => ({ 'content-type': 'application/json', 'x-heopress-site': fx.sites.a });

  beforeAll(async () => {
    db = await connectDbIntegration('authz-route-matrix');
    fx = await createCrossSiteFixture(db, { prefix: 'azm', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    if (fx) await fx.teardown();
  });

  it('the matrix sees the whole surface, and every public declaration names a mounted route', () => {
    expect(routes.length).toBeGreaterThan(500);
    const mounted = new Set(routes.map(key));
    expect([...PUBLIC].filter((k) => !mounted.has(k))).toEqual([]);
  });

  it('anonymous: every route not declared public answers 401, and no route answers 5xx', async () => {
    const wrong: string[] = [];
    for (const r of routes) {
      const status = await send(r, anon());
      if (status >= 500) wrong.push(`${key(r)} → ${status}`);
      else if (!PUBLIC.has(key(r)) && status !== 401) wrong.push(`${key(r)} → ${status}`);
    }
    expect(wrong).toEqual([]);
  }, 300_000);

  it("site A's session and site A's API key, addressed to site B, are refused on every non-public route", async () => {
    const wrong: string[] = [];
    for (const r of routes) {
      if (PUBLIC.has(key(r))) continue;
      const viaSession = await send(r, fx.headers('b', await session('onlyA')));
      const viaKey = await send(r, fx.headers('b', fx.apiKeys.aEditor.token));
      if (![401, 403].includes(viaSession)) wrong.push(`session ${key(r)} → ${viaSession}`);
      if (![401, 403].includes(viaKey)) wrong.push(`api key ${key(r)} → ${viaKey}`);
    }
    expect(wrong).toEqual([]);
  }, 300_000);

  it("an editor of site A is refused on every write of the administration surface", async () => {
    const targets = routes.filter((r) => isWrite(r) && !PUBLIC.has(key(r)) && !EDITOR_WRITES.has(key(r)) && ADMIN_WRITE_PREFIXES.some((re) => re.test(r.path)));
    expect(targets.length).toBeGreaterThan(150);
    const wrong: string[] = [];
    for (const r of targets) {
      // Creating a site validates its body first; the scenario below sends a valid one.
      if (key(r) === 'POST /api/v1/instance/sites') continue;
      const status = await send(r, fx.headers('a', await session('onlyA')));
      if (![401, 403].includes(status)) wrong.push(`${key(r)} → ${status}`);
    }
    expect(wrong).toEqual([]);
  }, 300_000);

  it('a read-only API key of site A changes nothing: no write anywhere succeeds', async () => {
    const wrong: string[] = [];
    for (const r of routes) {
      if (!isWrite(r) || PUBLIC.has(key(r))) continue;
      const status = await send(r, fx.headers('a', fx.apiKeys.aReader.token));
      if (status < 300 || status >= 500) wrong.push(`${key(r)} → ${status}`);
    }
    expect(wrong).toEqual([]);
  }, 300_000);

  describe('targeted scenarios', () => {
    it('the instance control plane: neither an editor nor a site administrator creates or deletes sites', async () => {
      for (const user of ['onlyA', 'adminA'] as const) {
        const created = await call('POST', '/api/v1/instance/sites', fx.headers('a', await session(user)), { id: `azm-new-${user.toLowerCase()}`, name: 'New site' });
        expect(created.status, user).toBe(403);
        expect(await db.select().from(sites).where(eq(sites.id, `azm-new-${user.toLowerCase()}`))).toEqual([]);
        const deleted = await call('DELETE', `/api/v1/instance/sites/${fx.sites.b}`, fx.headers('a', await session(user)));
        expect(deleted.status, user).toBe(403);
      }
      expect(await db.select({ id: sites.id }).from(sites).where(eq(sites.id, fx.sites.b))).toHaveLength(1);
    });

    it('an editor cannot promote themselves: not through their membership, not through the role', async () => {
      const [adminRole] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, fx.sites.a), eq(roles.name, 'Administrator')));
      const membership = async () =>
        (await db.select({ roleId: userSites.roleId }).from(userSites).where(and(eq(userSites.siteId, fx.sites.a), eq(userSites.userId, fx.users.onlyA.id))))[0]!.roleId;
      const before = await membership();
      const self = fx.headers('a', await session('onlyA'));
      expect((await call('PATCH', `/api/v1/users/${fx.users.onlyA.id}`, self, { roleId: adminRole!.id })).status).toBe(403);
      expect((await call('POST', `/api/v1/roles/${adminRole!.id}/users`, fx.headers('a', await session('onlyA')), { userId: fx.users.onlyA.id })).status).toBe(403);
      expect((await call('POST', '/api/v1/api-keys', fx.headers('a', await session('onlyA')), { name: 'mine', roleId: adminRole!.id })).status).toBe(403);
      // An API key cannot mint another key, whatever role it names.
      expect((await call('POST', '/api/v1/api-keys', fx.headers('a', fx.apiKeys.aEditor.token), { name: 'child', roleId: adminRole!.id })).status).toBe(403);
      expect(await membership()).toBe(before);
    });

    it("Copilot conversations belong to their author: another member or an API key can neither list, read nor delete them (S-3)", async () => {
      const [mine] = await db.insert(aiConversations).values({ siteId: fx.sites.a, userId: fx.users.adminA.id, title: 'admin notes' }).returning({ id: aiConversations.id });
      const [keyOwned] = await db.insert(aiConversations).values({ siteId: fx.sites.a, userId: null, title: 'key conversation' }).returning({ id: aiConversations.id });
      const ids = async (headers: Record<string, string>) =>
        ((await (await call('GET', '/api/v1/ai/conversations', headers)).json()) as { data?: Array<{ id: string }> }).data?.map((r) => r.id) ?? [];

      expect(await ids(fx.headers('a', await session('adminA')))).toContain(mine!.id);
      expect(await ids(fx.headers('a', await session('onlyA')))).not.toContain(mine!.id);
      const keyList = await ids(fx.headers('a', fx.apiKeys.aReader.token));
      expect(keyList).not.toContain(mine!.id);
      expect(keyList).toContain(keyOwned!.id);

      for (const headers of [fx.headers('a', await session('onlyA')), fx.headers('a', fx.apiKeys.aReader.token)]) {
        expect((await call('GET', `/api/v1/ai/conversations/${mine!.id}/messages`, headers)).status).toBe(404);
        expect((await call('DELETE', `/api/v1/ai/conversations/${mine!.id}`, headers)).status).toBe(404);
      }
      expect(await db.select().from(aiConversations).where(eq(aiConversations.id, mine!.id))).toHaveLength(1);

      expect((await call('GET', `/api/v1/ai/conversations/${mine!.id}/messages`, fx.headers('a', await session('adminA')))).status).toBe(200);
      expect((await call('DELETE', `/api/v1/ai/conversations/${mine!.id}`, fx.headers('a', await session('adminA')))).status).toBe(204);
      expect(await db.select().from(aiConversations).where(eq(aiConversations.id, mine!.id))).toEqual([]);
      await db.delete(aiConversations).where(eq(aiConversations.id, keyOwned!.id));
    });

    it('revalidation is authenticated and for administrators only (S-1)', async () => {
      const body = { tags: ['home'] };
      expect((await call('POST', '/api/v1/utils/revalidate', anon(), body)).status).toBe(401);
      expect((await call('POST', '/api/v1/utils/revalidate', fx.headers('a', await session('onlyA')), body)).status).toBe(403);
      expect((await call('POST', '/api/v1/utils/revalidate', fx.headers('a', fx.apiKeys.aEditor.token), body)).status).toBe(403);
      const admin = await call('POST', '/api/v1/utils/revalidate', fx.headers('a', await session('adminA')), body);
      expect(admin.status, await admin.clone().text()).toBe(200);
      expect(((await admin.json()) as { data: { dispatched: number } }).data.dispatched).toBe(0);
      const tooMany = await call('POST', '/api/v1/utils/revalidate', fx.headers('a', await session('adminA')), { tags: Array.from({ length: 51 }, (_, i) => `t${i}`) });
      expect(tooMany.status).toBe(400);
    });

    it('a malformed body is a 400 with the issues, never a 500 (S-4)', async () => {
      const login = await call('POST', '/api/v1/auth/login', anon(), {});
      expect(login.status).toBe(400);
      expect(((await login.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('VALIDATION_ERROR');
      const team = await call('POST', '/api/v1/teams', fx.headers('a', await session('adminA')), { name: 42 });
      expect(team.status).toBe(400);
    });
  });
});
