import { SignJWT } from 'jose';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { auditLog, authSessions, collections, deletedSiteIds, fields, relations, roles, siteContentSettings, siteDomains, sitePresets, sites, siteThemes, userSites, users, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { TOKEN_AUDIENCE } from '../services/auth/token-audience';
import { createLoginSession } from '../services/auth/login-sessions';
import { siteExistsKey } from '../services/domains/site-exists-cache';
import { HOST_CACHE_TTL_SECONDS, hostKey } from '../services/domains/host-cache';
import { SchemaService } from '../services/schema-service';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Creating a site and its first grant (HeoPress P07 task 0.1; spec sites/site-provisioning "建站与首次授权"),
 * through the whole app: the instance administrator creates a site and can administer it at once —
 * domains, themes, roles — with no database write of their own; a site's administrator cannot create
 * sites; a failure half-way leaves nothing; no one else gains anything.
 *
 * Tokens for the new site carry no development flag: the site-admin checks run against the real
 * membership, not the development shortcut.
 */

const JWT_SECRET = 'site-provisioning-secret';
const PREFIX = 'sprov';
const NEW_SITE = 'site_p07_provisioned';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
/** Every site-owned table creating a site writes: each row must be written in the new site's own scope. */
const SCOPED = ['lumibase_roles', 'lumibase_user_sites', 'lumibase_collections', 'lumibase_fields', 'lumibase_relations', 'lumibase_site_content_settings', 'lumibase_site_presets'];

describe.skipIf(!hasDbIntegrationUrl)('site provisioning — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  /** The database's bootstrap administrator (there is only one; the fixture creates it when there is none). */
  let bootstrapId = '';

  beforeAll(async () => {
    db = await connectDbIntegration('site-provisioning');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, NEW_SITE));
    fx = await createCrossSiteFixture(db, { prefix: PREFIX, jwtSecret: JWT_SECRET });
    bootstrapId = (await db.select({ id: users.id }).from(users).where(eq(users.isBootstrap, true)).limit(1))[0]!.id;
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    await db?.delete(sites).where(eq(sites.id, NEW_SITE));
    if (fx) await fx.teardown();
  });

  /** A Studio session of `userId` on `siteId`, as `/auth/login` would sign it (no development flag). */
  const sessionOn = async (userId: string, siteId: string, roleClaims: string[], audience: string = TOKEN_AUDIENCE.studio) => {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    const login = await createLoginSession(db, { userId, mfaVerified: false, amr: ['pwd'], source: 'password' });
    await db.update(authSessions).set({ expiresAt: new Date(Date.now() + 86_400_000) }).where(eq(authSessions.id, login.id));
    const token = await new SignJWT({ userId, email: u!.email, roles: roleClaims, siteId, tokenVersion: 0, sid: login.id, authTime: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
    return { 'content-type': 'application/json', 'x-heopress-site': siteId, authorization: `Bearer ${token}` };
  };
  /** The instance administrator (the bootstrap user, `roles: ['admin']` as login gives it), signed in on `siteId`. */
  const asBootstrap = (siteId: string) => sessionOn(bootstrapId, siteId, ['admin']);
  const call = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  /** Whether the shared cache (PostgreSQL, P03) holds a live entry under `key`. */
  const cached = async (key: string) =>
    ((await db.execute(sql`SELECT 1 FROM lumibase_cache_entries WHERE key = ${key} AND (expires_at IS NULL OR expires_at > now())`)) as unknown as unknown[]).length > 0;
  const audits = async (event: string) =>
    (await db.select({ e: auditLog.event }).from(auditLog).where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, event)))).length;
  const codeOf = async (res: Response) => ((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code;

  it('the instance administrator creates a site and administers it at once: domains, themes, roles', async () => {
    // Signed in on site A, where the bootstrap administrator has no membership: none is needed (instance control plane).
    expect(await db.select().from(userSites).where(and(eq(userSites.userId, bootstrapId), eq(userSites.siteId, fx.sites.a)))).toEqual([]);
    const createdBefore = await audits('site_created');
    const created = await call('/api/v1/instance/sites', 'POST', await asBootstrap(fx.sites.a), { id: NEW_SITE, name: 'Provisioned', defaultLanguage: 'zh-CN' });
    expect(created.status, await created.clone().text()).toBe(201);
    // Its preset, its roles and the creator's membership.
    expect((await db.select({ n: collections.name }).from(collections).where(eq(collections.siteId, NEW_SITE))).map((r) => r.n).sort()).toEqual(['articles', 'authors', 'categories', 'pages', 'tags']);
    const siteRoles = await db.select({ key: roles.systemKey, admin: roles.adminAccess }).from(roles).where(eq(roles.siteId, NEW_SITE));
    expect(siteRoles.sort((x, y) => String(x.key).localeCompare(String(y.key)))).toEqual([{ key: 'administrator', admin: true }, { key: 'member', admin: false }]);
    const [membership] = await db.select().from(userSites).where(and(eq(userSites.userId, bootstrapId), eq(userSites.siteId, NEW_SITE)));
    expect(membership?.roleId).toBe(await adminRoleOf(NEW_SITE));
    const [settings] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, NEW_SITE));
    expect(settings?.availableLocales).toEqual(['zh-CN']);

    // Signed in on the new site: what a site administrator does works — and takes effect.
    const there = await asBootstrap(NEW_SITE);
    const domain = await call('/api/v1/domains', 'POST', there, { kind: 'custom', hostname: 'provisioned.example.com' });
    expect(domain.status, await domain.clone().text()).toBe(201);
    expect(await db.select({ h: siteDomains.hostname }).from(siteDomains).where(eq(siteDomains.siteId, NEW_SITE))).toEqual([{ h: 'provisioned.example.com' }]);
    const theme = await call('/api/v1/themes/starters/minimal', 'POST', there);
    expect(theme.status, await theme.clone().text()).toBe(201);
    const versionId = ((await theme.json()) as { data: { id: string } }).data.id;
    expect((await call(`/api/v1/themes/versions/${versionId}/activate`, 'POST', there)).status).toBe(200);
    expect((await db.select({ v: siteThemes.themeVersionId }).from(siteThemes).where(eq(siteThemes.siteId, NEW_SITE)))[0]?.v).toBe(versionId);
    // A role for someone else: the member role, to a user of another site.
    const [member] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, NEW_SITE), eq(roles.systemKey, 'member')));
    const grant = await call(`/api/v1/roles/${member!.id}/users`, 'POST', there, { userId: fx.users.onlyA.id });
    expect(grant.status, await grant.clone().text()).toBe(201);
    expect((await db.select({ r: userSites.roleId }).from(userSites).where(and(eq(userSites.userId, fx.users.onlyA.id), eq(userSites.siteId, NEW_SITE))))[0]?.r).toBe(member!.id);
    // Audited in the site the creator was signed in on.
    expect(await audits('site_created')).toBe(createdBefore + 1);
    // It is in the creator's site list.
    const mine = (await (await call('/api/v1/auth/sites', 'GET', there)).json()) as { data: Array<{ id: string }>; meta: { canCreateSites: boolean } };
    expect(mine.data.map((s) => s.id)).toContain(NEW_SITE);
    expect(mine.meta.canCreateSites).toBe(true);

    // Reverse: on a site with an Administrator role but no membership of theirs, the same requests are
    // refused — the grant written with the site is what makes them work.
    expect(await db.select().from(userSites).where(and(eq(userSites.userId, bootstrapId), eq(userSites.siteId, fx.sites.b)))).toEqual([]);
    expect(await adminRoleOf(fx.sites.b)).toBeDefined();
    expect((await call('/api/v1/themes/starters/news', 'POST', await asBootstrap(fx.sites.b))).status).toBe(403);
  });

  it("a site's administrator, a member, an API key or a missing session cannot create or delete sites", async () => {
    const adminA = fx.headers('a', await fx.session('adminA', 'a'));
    const res = await call('/api/v1/instance/sites', 'POST', adminA, { id: NEW_SITE, name: 'Not allowed' });
    expect(res.status).toBe(403);
    expect(await codeOf(res)).toBe('FORBIDDEN');
    const memberA = fx.headers('a', await fx.session('onlyA', 'a'));
    expect((await call('/api/v1/instance/sites', 'POST', memberA, { id: NEW_SITE, name: 'x' })).status).toBe(403);
    expect((await call(`/api/v1/instance/sites/${fx.sites.b}`, 'DELETE', memberA)).status).toBe(403);
    expect((await call('/api/v1/instance/sites', 'POST', fx.headers('a', fx.apiKeys.aEditor.token), { id: NEW_SITE, name: 'x' })).status).toBeGreaterThanOrEqual(401);
    expect((await call('/api/v1/instance/sites', 'POST', { 'content-type': 'application/json', 'x-heopress-site': fx.sites.a }, { id: NEW_SITE, name: 'x' })).status).toBeGreaterThanOrEqual(401);
    // The bootstrap administrator's session minted for the public site (frontend audience) holds no instance capability.
    const frontend = await sessionOn(bootstrapId, fx.sites.a, ['admin'], TOKEN_AUDIENCE.frontend);
    const refused: Array<[string, Record<string, string>]> = [
      ['frontend audience', frontend],
      ['API key', fx.headers('a', fx.apiKeys.aEditor.token)],
      ['development token', fx.headers('a', 'dev:boot@example.test:admin')],
      ['no session', { 'content-type': 'application/json', 'x-heopress-site': fx.sites.a }],
    ];
    for (const [who, h] of refused) {
      expect((await call('/api/v1/instance/sites', 'POST', h, { id: NEW_SITE, name: 'x' })).status, `POST ${who}`).toBeGreaterThanOrEqual(401);
      expect((await call(`/api/v1/instance/sites/${fx.sites.b}`, 'DELETE', h)).status, `DELETE ${who}`).toBeGreaterThanOrEqual(401);
    }
    expect(await db.select({ id: sites.id }).from(sites).where(eq(sites.id, fx.sites.b))).toHaveLength(1);
    expect(await db.select().from(sites).where(eq(sites.id, NEW_SITE))).toEqual([]);
    // Deleting another site: refused for a site administrator (the old route only checked the request's site).
    expect((await call(`/api/v1/instance/sites/${fx.sites.b}`, 'DELETE', adminA)).status).toBe(403);
    expect(await db.select({ id: sites.id }).from(sites).where(eq(sites.id, fx.sites.b))).toHaveLength(1);
    expect(((await (await call('/api/v1/auth/sites', 'GET', adminA)).json()) as { meta: { canCreateSites: boolean } }).meta.canCreateSites).toBe(false);
  });

  it('validation and conflicts are answered before anything is written', async () => {
    const h = await asBootstrap(fx.sites.a);
    for (const body of [{ id: 'Bad Id', name: 'x' }, { id: NEW_SITE, name: '' }, { id: NEW_SITE, name: 'x', defaultLanguage: 'not a language' }, {}]) {
      const res = await call('/api/v1/instance/sites', 'POST', h, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const dup = await call('/api/v1/instance/sites', 'POST', h, { id: fx.sites.b, name: 'Taken' });
    expect(dup.status).toBe(409);
    expect(await codeOf(dup)).toBe('CONFLICT');
    expect(await db.select().from(sites).where(eq(sites.id, NEW_SITE))).toEqual([]);
  });

  it('a failure half-way leaves no site, no preset, no roles and no membership', async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to inject the failure').toBeDefined();
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    try {
      await owner.unsafe(`
        CREATE OR REPLACE FUNCTION heopress_test_refuse_membership() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.site_id = '${NEW_SITE}' THEN RAISE EXCEPTION 'injected provisioning failure'; END IF;
          RETURN NEW;
        END $$`);
      await owner.unsafe(`CREATE TRIGGER heopress_test_refuse_membership BEFORE INSERT ON lumibase_user_sites FOR EACH ROW EXECUTE FUNCTION heopress_test_refuse_membership()`);
      const res = await call('/api/v1/instance/sites', 'POST', await asBootstrap(fx.sites.a), { id: NEW_SITE, name: 'Half made' });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      await owner.unsafe(`DROP TRIGGER IF EXISTS heopress_test_refuse_membership ON lumibase_user_sites`).catch(() => undefined);
      await owner.unsafe(`DROP FUNCTION IF EXISTS heopress_test_refuse_membership()`).catch(() => undefined);
      await owner.end({ timeout: 1 });
    }
    expect(await db.select().from(sites).where(eq(sites.id, NEW_SITE))).toEqual([]);
    expect(await db.select().from(collections).where(eq(collections.siteId, NEW_SITE))).toEqual([]);
    expect(await db.select().from(roles).where(eq(roles.siteId, NEW_SITE))).toEqual([]);
    expect(await db.select().from(userSites).where(eq(userSites.siteId, NEW_SITE))).toEqual([]);
  });

  it('no one else gains anything: other users do not list or reach the new site', async () => {
    expect((await call('/api/v1/instance/sites', 'POST', await asBootstrap(fx.sites.a), { id: NEW_SITE, name: 'Mine' })).status).toBe(201);
    for (const who of ['adminA', 'adminB', 'both'] as const) {
      const id = fx.users[who].id;
      expect(await db.select().from(userSites).where(and(eq(userSites.userId, id), eq(userSites.siteId, NEW_SITE)))).toEqual([]);
      const listed = (await (await call('/api/v1/auth/sites', 'GET', fx.headers('a', await fx.session(who === 'adminB' ? 'both' : who, 'a')))).json()) as { data: Array<{ id: string }> };
      expect(listed.data.map((s) => s.id)).not.toContain(NEW_SITE);
      // Their session addressed to the new site is refused.
      const res = await call('/api/v1/domains', 'GET', await sessionOn(id, NEW_SITE, ['member']));
      expect([401, 403]).toContain(res.status);
    }
    // Deleting it: the instance administrator only.
    expect((await call(`/api/v1/instance/sites/${NEW_SITE}`, 'DELETE', fx.headers('a', await fx.session('adminA', 'a')))).status).toBe(403);
    expect((await call(`/api/v1/instance/sites/${NEW_SITE}`, 'DELETE', await asBootstrap(fx.sites.a))).status).toBe(200);
    expect(await db.select().from(sites).where(inArray(sites.id, [NEW_SITE]))).toEqual([]);
  });

  it('role creation failing leaves nothing; every row is written in the new site\'s own scope', async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to inject the failure').toBeDefined();
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    try {
      // The scope check: a row of the new site written outside its scope fails the creation.
      await owner.unsafe(`
        CREATE OR REPLACE FUNCTION heopress_test_scope_check() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.site_id = '${NEW_SITE}' AND current_setting('app.site_id', true) IS DISTINCT FROM NEW.site_id THEN
            RAISE EXCEPTION 'written outside the site scope';
          END IF;
          RETURN NEW;
        END $$`);
      for (const t of SCOPED) {
        await owner.unsafe(`CREATE TRIGGER heopress_test_scope_check BEFORE INSERT ON ${t} FOR EACH ROW EXECUTE FUNCTION heopress_test_scope_check()`);
      }
      // As in production: the development mode of these suites skips setting the scope (rls-transaction.ts).
      const mode = process.env.HEOPRESS_ENV;
      process.env.HEOPRESS_ENV = 'production';
      try {
        const scoped = await call('/api/v1/instance/sites', 'POST', await asBootstrap(fx.sites.a), { id: NEW_SITE, name: 'Scoped' });
        expect(scoped.status, await scoped.clone().text()).toBe(201);
      } finally {
        if (mode === undefined) delete process.env.HEOPRESS_ENV;
        else process.env.HEOPRESS_ENV = mode;
      }
      await db.delete(sites).where(eq(sites.id, NEW_SITE));
      // Role creation refused: nothing remains.
      await owner.unsafe(`
        CREATE OR REPLACE FUNCTION heopress_test_refuse_role() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.site_id = '${NEW_SITE}' THEN RAISE EXCEPTION 'injected role failure'; END IF;
          RETURN NEW;
        END $$`);
      await owner.unsafe(`CREATE TRIGGER heopress_test_refuse_role BEFORE INSERT ON lumibase_roles FOR EACH ROW EXECUTE FUNCTION heopress_test_refuse_role()`);
      expect((await call('/api/v1/instance/sites', 'POST', await asBootstrap(fx.sites.a), { id: NEW_SITE, name: 'No roles' })).status).toBeGreaterThanOrEqual(500);
    } finally {
      for (const t of SCOPED) await owner.unsafe(`DROP TRIGGER IF EXISTS heopress_test_scope_check ON ${t}`).catch(() => undefined);
      await owner.unsafe(`DROP TRIGGER IF EXISTS heopress_test_refuse_role ON lumibase_roles`).catch(() => undefined);
      await owner.unsafe(`DROP FUNCTION IF EXISTS heopress_test_scope_check()`).catch(() => undefined);
      await owner.unsafe(`DROP FUNCTION IF EXISTS heopress_test_refuse_role()`).catch(() => undefined);
      await owner.end({ timeout: 1 });
    }
    expect(await db.select().from(sites).where(eq(sites.id, NEW_SITE))).toEqual([]);
    for (const table of [collections, fields, relations, roles, userSites, siteContentSettings, sitePresets]) {
      expect(await db.select().from(table).where(eq(table.siteId, NEW_SITE))).toEqual([]);
    }
  });

  it('deleting: a bad id 400, an unknown site 404; once deleted the site is unknown at once (no cached verdict) and its id remembered', async () => {
    const h = await asBootstrap(fx.sites.a);
    expect((await call('/api/v1/instance/sites/Bad%20Id', 'DELETE', h)).status).toBe(400);
    expect((await call('/api/v1/instance/sites/site_p07_never_existed', 'DELETE', h)).status).toBe(404);
    // Not the site one is signed in on (the record of the deletion stays in that site).
    const own = await call(`/api/v1/instance/sites/${fx.sites.a}`, 'DELETE', h);
    expect(own.status).toBe(409);
    expect(await codeOf(own)).toBe('SIGNED_IN_SITE');
    expect((await call('/api/v1/instance/sites', 'POST', h, { id: NEW_SITE, name: 'Short lived' })).status).toBe(201);
    // Requests to it are answered (and its existence cached).
    const there = await asBootstrap(NEW_SITE);
    expect((await call('/api/v1/domains', 'GET', there)).status).toBe(200);
    expect(await cached(siteExistsKey(NEW_SITE))).toBe(true);
    // An active host and a custom collection, with what caches hold of them.
    await db.insert(siteDomains).values({ siteId: NEW_SITE, hostname: 'short-lived.example.com', kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() });
    await new SchemaService({ db, siteId: NEW_SITE }).createCollection({ name: 'custom_things' } as never);
    const warmed = [hostKey('short-lived.example.com'), `schema:${NEW_SITE}:custom_things`, `typegen:${NEW_SITE}`];
    for (const key of warmed) await db.execute(sql`INSERT INTO lumibase_cache_entries (key, value) VALUES (${key}, '"stale"') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    const deletedBefore = await audits('site_deleted');
    expect((await call(`/api/v1/instance/sites/${NEW_SITE}`, 'DELETE', h)).status).toBe(200);
    expect(await audits('site_deleted')).toBe(deletedBefore + 1);
    // The cached verdict is gone with it.
    expect(await cached(siteExistsKey(NEW_SITE))).toBe(false);
    for (const key of warmed) expect(await cached(key), key).toBe(false);
    // Unknown at once: not answered from a cached "it exists" (the tenant guard itself says so).
    const after = await call('/api/v1/domains', 'GET', there);
    expect(after.status).toBe(404);
    expect(await codeOf(after)).toBe('TENANT_NOT_FOUND');
    // (The hold on its id is tested at the database boundary below: this test database exempts ids not
    // starting with "held-", its fixtures reuse ids.)
    // Created again under the same id: a fresh site, with nothing of the former one.
    expect((await call('/api/v1/instance/sites', 'POST', h, { id: NEW_SITE, name: 'Second life' })).status).toBe(201);
    expect(await db.select().from(siteDomains).where(eq(siteDomains.siteId, NEW_SITE))).toEqual([]);
    expect((await call('/api/v1/domains', 'GET', await asBootstrap(NEW_SITE))).status).toBe(200);
  });

  it('two deletions of each other\'s sites at once: one wins, the other is refused, and the winner\'s record is kept', async () => {
    // Three sites: A, B and a third, so neither deletion would remove the last one.
    const keeper = `${fx.sites.a}_keeper`;
    await db.insert(sites).values({ id: keeper, name: 'Keeper' }).onConflictDoNothing();
    try {
      const fromA = await asBootstrap(fx.sites.a);
      const fromB = await asBootstrap(fx.sites.b);
      const [aDeletesB, bDeletesA] = await Promise.all([
        call(`/api/v1/instance/sites/${fx.sites.b}`, 'DELETE', fromA),
        call(`/api/v1/instance/sites/${fx.sites.a}`, 'DELETE', fromB),
      ]);
      const statuses = [aDeletesB.status, bDeletesA.status].sort();
      // One deletion; the other refused — as an answer (its caller's site is gone: 409; its target gone: 404), not a failure.
      expect(statuses[0]).toBe(200);
      expect([404, 409]).toContain(statuses[1]);
      const survivor = aDeletesB.status === 200 ? fx.sites.a : fx.sites.b;
      const deleted = survivor === fx.sites.a ? fx.sites.b : fx.sites.a;
      expect(await db.select({ id: sites.id }).from(sites).where(eq(sites.id, survivor))).toHaveLength(1);
      expect(await db.select({ id: sites.id }).from(sites).where(eq(sites.id, deleted))).toHaveLength(0);
      // The record of the deletion is in the surviving site.
      const [rec] = await db.select({ m: auditLog.metadata }).from(auditLog).where(and(eq(auditLog.siteId, survivor), eq(auditLog.event, 'site_deleted')));
      expect(rec?.m).toMatchObject({ targetSiteId: deleted });
    } finally {
      await db.delete(sites).where(eq(sites.id, keeper));
    }
  });

  it('the hold is the database\'s: plain SQL as the application role cannot delete and re-create an id, nor opt out', async () => {
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const id = 'held-p07-sql';
    const codeOfDb = (e: unknown) => (e as { cause?: { code?: string } }).cause?.code ?? (e as { code?: string }).code;
    try {
      await owner`DELETE FROM lumibase_sites WHERE id = ${id}`;
      await owner`DELETE FROM lumibase_deleted_site_ids WHERE site_id = ${id}`;
      // What an older application instance or maintenance SQL would do: no application check involved.
      await db.insert(sites).values({ id, name: 'Plain SQL' });
      await db.delete(sites).where(eq(sites.id, id));
      const refused = (await db.insert(sites).values({ id, name: 'Too soon' }).catch((e: unknown) => e)) as { cause?: { message?: string } };
      expect(codeOfDb(refused)).toBe('23505');
      expect(refused.cause?.message).toMatch(/deleted less than 25 hours ago/);
      // No opting out: the setting an earlier version honoured is ignored, the records and the exemption are the owner's.
      const forged = await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL heopress.site_id_reuse = 'allowed'`);
        return tx.insert(sites).values({ id, name: 'Forged' }).catch((e: unknown) => e);
      }).catch((e: unknown) => e);
      expect(codeOfDb(forged)).toBe('23505');
      expect(codeOfDb(await db.delete(deletedSiteIds).where(eq(deletedSiteIds.siteId, id)).catch((e: unknown) => e))).toBe('42501');
      // Even with a grant left from an earlier installation: only the owner writes the records.
      const appRole = ((await db.execute(sql`SELECT current_user AS u`)) as unknown as Array<{ u: string }>)[0]!.u;
      await owner.unsafe(`GRANT INSERT, UPDATE, DELETE, TRUNCATE ON lumibase_deleted_site_ids, lumibase_site_id_reuse_exemption TO "${appRole}"`);
      try {
        const attempts = [
          sql`INSERT INTO lumibase_deleted_site_ids (site_id) VALUES ('held-p07-forged')`,
          sql`UPDATE lumibase_deleted_site_ids SET deleted_at = now() - interval '2 days' WHERE site_id = ${id}`,
          sql`DELETE FROM lumibase_deleted_site_ids WHERE site_id = ${id}`,
          sql`TRUNCATE lumibase_deleted_site_ids`,
          sql`INSERT INTO lumibase_site_id_reuse_exemption (singleton, except_prefix) VALUES (true, 'x') ON CONFLICT DO NOTHING`,
          sql`UPDATE lumibase_site_id_reuse_exemption SET except_prefix = 'x'`,
          sql`DELETE FROM lumibase_site_id_reuse_exemption`,
          sql`TRUNCATE lumibase_site_id_reuse_exemption`,
        ];
        for (const attempt of attempts) expect(codeOfDb(await db.execute(attempt).catch((e: unknown) => e))).toBe('42501');
      } finally {
        await owner.unsafe(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON lumibase_deleted_site_ids, lumibase_site_id_reuse_exemption FROM "${appRole}"`);
      }
      expect(codeOfDb(await db.execute(sql`INSERT INTO lumibase_site_id_reuse_exemption (singleton, except_prefix) VALUES (true, 'none-') ON CONFLICT (singleton) DO UPDATE SET except_prefix = 'none-'`).catch((e: unknown) => e))).toBe('42501');
      // A site's id cannot be changed into (or out of) a held one.
      await db.insert(sites).values({ id: `${id}-other`, name: 'Other' });
      expect(codeOfDb(await db.update(sites).set({ id }).where(eq(sites.id, `${id}-other`)).catch((e: unknown) => e))).toBe('23514');
      await db.delete(sites).where(eq(sites.id, `${id}-other`));
      // The hold ends after 25 hours — longer than the longest site cache (host mappings).
      expect(25 * 3600).toBeGreaterThan(HOST_CACHE_TTL_SECONDS);
      const held = async () => ((await db.execute(sql`SELECT public.heopress_site_id_held(${id}) AS held`)) as unknown as Array<{ held: boolean }>)[0]?.held;
      await owner`UPDATE lumibase_deleted_site_ids SET deleted_at = now() - interval '24.9 hours' WHERE site_id = ${id}`;
      expect(await held()).toBe(true);
      await owner`UPDATE lumibase_deleted_site_ids SET deleted_at = now() - interval '25.1 hours' WHERE site_id = ${id}`;
      expect(await held()).toBe(false);
      await db.insert(sites).values({ id, name: 'After the hold' });
    } finally {
      await owner`DELETE FROM lumibase_sites WHERE id IN (${id}, ${id + '-other'})`;
      await owner`DELETE FROM lumibase_deleted_site_ids WHERE site_id IN (${id}, ${id + '-other'})`;
      await owner.end({ timeout: 1 });
    }
  });

  it('a deletion and an insert of the same id at once: the insert waits for the deletion and is then refused', async () => {
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const one = postgres(dbIntegrationUrl!, { max: 1, onnotice: () => {} });
    const two = postgres(dbIntegrationUrl!, { max: 1, onnotice: () => {} });
    const id = 'held-p07-race';
    try {
      await owner`DELETE FROM lumibase_sites WHERE id = ${id}`;
      await owner`DELETE FROM lumibase_deleted_site_ids WHERE site_id = ${id}`;
      await one`INSERT INTO lumibase_sites (id, name) VALUES (${id}, 'Raced')`;
      const pid = (await two<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      let deleted!: () => void;
      const deletionRan = new Promise<void>((r) => (deleted = r));
      let commit!: () => void;
      const mayCommit = new Promise<void>((r) => (commit = r));
      // The deletion runs (its record written, uncommitted) and holds its transaction open until released.
      const deleting = one.begin(async (tx) => {
        await tx`DELETE FROM lumibase_sites WHERE id = ${id}`;
        deleted();
        await mayCommit;
      });
      await deletionRan;
      const inserting = two`INSERT INTO lumibase_sites (id, name) VALUES (${id}, 'Racer')`.then(
        () => 'inserted',
        (e: { code?: string }) => e.code,
      );
      // Barrier: the insert is in the database and waiting on the id's advisory lock before the deletion commits.
      let waiting = false;
      let barrierError: unknown = null;
      try {
        for (let i = 0; i < 200 && !waiting; i++) {
          waiting = (await owner`SELECT 1 FROM pg_stat_activity WHERE pid = ${pid} AND wait_event_type = 'Lock' AND wait_event = 'advisory'`).length > 0;
          if (!waiting) await new Promise((r) => setTimeout(r, 10));
        }
      } catch (err) {
        barrierError = err;
      }
      // Whatever happened above: release the deletion and let both finish before anything is closed.
      commit();
      const [deletion, insertion] = await Promise.allSettled([deleting, inserting]);
      if (barrierError) throw barrierError;
      expect(waiting, 'the insert waits on the advisory lock of the id').toBe(true);
      expect(deletion.status).toBe('fulfilled');
      expect(insertion.status === 'fulfilled' ? insertion.value : insertion.reason).toBe('23505');
      expect(await owner`SELECT 1 FROM lumibase_sites WHERE id = ${id}`).toHaveLength(0);
    } finally {
      await owner`DELETE FROM lumibase_sites WHERE id = ${id}`;
      await owner`DELETE FROM lumibase_deleted_site_ids WHERE site_id = ${id}`;
      await Promise.allSettled([owner.end({ timeout: 1 }), one.end({ timeout: 1 }), two.end({ timeout: 1 })]);
    }
  });

  it('TRUNCATE remembers the ids it removes', async () => {
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const id = 'held-p07-truncated';
    try {
      // Rolled back: the shared test database keeps its sites.
      await owner
        .begin(async (tx) => {
          await tx`INSERT INTO lumibase_sites (id, name) VALUES (${id}, 'Truncated')`;
          await tx`TRUNCATE lumibase_sites CASCADE`;
          expect(await tx`SELECT 1 FROM lumibase_deleted_site_ids WHERE site_id = ${id}`).toHaveLength(1);
          throw new Error('rollback');
        })
        .catch((e: Error) => {
          if (e.message !== 'rollback') throw e;
        });
    } finally {
      await owner.end({ timeout: 1 });
    }
  });

  it('a failed audit record fails the deletion: the site, and no remembered id', async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to inject the failure').toBeDefined();
    // An id the hold applies to here too ("held-"): had the deletion committed, its id would be remembered.
    const id = 'held-p07-audit';
    const owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    try {
      await owner`DELETE FROM lumibase_sites WHERE id = ${id}`;
      await owner`DELETE FROM lumibase_deleted_site_ids WHERE site_id = ${id}`;
      const h = await asBootstrap(fx.sites.a);
      expect((await call('/api/v1/instance/sites', 'POST', h, { id, name: 'Kept' })).status).toBe(201);
      await owner.unsafe(`
        CREATE OR REPLACE FUNCTION heopress_test_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.event = 'site_deleted' THEN RAISE EXCEPTION 'injected audit failure'; END IF;
          RETURN NEW;
        END $$`);
      await owner.unsafe(`CREATE TRIGGER heopress_test_refuse_audit BEFORE INSERT ON lumibase_audit_log FOR EACH ROW EXECUTE FUNCTION heopress_test_refuse_audit()`);
      try {
        expect((await call(`/api/v1/instance/sites/${id}`, 'DELETE', h)).status).toBeGreaterThanOrEqual(500);
      } finally {
        await owner.unsafe(`DROP TRIGGER IF EXISTS heopress_test_refuse_audit ON lumibase_audit_log`).catch(() => undefined);
        await owner.unsafe(`DROP FUNCTION IF EXISTS heopress_test_refuse_audit()`).catch(() => undefined);
      }
      expect(await db.select({ id: sites.id }).from(sites).where(eq(sites.id, id))).toHaveLength(1);
      expect(await owner`SELECT 1 FROM lumibase_deleted_site_ids WHERE site_id = ${id}`).toHaveLength(0);
    } finally {
      await owner`DELETE FROM lumibase_sites WHERE id = ${id}`;
      await owner`DELETE FROM lumibase_deleted_site_ids WHERE site_id = ${id}`;
      await owner.end({ timeout: 1 });
    }
  });

  async function adminRoleOf(siteId: string): Promise<string | undefined> {
    const [r] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, siteId), eq(roles.adminAccess, true))).limit(1);
    return r?.id;
  }
});
