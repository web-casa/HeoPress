import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { authSessions, refreshTokens, users, type Database } from '@heopress/database';
import { Hono } from 'hono';
import app from '../index';
import type { AppEnv } from '../env';
import { completePasswordLoginSession } from '../services/auth/login-session';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';
import { issueRefreshToken, pruneRefreshTokens, revokeRefreshToken, rotateRefreshToken } from '../services/auth/refresh-token';
import { createLoginSession, invalidateAllUserSessions, sessionClaims } from '../services/auth/login-sessions';

/**
 * Login sessions (HeoPress P04 task 9.7, spec sites/site-switching "登录会话统一撤销").
 *
 * One login reaches several sites (here: refresh tokens on A and B of the
 * same login session, as a site switch produces). Ending the login ends it
 * everywhere — refresh tokens and access tokens; a password change refuses
 * every token issued before it; replaying a rotated token ends the login on
 * every site; races between refresh and revocation never leave a live
 * token; MFA status and authTime survive a refresh; tokens from before login
 * sessions are refused.
 */

const JWT_SECRET = 'login-sessions-test-secret';
const ENV = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' } as unknown as Record<string, unknown>;

describe.skipIf(!hasDbIntegrationUrl)('login sessions — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;

  beforeAll(async () => {
    db = await connectDbIntegration('login-sessions');
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'lgs', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    if (fx) await fx.teardown();
  });

  const userId = () => fx.users.both.id;
  /** Refresh tokens on sites A and B, of the same login. */
  const loginOnBothSites = async (opts: { mfa?: boolean } = {}) => {
    const session = await createLoginSession(db, {
      userId: userId(),
      mfaVerified: Boolean(opts.mfa),
      amr: opts.mfa ? ['pwd', 'totp'] : ['pwd'],
      source: 'password',
    });
    const issue = (site: string) =>
      issueRefreshToken(db, { siteId: site, userId: userId(), audience: 'studio', sessionId: session.id, tokenVersion: 0 }, undefined);
    return { session, a: await issue(fx.sites.a), b: await issue(fx.sites.b) };
  };
  const rotate = (token: string, site: string) => rotateRefreshToken(db, { rawToken: token, siteId: site }, undefined);
  const get = (site: 'a' | 'b', bearer: string) =>
    app.request(`/api/v1/items/${SHARED.collection}/${fx.items[site]}`, { headers: fx.headers(site, bearer) }, ENV);

  it('a password change refuses every older refresh token, on every site', async () => {
    const { a, b } = await loginOnBothSites();
    // Only the generation moves (the session is left alone here): the token
    // version alone must refuse B's token.
    await db.update(users).set({ tokenVersion: sql`${users.tokenVersion} + 1` }).where(eq(users.id, userId()));
    expect(await rotate(b.token, fx.sites.b)).toEqual({ ok: false, reason: 'stale' });
    // And the full path: new password, new generation, every login ended.
    const second = await loginOnBothSites();
    await db.update(users).set({ tokenVersion: 0 }).where(eq(users.id, userId()));
    await invalidateAllUserSessions(db, userId(), 'password_changed');
    expect((await rotate(second.b.token, fx.sites.b)).ok).toBe(false);
    expect((await rotate(second.a.token, fx.sites.a)).ok).toBe(false);
    void a;
  });

  it('replaying a rotated refresh token ends the login on every site', async () => {
    const { session, a, b } = await loginOnBothSites();
    const next = await rotate(a.token, fx.sites.a);
    expect(next.ok).toBe(true);
    expect(await rotate(a.token, fx.sites.a)).toEqual({ ok: false, reason: 'reuse' });
    expect(await rotate(b.token, fx.sites.b)).toEqual({ ok: false, reason: 'ended' });
    const [row] = await db.select().from(authSessions).where(eq(authSessions.id, session.id));
    expect(row!.revokeReason).toBe('reuse');
  });

  it('logout on one site ends the login on the others, access tokens included', async () => {
    const login = await fx.loginOf('both');
    const issue = (site: string) =>
      issueRefreshToken(db, { siteId: site, userId: userId(), audience: 'studio', sessionId: login, tokenVersion: 0 }, undefined);
    const a = await issue(fx.sites.a);
    const b = await issue(fx.sites.b);
    const accessB = await fx.session('both', 'b');
    expect((await get('b', accessB)).status).toBe(200);

    expect(await revokeRefreshToken(db, a.token, fx.sites.a)).toBe(true);
    expect((await rotate(b.token, fx.sites.b)).ok).toBe(false);
    const res = await get('b', accessB);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { errors: Array<{ message: string }> }).errors[0]!.message).toMatch(/Session ended/);
  });

  it('a refresh racing a logout or a password change never leaves a live token', async () => {
    for (const revoke of ['logout', 'password'] as const) {
      await db.update(users).set({ tokenVersion: 0 }).where(eq(users.id, userId()));
      const { a, b } = await loginOnBothSites();
      const [rotated] = await Promise.all([
        rotate(a.token, fx.sites.a),
        revoke === 'logout' ? revokeRefreshToken(db, b.token, fx.sites.b) : invalidateAllUserSessions(db, userId(), 'password_changed'),
      ]);
      // Whichever came first, the successor (if any) is dead now.
      if (rotated.ok) expect((await rotate(rotated.token, fx.sites.a)).ok).toBe(false);
    }
  });

  it('a refresh keeps the login’s authTime and MFA status', async () => {
    const { session, a } = await loginOnBothSites({ mfa: true });
    const out = await rotate(a.token, fx.sites.a);
    if (!out.ok) throw new Error('rotation failed');
    expect(sessionClaims(out.session)).toEqual({
      sid: session.id,
      authTime: Math.floor(session.authTime.getTime() / 1000),
      tfaVerified: true,
      amr: ['pwd', 'totp'],
    });
  });

  it('refresh tokens from before login sessions are refused', async () => {
    const legacy = await issueRefreshToken(
      db,
      { siteId: fx.sites.a, userId: userId(), audience: 'studio', sessionId: await fx.loginOf('both'), tokenVersion: 0 },
      undefined,
    );
    // As the upgrade left them: no session.
    await db.update(refreshTokens).set({ sessionId: null }).where(eq(refreshTokens.id, legacy.id));
    expect(await rotate(legacy.token, fx.sites.a)).toEqual({ ok: false, reason: 'ended' });
  });

  it('/me/sessions lists the caller’s logins; another person’s cannot be revoked', async () => {
    const mine = await fx.loginOf('both');
    const theirs = await fx.loginOf('onlyA');
    const token = await fx.session('both', 'a');
    const list = await app.request('/api/v1/me/sessions', { headers: fx.headers('a', token) }, ENV);
    expect(list.status).toBe(200);
    const sessions = ((await list.json()) as { data: Array<{ id: string; current: boolean }> }).data;
    expect(sessions).toEqual([expect.objectContaining({ id: mine, current: true })]);
    const del = await app.request(`/api/v1/me/sessions/${theirs}`, { method: 'DELETE', headers: fx.headers('a', token) }, ENV);
    expect(del.status).toBe(404);
    const [still] = await db.select().from(authSessions).where(and(eq(authSessions.id, theirs)));
    expect(still!.revokedAt).toBeNull();
    // "Log out of all devices" ends every login of the caller, on every site.
    await fx.session('both', 'b', { login: 'phone' });
    const all = await app.request('/api/v1/me/sessions', { method: 'DELETE', headers: fx.headers('a', token) }, ENV);
    expect(all.status).toBe(200);
    expect((await get('b', await fx.session('both', 'b', { login: 'phone' }))).status).toBe(401);
  });
  it('a sign-in whose password was checked before a password change or reset is refused (Codex P04-4 #1)', async () => {
    // Completing MFA with a challenge issued under token_version 0, after a reset raised it.
    const user = (await db.select().from(users).where(eq(users.id, userId())))[0]!;
    const finish = new Hono<AppEnv>();
    finish.use('*', async (c, next) => {
      c.set('db', db);
      (c as unknown as { env: Record<string, unknown> }).env = { JWT_SECRET };
      await next();
    });
    finish.post('/finish/:version', (c) =>
      completePasswordLoginSession(c, { user, siteId: fx.sites.a, audience: 'studio', tfaVerified: true, amr: ['pwd', 'totp'], expectedTokenVersion: Number(c.req.param('version')) }),
    );
    await invalidateAllUserSessions(db, userId(), 'password_reset');
    const stale = await finish.request('/finish/0', { method: 'POST' });
    expect(stale.status).toBe(401);
    expect(((await stale.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('CHALLENGE_EXPIRED');
    expect((await finish.request('/finish/1', { method: 'POST' })).status).toBe(200);
  });

  it('a login whose refresh tokens have all expired is not listed and is pruned (Codex P04-4 #5)', async () => {
    const { session } = await loginOnBothSites();
    await db.update(authSessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(authSessions.id, session.id));
    const token = await fx.session('both', 'a');
    const listed = ((await (await app.request('/api/v1/me/sessions', { headers: fx.headers('a', token) }, ENV)).json()) as { data: Array<{ id: string }> }).data;
    expect(listed.map((s) => s.id)).not.toContain(session.id);
    await pruneRefreshTokens(db, new Date());
    expect(await db.select().from(authSessions).where(eq(authSessions.id, session.id))).toEqual([]);
  });
});
