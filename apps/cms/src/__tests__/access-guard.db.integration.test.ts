import { SignJWT } from 'jose';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, authSessions, policies, rolePolicies, roles, systemEvents, userPolicies, userSites, users, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { createLoginSession } from '../services/auth/login-sessions';
import { TOKEN_AUDIENCE } from '../services/auth/token-audience';
import { __resetPermissionProcessCacheForTests } from '../services/permission-service';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Who may change access, and every site keeps an administrator (HeoPress P07a tasks 11.2, 12.3, 12.4; spec
 * studio/settings, design §15).
 */

const JWT_SECRET = 'access-guard-secret';

describe.skipIf(!hasDbIntegrationUrl)('access changes — guard and records', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let bootstrap: { id: string; email: string };

  beforeAll(async () => {
    db = await connectDbIntegration('access-guard');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'accgrd', jwtSecret: JWT_SECRET });
    __resetPermissionProcessCacheForTests();
    const [b] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.isBootstrap, true)).limit(1);
    bootstrap = b!;
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const site = (k: 'a' | 'b') => fx.sites[k];
  async function bootstrapToken(k: 'a' | 'b'): Promise<string> {
    // The bootstrap administrator reaches the site through a time-limited administrator policy: enough for its
    // requests, never counted as one of the site's effective administrators by the guard.
    for (const key of ['a', 'b'] as const) {
      const [p] = await db
        .insert(policies)
        .values({ siteId: site(key), name: 'Instance', key: `accgrd-instance-${key}`, adminAccess: true, appAccess: true, validUntil: new Date(Date.now() + 86_400_000) })
        .onConflictDoNothing()
        .returning({ id: policies.id });
      if (p) await db.insert(userPolicies).values({ userId: bootstrap.id, siteId: site(key), policyId: p.id }).onConflictDoNothing();
    }
    const login = await createLoginSession(db, { userId: bootstrap.id, mfaVerified: false, amr: ['pwd'], source: 'password' });
    await db.update(authSessions).set({ expiresAt: new Date(Date.now() + 86_400_000) }).where(eq(authSessions.id, login.id));
    return new SignJWT({ userId: bootstrap.id, email: bootstrap.email, roles: ['admin'], siteId: site(k), tokenVersion: 0, sid: login.id, authTime: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(TOKEN_AUDIENCE.studio)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
  }
  const call = async (bearer: string, k: 'a' | 'b', method: string, path: string, body?: unknown) =>
    app.request(`/api/v1${path}`, { method, headers: fx.headers(k, bearer), body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const as = async (who: 'adminA' | 'adminB' | 'onlyA' | 'both', k: 'a' | 'b') => fx.session(who, k);
  const roleId = async (k: 'a' | 'b', name: string) => (await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, site(k)), eq(roles.name, name))))[0]!.id;
  const membership = async (userId: string, k: 'a' | 'b') => (await db.select().from(userSites).where(and(eq(userSites.userId, userId), eq(userSites.siteId, site(k)))))[0];
  const codeOf = async (res: Response) => ((await res.json()) as { errors?: Array<{ code: string; sites?: string[] }> }).errors?.[0];

  it('task 12.3: a site administrator cannot disable an account; the person keeps A and B', async () => {
    const res = await call(await as('adminA', 'a'), 'a', 'PATCH', `/users/${fx.users.both.id}`, { status: 'suspended' });
    expect(res.status).toBe(403);
    expect((await db.select({ s: users.status }).from(users).where(eq(users.id, fx.users.both.id)))[0]!.s).toBe('active');
    expect(await membership(fx.users.both.id, 'a')).toBeDefined();
    expect(await membership(fx.users.both.id, 'b')).toBeDefined();
  });

  it('task 12.4: the only administrator cannot demote or remove themselves', async () => {
    const editor = await roleId('a', 'Editor');
    const demote = await call(await as('adminA', 'a'), 'a', 'PATCH', `/users/${fx.users.adminA.id}`, { roleId: editor });
    expect(demote.status).toBe(409);
    expect(await codeOf(demote)).toMatchObject({ code: 'LAST_ADMIN', sites: [site('a')] });
    expect((await membership(fx.users.adminA.id, 'a'))!.roleId).toBe(await roleId('a', 'Administrator'));
    expect((await call(await as('adminA', 'a'), 'a', 'DELETE', `/users/${fx.users.adminA.id}`)).status).toBe(409);
  });

  it('task 12.4: two administrators removing each other at once — at most one succeeds', async () => {
    await db.update(userSites).set({ roleId: await roleId('a', 'Administrator') }).where(and(eq(userSites.userId, fx.users.onlyA.id), eq(userSites.siteId, site('a'))));
    const [x, y] = await Promise.all([
      call(await as('adminA', 'a'), 'a', 'DELETE', `/users/${fx.users.onlyA.id}`),
      call(await as('onlyA', 'a'), 'a', 'DELETE', `/users/${fx.users.adminA.id}`),
    ]);
    expect([x.status, y.status].filter((s) => s === 200)).toHaveLength(1);
    const admins = await db.select().from(userSites).where(and(eq(userSites.siteId, site('a')), eq(userSites.roleId, await roleId('a', 'Administrator'))));
    expect(admins).toHaveLength(1);
  });

  it('task 12.4: disabling and removing the last two at once — at most one succeeds', async () => {
    await db.update(userSites).set({ roleId: await roleId('a', 'Administrator') }).where(and(eq(userSites.userId, fx.users.onlyA.id), eq(userSites.siteId, site('a'))));
    const [x, y] = await Promise.all([
      call(await bootstrapToken('a'), 'a', 'PATCH', `/users/${fx.users.onlyA.id}`, { status: 'suspended' }),
      call(await as('onlyA', 'a'), 'a', 'DELETE', `/users/${fx.users.adminA.id}`),
    ]);
    expect([x.status, y.status].filter((s) => s === 200)).toHaveLength(1);
  });

  it('task 12.4: disabling the only administrator of two sites is refused, naming both', async () => {
    await db.update(userSites).set({ roleId: await roleId('b', 'Administrator') }).where(and(eq(userSites.userId, fx.users.both.id), eq(userSites.siteId, site('b'))));
    await db.update(userSites).set({ roleId: await roleId('a', 'Editor') }).where(and(eq(userSites.userId, fx.users.adminA.id), eq(userSites.siteId, site('a'))));
    await db.update(userSites).set({ roleId: await roleId('a', 'Administrator') }).where(and(eq(userSites.userId, fx.users.both.id), eq(userSites.siteId, site('a'))));
    await db.update(userSites).set({ roleId: await roleId('b', 'Editor') }).where(and(eq(userSites.userId, fx.users.adminB.id), eq(userSites.siteId, site('b'))));
    const res = await call(await bootstrapToken('a'), 'a', 'PATCH', `/users/${fx.users.both.id}`, { status: 'suspended' });
    expect(res.status).toBe(409);
    expect((await codeOf(res))!.sites!.sort()).toEqual([site('a'), site('b')].sort());
  });

  it('task 12.4: clearing the only admin role, deleting it, changing or deleting an admin policy, unlinking it — each refused', async () => {
    const admin = await roleId('a', 'Administrator');
    const token = await as('adminA', 'a');
    expect((await call(token, 'a', 'PATCH', `/roles/${admin}`, { adminAccess: false })).status).toBe(409);
    expect((await call(token, 'a', 'DELETE', `/roles/${admin}`)).status).toBe(409);
    // The administrator access now comes from a policy linked to the user only.
    const [policy] = await db.insert(policies).values({ siteId: site('a'), name: 'Admins', key: 'accgrd-admins', adminAccess: true, appAccess: true }).returning({ id: policies.id });
    await db.insert(userPolicies).values({ userId: fx.users.adminA.id, siteId: site('a'), policyId: policy!.id });
    await db.update(roles).set({ adminAccess: false }).where(eq(roles.id, admin));
    expect((await call(token, 'a', 'PATCH', `/policies/${policy!.id}`, { adminAccess: false })).status).toBe(409);
    expect((await call(token, 'a', 'DELETE', `/policies/${policy!.id}`)).status).toBe(409);
    expect((await call(token, 'a', 'DELETE', `/policies/${policy!.id}/users/${fx.users.adminA.id}`)).status).toBe(409);
    // A role policy works the same way.
    await db.insert(rolePolicies).values({ roleId: admin, policyId: policy!.id });
    await db.delete(userPolicies).where(eq(userPolicies.policyId, policy!.id));
    expect((await call(token, 'a', 'DELETE', `/roles/${admin}/policies/${policy!.id}`)).status).toBe(409);
  });

  it('task 12.4: when only a time-limited admin policy would remain, the change is refused', async () => {
    const admin = await roleId('a', 'Administrator');
    const [policy] = await db.insert(policies).values({ siteId: site('a'), name: 'Temp admins', key: 'accgrd-temp', adminAccess: true, appAccess: true, validUntil: new Date(Date.now() + 86_400_000) }).returning({ id: policies.id });
    await db.insert(userPolicies).values({ userId: fx.users.adminA.id, siteId: site('a'), policyId: policy!.id });
    expect((await call(await as('adminA', 'a'), 'a', 'PATCH', `/roles/${admin}`, { adminAccess: false })).status).toBe(409);
  });

  it('task 12.4: an import replacing everything without an administrator is refused as a whole', async () => {
    const token = await as('adminA', 'a');
    const exported = (await (await call(token, 'a', 'GET', '/access/export')).json()) as { data: { roles: Array<{ name: string; adminAccess: boolean }> } & Record<string, unknown> };
    const manifest = { ...exported.data, roles: exported.data.roles.filter((r) => !r.adminAccess) };
    for (const mode of ['replace-all', 'replace-managed']) {
      const res = await call(token, 'a', 'POST', `/access/import?mode=${mode}`, manifest);
      expect([400, 409]).toContain(res.status);
    }
    expect((await membership(fx.users.adminA.id, 'a'))!.roleId).toBe(await roleId('a', 'Administrator'));
  });

  it('task 11.2: member, role and policy changes each leave a site record; enabling and disabling an account a system event', async () => {
    const token = await as('adminA', 'a');
    const editor = await roleId('a', 'Editor');
    await call(token, 'a', 'PATCH', `/users/${fx.users.onlyA.id}`, { roleId: await roleId('a', 'Reader') });
    await call(token, 'a', 'PATCH', `/roles/${editor}`, { name: 'Writer' });
    const created = (await (await call(token, 'a', 'POST', '/policies', { name: 'Readers', appAccess: true })).json()) as { data: { id: string } };
    await call(token, 'a', 'DELETE', `/policies/${created.data.id}`);
    await call(token, 'a', 'DELETE', `/users/${fx.users.both.id}`);
    await new Promise((r) => setTimeout(r, 300));
    const events = await runSiteTransaction(db, site('a'), (tx) =>
      tx.select({ event: auditLog.event, metadata: auditLog.metadata }).from(auditLog).where(and(eq(auditLog.siteId, site('a')), sql`${auditLog.event} LIKE 'access_%'`)),
    );
    const names = events.map((e) => e.event);
    expect(names).toEqual(expect.arrayContaining(['access_member_changed', 'access_role_changed', 'access_policy_added', 'access_policy_removed', 'access_member_removed']));
    const roleChange = events.find((e) => e.event === 'access_role_changed')!.metadata as { before: { name: string }; after: { name: string } };
    expect(roleChange.before.name).toBe('Editor');
    expect(roleChange.after.name).toBe('Writer');
    // Spec ops/event-log "改角色": the member's record names who, the person, the former role and the new one.
    const memberChange = events.find((e) => e.event === 'access_member_changed')!.metadata as { actorId: string; before: { roleName: string; email: string }; after: { roleName: string } };
    expect(memberChange.actorId).toBeTruthy();
    expect(memberChange.before).toMatchObject({ roleName: 'Editor', email: fx.users.onlyA.email });
    expect(memberChange.after.roleName).toBe('Reader');

    const readSystem = () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT set_config('app.platform_reader', 'on', true)`);
        return tx.select({ id: systemEvents.id, event: systemEvents.event }).from(systemEvents).where(sql`${systemEvents.data}->>'userId' = ${fx.users.onlyA.id}`).orderBy(systemEvents.occurredAt);
      });
    const earlier = new Set((await readSystem()).map((e) => e.id));
    const res = await call(await bootstrapToken('a'), 'a', 'PATCH', `/users/${fx.users.onlyA.id}`, { status: 'suspended' });
    expect(res.status, await res.clone().text()).toBe(200);
    await call(await bootstrapToken('a'), 'a', 'PATCH', `/users/${fx.users.onlyA.id}`, { status: 'active' });
    const sys = (await readSystem()).filter((e) => !earlier.has(e.id));
    expect(sys.map((s) => s.event)).toEqual(['account_disabled', 'account_enabled']);
  });
});
