import postgres from 'postgres';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { authSessions, policies, refreshTokens, rolePolicies, roles, sites, userSites, users, type Database } from '@heopress/database';
import app from '../index';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';
import { issueRefreshToken, revokeRefreshToken, rotateRefreshToken } from '../services/auth/refresh-token';
import { createLoginSession, invalidateAllUserSessions } from '../services/auth/login-sessions';
import { listMySites, switchSite } from '../services/auth/site-switch';

/**
 * Site switching (HeoPress P04 task 9.8, spec sites/site-switching): the
 * site list and the exchange, through the whole app on the cross-site
 * fixture — one Studio-access decision (roles and policies, MFA,
 * bootstrap), identical denials, a session that only works on its site,
 * revocation that reaches the switched session even when it races the
 * switch — and the exchange under enforced row-level security.
 */

const JWT_SECRET = 'site-switch-test-secret';
const ENV = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' } as unknown as Record<string, unknown>;
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;

describe.skipIf(!hasDbIntegrationUrl)('site switching — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;

  beforeAll(async () => {
    db = await connectDbIntegration('site-switch');
  });
  beforeEach(async () => {
    await db.execute(sql`DELETE FROM lumibase_rate_limit_windows WHERE key LIKE 'rl:site-switch:%'`).catch(() => undefined);
    fx = await createCrossSiteFixture(db, { prefix: 'sws', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    if (fx) await fx.teardown();
  });

  type Who = 'onlyA' | 'onlyB' | 'both' | 'adminA';
  /** A real login on site A: login session, refresh token, access JWT (as /auth/login gives). */
  const signIn = async (who: Who, opts: { mfa?: boolean } = {}) => {
    const userId = fx.users[who].id;
    const session = await createLoginSession(db, { userId, mfaVerified: Boolean(opts.mfa), amr: opts.mfa ? ['pwd', 'totp'] : ['pwd'], source: 'password' });
    const refresh = await issueRefreshToken(db, { siteId: fx.sites.a, userId, audience: 'studio', sessionId: session.id, tokenVersion: 0 }, undefined);
    const access = await new SignJWT({ userId, email: fx.users[who].email, roles: [], siteId: fx.sites.a, tokenVersion: 0, sid: session.id, ...(opts.mfa ? { tfaVerified: true } : {}) })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('studio')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
    return { session, refresh: refresh.token, access };
  };
  const call = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, ENV);
  const sitesOf = async (access: string) => {
    const res = await call('/api/v1/auth/sites', 'GET', fx.headers('a', access));
    return { status: res.status, body: (await res.json()) as { data: Array<{ id: string; roleName: string | null; current: boolean; mfaRequired: boolean }> } };
  };
  const switchTo = (access: string, refreshToken: string, siteId: string) =>
    call('/api/v1/auth/switch-site', 'POST', fx.headers('a', access), { siteId, refreshToken });
  const itemOn = (site: 'a' | 'b', token: string) => call(`/api/v1/items/${SHARED.collection}/${fx.items[site]}`, 'GET', fx.headers(site, token));
  const patchOn = (site: 'a' | 'b', token: string) =>
    call(`/api/v1/items/${SHARED.collection}/${fx.items[site]}`, 'PATCH', fx.headers(site, token), { data: { title: 'switched' }, expectedVersion: 1 });

  it('lists the sites the person can use Studio on, with the role and the current site', async () => {
    const both = await signIn('both');
    const { status, body } = await sitesOf(both.access);
    expect(status).toBe(200);
    expect(body.data.map((s) => [s.id, s.roleName, s.current])).toEqual(
      expect.arrayContaining([
        [fx.sites.a, 'Editor', true],
        [fx.sites.b, 'Reader', false],
      ]),
    );
    expect(body.data).toHaveLength(2);
    expect((await sitesOf((await signIn('onlyA')).access)).body.data.map((s) => s.id)).toEqual([fx.sites.a]);
  });

  it('API keys and frontend sessions cannot list sites or switch', async () => {
    expect((await call('/api/v1/auth/sites', 'GET', fx.headers('a', fx.apiKeys.aEditor.token))).status).toBe(403);
    const both = await signIn('both');
    const frontend = await new SignJWT({ userId: fx.users.both.id, email: 'x', siteId: fx.sites.a, tokenVersion: 0, sid: both.session.id })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('frontend')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
    expect((await call('/api/v1/auth/sites', 'GET', fx.headers('a', frontend))).status).toBe(403);
    expect((await switchTo(frontend, both.refresh, fx.sites.b)).status).toBe(403);
  });

  it('the source site is checked too: losing Studio, or lacking MFA it now requires, there stops listing and switching (Codex P04-4 #2)', async () => {
    const both = await signIn('both');
    // Without the Studio client header: the endpoints check by themselves.
    await db.update(policies).set({ enforceTfa: true }).where(eq(policies.key, 'sws-a-editor'));
    let res = await call('/api/v1/auth/sites', 'GET', fx.headers('a', both.access));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('TFA_REQUIRED');
    expect((await switchTo(both.access, both.refresh, fx.sites.b)).status).toBe(403);
    await db.update(policies).set({ enforceTfa: false, appAccess: false }).where(eq(policies.key, 'sws-a-editor'));
    await db.update(roles).set({ appAccess: false }).where(eq(roles.siteId, fx.sites.a));
    res = await switchTo(both.access, both.refresh, fx.sites.b);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('APP_ACCESS_DENIED');
  });

  it('switching gives a session for the destination only, with its permissions', async () => {
    const both = await signIn('both');
    const res = await switchTo(both.access, both.refresh, fx.sites.b);
    expect(res.status, await res.clone().text()).toBe(200);
    const out = ((await res.json()) as { data: { token: string; refreshToken: string; sid: string; site: { id: string } } }).data;
    expect(out.sid).toBe(both.session.id);
    expect(out.site.id).toBe(fx.sites.b);
    expect(res.headers.get('set-cookie')).toBeNull(); // never the refresh cookie
    expect((await itemOn('b', out.token)).status).toBe(200);
    expect((await patchOn('b', out.token)).status).toBe(403); // a reader on B
    expect((await itemOn('a', out.token)).status).toBe(401); // B's token on A
    // B's refresh token renews on B, as a Studio session of the same login.
    const renewed = await rotateRefreshToken(db, { rawToken: out.refreshToken, siteId: fx.sites.b }, undefined);
    expect(renewed.ok && renewed.session.id).toBe(both.session.id);
    // The source was not rotated.
    expect((await rotateRefreshToken(db, { rawToken: both.refresh, siteId: fx.sites.a }, undefined)).ok).toBe(true);
  });

  it('not a member and no such site get the same answer, and no token', async () => {
    const onlyA = await signIn('onlyA');
    const notMember = await switchTo(onlyA.access, onlyA.refresh, fx.sites.b);
    const noSite = await switchTo(onlyA.access, onlyA.refresh, 'site_does_not_exist');
    expect(notMember.status).toBe(403);
    expect(noSite.status).toBe(403);
    expect(await notMember.json()).toEqual(await noSite.json());
    const issued = await db.select().from(refreshTokens).where(eq(refreshTokens.siteId, fx.sites.b));
    expect(issued.filter((r) => r.userId === fx.users.onlyA.id)).toEqual([]);
  });

  it('access granted only by a policy counts, also after a refresh', async () => {
    // onlyA joins B with a role that does not open Studio; a policy does.
    const [role] = await db.insert(roles).values({ siteId: fx.sites.b, name: 'Contributor', adminAccess: false, appAccess: false }).returning({ id: roles.id });
    const [policy] = await db
      .insert(policies)
      .values({ siteId: fx.sites.b, name: 'Studio via policy', key: 'sws-studio-policy', adminAccess: false, appAccess: true })
      .returning({ id: policies.id });
    await db.insert(rolePolicies).values({ roleId: role!.id, policyId: policy!.id });
    await db.insert(userSites).values({ userId: fx.users.onlyA.id, siteId: fx.sites.b, roleId: role!.id });
    const onlyA = await signIn('onlyA');
    expect((await sitesOf(onlyA.access)).body.data.map((s) => s.id)).toContain(fx.sites.b);
    const res = await switchTo(onlyA.access, onlyA.refresh, fx.sites.b);
    expect(res.status, await res.clone().text()).toBe(200);
    const out = ((await res.json()) as { data: { refreshToken: string } }).data;
    const refreshed = await call('/api/v1/auth/refresh', 'POST', { 'content-type': 'application/json', 'x-heopress-site': fx.sites.b }, { refreshToken: out.refreshToken });
    expect(refreshed.status).toBe(200);
    const token = ((await refreshed.json()) as { data: { token: string } }).data.token;
    const aud = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).aud;
    expect(aud).toBe('studio'); // not demoted to a frontend session
  });

  it('a destination that requires MFA refuses a login without it, and accepts one with it', async () => {
    await db.update(policies).set({ enforceTfa: true }).where(eq(policies.key, 'sws-b-reader'));
    const plain = await signIn('both');
    const res = await switchTo(plain.access, plain.refresh, fx.sites.b);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('MFA_REQUIRED');
    const mfa = await signIn('both', { mfa: true });
    expect((await switchTo(mfa.access, mfa.refresh, fx.sites.b)).status).toBe(200);
  });

  it('the bootstrap admin switches to a site without a membership', async () => {
    const [boot] = await db.select().from(users).where(eq(users.isBootstrap, true)).limit(1);
    const session = await createLoginSession(db, { userId: boot!.id, mfaVerified: false, amr: ['pwd'], source: 'password' });
    const refresh = await issueRefreshToken(db, { siteId: fx.sites.a, userId: boot!.id, audience: 'studio', sessionId: session.id, tokenVersion: boot!.tokenVersion }, undefined);
    const access = await new SignJWT({ userId: boot!.id, email: boot!.email, roles: ['admin'], siteId: fx.sites.a, tokenVersion: boot!.tokenVersion, sid: session.id })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience('studio')
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
    expect((await switchTo(access, refresh.token, fx.sites.b)).status).toBe(200);
  });

  it('after logout, a still-valid access token cannot switch', async () => {
    const both = await signIn('both');
    await revokeRefreshToken(db, both.refresh, fx.sites.a);
    expect((await switchTo(both.access, both.refresh, fx.sites.b)).status).toBe(401);
  });

  it('presenting an already rotated source token is reuse: refused, and the login ends', async () => {
    const both = await signIn('both');
    const next = await rotateRefreshToken(db, { rawToken: both.refresh, siteId: fx.sites.a }, undefined);
    if (!next.ok) throw new Error('rotation failed');
    expect((await switchTo(both.access, both.refresh, fx.sites.b)).status).toBe(401);
    const [session] = await db.select().from(authSessions).where(eq(authSessions.id, both.session.id));
    expect(session!.revokeReason).toBe('reuse');
    expect((await rotateRefreshToken(db, { rawToken: next.token, siteId: fx.sites.a }, undefined)).ok).toBe(false);
  });

  it("the refresh token must belong to the same login as the access token", async () => {
    const first = await signIn('both');
    const second = await signIn('both');
    expect((await switchTo(first.access, second.refresh, fx.sites.b)).status).toBe(401);
  });

  it('a logout or a password change racing the switch never leaves a usable destination session', async () => {
    for (const revoke of ['logout', 'password'] as const) {
      await db.update(users).set({ tokenVersion: 0 }).where(eq(users.id, fx.users.both.id));
      const both = await signIn('both');
      const [res] = await Promise.all([
        switchTo(both.access, both.refresh, fx.sites.b),
        revoke === 'logout' ? revokeRefreshToken(db, both.refresh, fx.sites.a) : invalidateAllUserSessions(db, fx.users.both.id, 'password_changed'),
      ]);
      if (res.status === 200) {
        const out = ((await res.json()) as { data: { token: string; refreshToken: string } }).data;
        expect((await itemOn('b', out.token)).status).toBe(401);
        expect((await rotateRefreshToken(db, { rawToken: out.refreshToken, siteId: fx.sites.b }, undefined)).ok).toBe(false);
      } else {
        expect([401, 403]).toContain(res.status);
      }
    }
  });

  it('switching is rate-limited per person', async () => {
    const both = await signIn('both');
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await switchTo(both.access, both.refresh, 'site_does_not_exist')).status;
    expect(last).toBe(429);
  });

  describe.skipIf(!OWNER_URL)('under enforced row-level security', () => {
    const RLS_TABLES = ['lumibase_refresh_tokens', 'lumibase_roles', 'lumibase_policies', 'lumibase_permissions', 'lumibase_audit_log'];
    let owner: postgres.Sql;
    const setRls = async (on: boolean) => {
      for (const t of RLS_TABLES) {
        if (on) {
          await owner.unsafe(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
          await owner.unsafe(`DROP POLICY IF EXISTS site_isolation ON ${t}`);
          await owner.unsafe(`CREATE POLICY site_isolation ON ${t} USING (site_id = NULLIF(current_setting('app.site_id', true), '')) WITH CHECK (site_id = NULLIF(current_setting('app.site_id', true), ''))`);
        } else {
          await owner.unsafe(`DROP POLICY IF EXISTS site_isolation ON ${t}`);
          await owner.unsafe(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`);
        }
      }
    };
    beforeAll(() => {
      owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    });
    afterAll(async () => {
      await setRls(false).catch(() => undefined);
      await owner?.end({ timeout: 1 });
    });

    it('logout on B and a switch A→C, in either order or at once: no usable C session is left (spec "换发与退出同时发生")', async () => {
      // A third site where `both` may use Studio.
      const C = `${fx.sites.a}_c`;
      await db.delete(sites).where(eq(sites.id, C));
      await db.insert(sites).values({ id: C, name: 'Site C' });
      const [roleC] = await db.insert(roles).values({ siteId: C, name: 'Editor', adminAccess: false, appAccess: true }).returning({ id: roles.id });
      await db.insert(userSites).values({ userId: fx.users.both.id, siteId: C, roleId: roleC!.id });
      const scoped = <T,>(siteId: string, fn: (tx: Database) => Promise<T>) =>
        db.transaction(async (tx) => {
          await tx.execute(sql`SELECT set_config('app.site_id', ${siteId}, true)`);
          return fn(tx as unknown as Database);
        });
      const userId = fx.users.both.id;
      const loginOnAandB = async () => {
        const session = await createLoginSession(db, { userId, mfaVerified: false, amr: ['pwd'], source: 'password' });
        const issue = (site: string) =>
          scoped(site, (tx) => issueRefreshToken(tx, { siteId: site, userId, audience: 'studio', sessionId: session.id, tokenVersion: 0 }, undefined));
        return { session, a: await issue(fx.sites.a), b: await issue(fx.sites.b) };
      };
      const toC = (l: Awaited<ReturnType<typeof loginOnAandB>>) =>
        switchSite(db, {
          userId,
          sid: l.session.id,
          sourceSiteId: fx.sites.a,
          targetSiteId: C,
          refreshToken: l.a.token,
          req: { ip: null, headers: {}, userAgent: null, requestId: null },
          env: undefined,
        });
      const logoutB = (l: Awaited<ReturnType<typeof loginOnAandB>>) => scoped(fx.sites.b, (tx) => revokeRefreshToken(tx, l.b.token, fx.sites.b));
      const accessOnC = (sid: string) =>
        new SignJWT({ userId, email: fx.users.both.email, roles: [], siteId: C, tokenVersion: 0, sid })
          .setProtectedHeader({ alg: 'HS256' })
          .setAudience('studio')
          .setExpirationTime('1h')
          .sign(new TextEncoder().encode(JWT_SECRET));
      const cIsDead = async (out: Awaited<ReturnType<typeof toC>>, sid: string) => {
        // A refused switch issued nothing to check.
        if (!out.ok) {
          expect(out.status).toBe(401);
          return;
        }
        expect((await scoped(C, (tx) => rotateRefreshToken(tx, { rawToken: out.refresh.token, siteId: C }, undefined))).ok).toBe(false);
        const res = await app.request('/api/v1/auth/me', { headers: { authorization: `Bearer ${await accessOnC(sid)}`, 'x-heopress-site': C } }, ENV);
        expect(res.status).toBe(401);
      };

      await setRls(true);
      try {
        // 1) The switch first, then B logs out: C is ended with the login.
        const first = await loginOnAandB();
        const switched = await toC(first);
        expect(switched.ok).toBe(true);
        expect(await logoutB(first)).toBe(true);
        await cIsDead(switched, first.session.id);
        // 2) B logs out first: the switch is refused.
        const second = await loginOnAandB();
        await logoutB(second);
        expect((await toC(second)).ok).toBe(false);
        // 3) At once: whichever wins, no C session survives.
        const third = await loginOnAandB();
        const [raced] = await Promise.all([toC(third), logoutB(third)]);
        await cIsDead(raced, third.session.id);
      } finally {
        await setRls(false);
        await db.delete(sites).where(eq(sites.id, C));
      }
    });

    it('lists and switches with each site in its own scope', async () => {
      const both = await signIn('both');
      await setRls(true);
      try {
        // RLS is really on: without a scope, the roles are invisible.
        expect(await db.select().from(roles).where(eq(roles.siteId, fx.sites.b))).toEqual([]);
        const listed = await listMySites(db, { id: fx.users.both.id, email: fx.users.both.email, isBootstrap: false }, fx.sites.a, { ip: null, headers: {} });
        expect(listed.map((s) => s.id).sort()).toEqual([fx.sites.a, fx.sites.b].sort());
        const out = await switchSite(db, {
          userId: fx.users.both.id,
          sid: both.session.id,
          sourceSiteId: fx.sites.a,
          targetSiteId: fx.sites.b,
          refreshToken: both.refresh,
          req: { ip: null, headers: {}, userAgent: null, requestId: null },
          env: undefined,
        });
        expect(out.ok).toBe(true);
      } finally {
        await setRls(false);
      }
      const [b] = await db.select().from(refreshTokens).where(eq(refreshTokens.siteId, fx.sites.b));
      expect(b?.sessionId).toBe(both.session.id);
      const [session] = await db.select().from(authSessions).where(eq(authSessions.id, both.session.id));
      expect(session!.revokedAt).toBeNull();
    });
  });
});
