/**
 * `/api/v1/auth/{login-adjacent}` routes: refresh, logout, sites, switch-site, me — and `POST /me/change-password`
 * (HeoPress P04 admin/session spec; P14 task 8.1).
 *
 * The login handler itself is exercised end to end by the golden-path, lockout, anomaly and rate-limit suites. This
 * file pins the routes around it, where a wrong branch leaks a session: a frontend token must not list or switch
 * sites, a removed member must not renew an access token, a disabled account must be cut off on its next refresh, a
 * cookie-borne refresh token must carry the CSRF header, and a password change must end every session and refresh
 * token. Collaborators that need PostgreSQL (refresh rotation, site switching, membership) are boundaries here; their
 * own suites cover the SQL.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { users, userSites } from '@heopress/database';
import type { AppEnv } from '../../env';
import { TOKEN_AUDIENCE } from '../../services/auth/token-audience';

vi.mock('../../services/auth/refresh-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth/refresh-token')>();
  return {
    ...actual,
    rotateRefreshToken: vi.fn(),
    revokeRefreshToken: vi.fn(async () => undefined),
    revokeAllRefreshTokens: vi.fn(async () => undefined),
  };
});
vi.mock('../../services/auth/login-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth/login-sessions')>();
  return {
    ...actual,
    invalidateAllUserSessions: vi.fn(async () => undefined),
    revokeAllLoginSessions: vi.fn(async () => undefined),
    revokeLoginSession: vi.fn(async () => undefined),
    listLoginSessions: vi.fn(async () => []),
  };
});
vi.mock('../../services/auth/site-switch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth/site-switch')>();
  return {
    ...actual,
    studioAccessFor: vi.fn(async () => ({ allowed: true })),
    listMySites: vi.fn(async () => []),
    switchSite: vi.fn(),
  };
});
vi.mock('../../services/auth/password', () => ({
  hashPassword: vi.fn(async () => 'hashed-new-password'),
  // Only the current password the tests present as right verifies against the stored hash.
  verifyPassword: vi.fn(async (plain: string, hash: string) => plain === 'right' && hash === 'stored-hash'),
}));
vi.mock('../../services/sites/site-provisioning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/sites/site-provisioning')>();
  return { ...actual, canCreateSite: vi.fn(async () => false) };
});

const refresh = await import('../../services/auth/refresh-token');
const sessions = await import('../../services/auth/login-sessions');
const siteSwitch = await import('../../services/auth/site-switch');
const siteProvisioning = await import('../../services/sites/site-provisioning');
const { authRouter, meRouter } = await import('../auth');

const JWT_SECRET = 'auth-routes-secret';
const CSRF_HEADER = refresh.REFRESH_CSRF_HEADER;

interface HarnessOptions {
  user?: Record<string, unknown> | null;
  membership?: { roleId: string } | null;
  auth?: Record<string, unknown> | null;
  env?: Record<string, unknown>;
  /** What the rate limiter answers; `undefined` allows. */
  rateLimit?: 'blocked' | 'unavailable';
}

function harness(options: HarnessOptions = {}) {
  const audits: Array<Record<string, unknown>> = [];
  const user =
    options.user === undefined
      ? { id: 'usr_1', email: 'Editor@Example.test', status: 'active', isBootstrap: false, tokenVersion: 2, passwordHash: 'stored-hash', preferences: {} }
      : options.user;
  const membership = options.membership === undefined ? { roleId: 'role_editor' } : options.membership;
  const db = {
    select: () => {
      let table: unknown;
      const chain: Record<string, unknown> = {};
      chain.from = (t: unknown) => {
        table = t;
        return chain;
      };
      chain.where = () => chain;
      chain.limit = () => {
        if (table === userSites) return Promise.resolve(membership ? [membership] : []);
        if (table === users) return Promise.resolve(user ? [user] : []);
        return Promise.resolve([]);
      };
      chain.then = (resolve: (v: unknown) => void, reject?: (r?: unknown) => void) =>
        Promise.resolve(user ? [user] : []).then(resolve, reject);
      return chain;
    },
    insert: (table: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.values = (values: Record<string, unknown>) => {
        audits.push({ table, ...values });
        return Promise.resolve(undefined);
      };
      chain.onConflictDoNothing = () => chain;
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
  };
  const app = new Hono<AppEnv>();
  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ errors: [{ code: 'VALIDATION_ERROR' }] }, 400);
    throw err;
  });
  app.use('*', async (c, next) => {
    c.set('db', db as never);
    c.set('siteId', 'site_a');
    c.set('requestId', 'req_1');
    c.set('ip', '203.0.113.5');
    c.set(
      'runtime',
      {
        cache: {},
        rateLimiter: options.rateLimit
          ? {
              consume: async () => {
                if (options.rateLimit === 'unavailable') throw new Error('rate limiter down');
                return { allowed: false, remaining: 0, resetAt: Math.ceil(Date.now() / 1000) + 30 };
              },
            }
          : { consume: async () => ({ allowed: true, remaining: 9, resetAt: Math.ceil(Date.now() / 1000) + 60 }) },
      } as never,
    );
    const principal =
      options.auth === null
        ? { userId: null, raw: {} }
        : (options.auth ?? {
            type: 'session',
            method: 'session',
            userId: 'usr_1',
            email: 'Editor@Example.test',
            roles: ['editor'],
            raw: { sid: 'sid_1', aud: TOKEN_AUDIENCE.studio, tokenVersion: 2 },
          });
    c.set('auth', principal as never);
    await next();
  });
  app.route('/auth', authRouter);
  app.route('/me', meRouter);
  return { app, audits };
}

const call = (
  options: HarnessOptions,
  path: string,
  method: string,
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  harness(options).app.request(
    path,
    {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    },
    { JWT_SECRET, ...(options.env ?? {}) },
  );

const json = async (res: Response) => (await res.json()) as Record<string, unknown> & { errors?: Array<{ code: string }>; data?: Record<string, unknown> };

const rotateOk = (tokenVersion = 2) => ({
  ok: true as const,
  userId: 'usr_1',
  tokenVersion,
  token: 'rt_new',
  expiresAt: new Date('2026-12-01T00:00:00.000Z'),
  session: { id: 'sid_1', authTime: new Date('2026-06-01T00:00:00.000Z'), mfaVerified: false, amr: [] },
});

describe('POST /me/change-password', () => {
  it('refuses an unauthenticated caller and an invalid body', async () => {
    const unauth = await call({ auth: null }, '/me/change-password', 'POST', { currentPassword: 'a', newPassword: 'b' });
    expect(unauth.status).toBe(401);
    expect((await json(unauth)).errors?.[0]?.code).toBe('UNAUTHENTICATED');

    const invalid = await call({}, '/me/change-password', 'POST', { currentPassword: 'only-current' });
    expect(invalid.status).toBe(400);
    expect((await json(invalid)).errors?.[0]?.code).toBe('VALIDATION_ERROR');
  });

  it('refuses an account without a local password', async () => {
    const res = await call(
      { user: { id: 'usr_1', email: 'sso@example.test', passwordHash: null } },
      '/me/change-password',
      'POST',
      { currentPassword: 'whatever', newPassword: 'New-Password-2026!' },
    );
    expect(res.status).toBe(400);
    expect((await json(res)).errors?.[0]?.code).toBe('NO_PASSWORD');
  });

  it('refuses a wrong current password without touching any session', async () => {
    vi.mocked(sessions.invalidateAllUserSessions).mockClear();
    const res = await call({}, '/me/change-password', 'POST', { currentPassword: 'wrong', newPassword: 'New-Password-2026!' });
    expect(res.status).toBe(401);
    expect((await json(res)).errors?.[0]?.code).toBe('INVALID_CREDENTIALS');
    expect(sessions.invalidateAllUserSessions).not.toHaveBeenCalled();
  });

  it('sets the new hash, ends every session and refresh token, and audits it', async () => {
    vi.mocked(sessions.invalidateAllUserSessions).mockClear();
    vi.mocked(refresh.revokeAllRefreshTokens).mockClear();
    const { app, audits } = harness();
    const res = await app.request(
      '/me/change-password',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'right', newPassword: 'New-Password-2026!' }) },
      { JWT_SECRET },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'password_changed' } });
    expect(sessions.invalidateAllUserSessions).toHaveBeenCalledWith(expect.anything(), 'usr_1', 'password_changed', {
      passwordHash: 'hashed-new-password',
      passwordChangedAt: expect.any(Date),
    });
    expect(refresh.revokeAllRefreshTokens).toHaveBeenCalledWith(expect.anything(), 'site_a', 'usr_1');
    expect(audits.some((entry) => entry.event === 'password_changed' && entry.actorEmail === 'Editor@Example.test')).toBe(true);
  });
});

describe('GET /auth/sites', () => {
  it('refuses an API key, an anonymous caller and a frontend session', async () => {
    for (const auth of [
      { method: 'api_key', userId: 'usr_1', raw: {} },
      { method: 'anonymous', userId: null, raw: {} },
      { method: 'session', userId: 'usr_1', raw: { aud: TOKEN_AUDIENCE.frontend } },
    ]) {
      const res = await call({ auth }, '/auth/sites', 'GET');
      expect(res.status, JSON.stringify(auth)).toBe(403);
      expect((await json(res)).errors?.[0]?.code).toBe('FORBIDDEN');
    }
  });

  it('refuses a missing or inactive account', async () => {
    for (const user of [null, { id: 'usr_1', email: 'x@example.test', status: 'suspended' }]) {
      const res = await call({ user }, '/auth/sites', 'GET');
      expect(res.status, JSON.stringify(user)).toBe(401);
      expect((await json(res)).errors?.[0]?.code).toBe('UNAUTHENTICATED');
    }
  });

  it('refuses where Studio access was lost, and where the site now needs a second factor', async () => {
    vi.mocked(siteSwitch.studioAccessFor).mockResolvedValueOnce({ allowed: false } as never);
    const denied = await call({}, '/auth/sites', 'GET');
    expect(denied.status).toBe(403);
    expect((await json(denied)).errors?.[0]?.code).toBe('APP_ACCESS_DENIED');

    vi.mocked(siteSwitch.studioAccessFor).mockResolvedValueOnce({ allowed: true, mfaRequired: true } as never);
    const tfa = await call({}, '/auth/sites', 'GET');
    expect(tfa.status).toBe(403);
    expect((await json(tfa)).errors?.[0]?.code).toBe('TFA_REQUIRED');

    vi.mocked(siteSwitch.studioAccessFor).mockResolvedValueOnce({ allowed: true, mfaRequired: true } as never);
    const verified = await call(
      { auth: { method: 'session', userId: 'usr_1', raw: { aud: TOKEN_AUDIENCE.studio, amr: ['pwd', 'totp'] } } },
      '/auth/sites',
      'GET',
    );
    expect(verified.status).toBe(200);
  });

  it('lists the sites with the create-sites capability', async () => {
    vi.mocked(siteSwitch.studioAccessFor).mockResolvedValue({ allowed: true } as never);
    vi.mocked(siteSwitch.listMySites).mockResolvedValueOnce([{ id: 'site_a', name: 'A' }] as never);
    vi.mocked(siteProvisioning.canCreateSite).mockResolvedValueOnce(true as never);
    const res = await call({}, '/auth/sites', 'GET');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [{ id: 'site_a', name: 'A' }], meta: { canCreateSites: true } });
  });
});

describe('POST /auth/switch-site', () => {
  const body = { siteId: 'site_b', refreshToken: 'rt_1' };

  it('refuses principals that are not a Studio session', async () => {
    for (const auth of [
      { method: 'api_key', userId: 'usr_1', raw: {} },
      { method: 'anonymous', userId: null, raw: {} },
      { method: 'session', userId: 'usr_1', raw: { aud: TOKEN_AUDIENCE.frontend } },
    ]) {
      const res = await call({ auth }, '/auth/switch-site', 'POST', body);
      expect(res.status, JSON.stringify(auth)).toBe(403);
    }
    const cf = await call({ auth: { method: 'cf_access', userId: 'usr_1', raw: {} } }, '/auth/switch-site', 'POST', body);
    expect(cf.status).toBe(409);
    expect((await json(cf)).errors?.[0]?.code).toBe('NOT_NEEDED');
    const pat = await call({ auth: { method: 'pat', userId: 'usr_1', raw: {} } }, '/auth/switch-site', 'POST', body);
    expect(pat.status).toBe(409);
    expect((await json(pat)).errors?.[0]?.code).toBe('NOT_SUPPORTED');
  });

  it('validates the body and the caller account', async () => {
    expect((await call({}, '/auth/switch-site', 'POST', { siteId: '' })).status).toBe(400);
    const missing = await call({ user: null }, '/auth/switch-site', 'POST', body);
    expect(missing.status).toBe(401);
    expect((await json(missing)).errors?.[0]?.code).toBe('INVALID_SESSION');
    const suspended = await call({ user: { id: 'usr_1', email: 'x@example.test', status: 'suspended' } }, '/auth/switch-site', 'POST', body);
    expect(suspended.status).toBe(401);
  });

  it('refuses when Studio access is denied, and when the site needs a second factor', async () => {
    vi.mocked(siteSwitch.studioAccessFor).mockResolvedValueOnce({ allowed: false } as never);
    const denied = await call({}, '/auth/switch-site', 'POST', body);
    expect(denied.status).toBe(403);
    expect((await json(denied)).errors?.[0]?.code).toBe('APP_ACCESS_DENIED');

    vi.mocked(siteSwitch.studioAccessFor).mockResolvedValueOnce({ allowed: true, mfaRequired: true } as never);
    const tfa = await call({}, '/auth/switch-site', 'POST', body);
    expect(tfa.status).toBe(403);
    expect((await json(tfa)).errors?.[0]?.code).toBe('TFA_REQUIRED');
  });

  it('fails closed when the switch budget is spent or cannot be checked', async () => {
    const blocked = await call({ rateLimit: 'blocked' }, '/auth/switch-site', 'POST', body);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect((await json(blocked)).errors?.[0]?.code).toBe('RATE_LIMITED');

    const unavailable = await call({ rateLimit: 'unavailable' }, '/auth/switch-site', 'POST', body);
    expect(unavailable.status).toBe(429);
  });

  it('answers 500 without a JWT secret', async () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    const res = await harness().app.request(
      '/auth/switch-site',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      {},
    );
    expect(res.status).toBe(500);
    expect((await json(res)).errors?.[0]?.code).toBe('AUTH_NOT_CONFIGURED');
    if (saved !== undefined) process.env.JWT_SECRET = saved;
  });

  it('maps each refusal of the switch itself', async () => {
    for (const [code, status] of [
      ['INVALID_SESSION', 401],
      ['SITE_NOT_ALLOWED', 403],
      ['MFA_REQUIRED', 403],
    ] as const) {
      vi.mocked(siteSwitch.switchSite).mockResolvedValueOnce({ ok: false, code, status } as never);
      const res = await call({}, '/auth/switch-site', 'POST', body);
      expect(res.status, code).toBe(status);
      expect((await json(res)).errors?.[0]?.code).toBe(code);
    }
  });

  it('answers the new site’s access token and refresh token', async () => {
    vi.mocked(siteSwitch.studioAccessFor).mockResolvedValue({ allowed: true } as never);
    vi.mocked(siteSwitch.switchSite).mockResolvedValueOnce({
      ok: true,
      user: { id: 'usr_1', email: 'Editor@Example.test' },
      roles: ['editor'],
      site: { id: 'site_b', name: 'B' },
      tokenVersion: 2,
      session: { id: 'sid_1', authTime: new Date('2026-06-01T00:00:00.000Z'), mfaVerified: true, amr: ['pwd', 'totp'] },
      refresh: { token: 'rt_new', expiresAt: new Date('2026-12-01T00:00:00.000Z') },
    } as never);
    const res = await call({}, '/auth/switch-site', 'POST', body);
    expect(res.status).toBe(200);
    const data = (await json(res)).data as Record<string, unknown>;
    expect(data).toMatchObject({
      refreshToken: 'rt_new',
      refreshTokenExpiresAt: '2026-12-01T00:00:00.000Z',
      sid: 'sid_1',
      site: { id: 'site_b', name: 'B' },
    });
    expect(String(data.token).split('.')).toHaveLength(3);
  });
});

describe('POST /auth/logout', () => {
  it('needs the CSRF header for a cookie-borne refresh token', async () => {
    const res = await harness().app.request(
      '/auth/logout',
      { method: 'POST', headers: { cookie: 'heopress_refresh=rt_1' } },
      { JWT_SECRET },
    );
    expect(res.status).toBe(403);
    expect((await json(res)).errors?.[0]?.code).toBe('CSRF_REQUIRED');
  });

  it('revokes a body token, tolerates no token and malformed JSON, and clears the cookie', async () => {
    vi.mocked(refresh.revokeRefreshToken).mockClear();
    const revoked = await call({}, '/auth/logout', 'POST', { refreshToken: 'rt_body' });
    expect(revoked.status).toBe(200);
    expect(refresh.revokeRefreshToken).toHaveBeenCalledWith(expect.anything(), 'rt_body', 'site_a');

    const empty = await call({}, '/auth/logout', 'POST', undefined);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ data: { status: 'logged_out' } });

    const malformed = await call({}, '/auth/logout', 'POST', '{not json');
    expect(malformed.status).toBe(200);
  });
});

describe('POST /auth/refresh', () => {
  it('needs a configured secret and a token', async () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    const noSecret = await harness().app.request('/auth/refresh', { method: 'POST', body: '{}' }, {});
    if (saved !== undefined) process.env.JWT_SECRET = saved;
    expect(noSecret.status).toBe(500);
    expect((await json(noSecret)).errors?.[0]?.code).toBe('AUTH_NOT_CONFIGURED');

    const none = await call({}, '/auth/refresh', 'POST', {});
    expect(none.status).toBe(401);
    expect((await json(none)).errors?.[0]?.code).toBe('NO_REFRESH_TOKEN');
  });

  it('needs the CSRF header when the token came from the cookie', async () => {
    const res = await harness().app.request(
      '/auth/refresh',
      { method: 'POST', headers: { cookie: 'heopress_refresh=rt_cookie' } },
      { JWT_SECRET },
    );
    expect(res.status).toBe(403);
    expect((await json(res)).errors?.[0]?.code).toBe('CSRF_REQUIRED');
  });

  it('refuses an invalid token, and audits a detected reuse', async () => {
    vi.mocked(refresh.rotateRefreshToken).mockResolvedValueOnce({ ok: false, reason: 'invalid' } as never);
    const invalid = await call({}, '/auth/refresh', 'POST', { refreshToken: 'rt_bad' });
    expect(invalid.status).toBe(401);
    expect((await json(invalid)).errors?.[0]?.code).toBe('INVALID_REFRESH_TOKEN');

    const reuse = harness();
    vi.mocked(refresh.rotateRefreshToken).mockResolvedValueOnce({ ok: false, reason: 'reuse' } as never);
    const res = await reuse.app.request(
      '/auth/refresh',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refreshToken: 'rt_reused' }) },
      { JWT_SECRET },
    );
    expect(res.status).toBe(401);
    expect(reuse.audits.some((entry) => entry.event === 'refresh_token_reuse_detected')).toBe(true);
  });

  it('cuts off a disabled account and one that lost site membership', async () => {
    vi.mocked(refresh.rotateRefreshToken).mockResolvedValue(rotateOk() as never);
    vi.mocked(sessions.revokeAllLoginSessions).mockClear();
    vi.mocked(refresh.revokeAllRefreshTokens).mockClear();

    const disabled = await call({ user: { id: 'usr_1', email: 'x@example.test', status: 'suspended' } }, '/auth/refresh', 'POST', { refreshToken: 'rt_1' });
    expect(disabled.status).toBe(403);
    expect((await json(disabled)).errors?.[0]?.code).toBe('ACCOUNT_DISABLED');
    expect(sessions.revokeAllLoginSessions).toHaveBeenCalledWith(expect.anything(), 'usr_1', 'user_disabled');

    vi.mocked(refresh.revokeAllRefreshTokens).mockClear();
    const removed = await call({ membership: null }, '/auth/refresh', 'POST', { refreshToken: 'rt_1' });
    expect(removed.status).toBe(403);
    expect((await json(removed)).errors?.[0]?.code).toBe('TENANT_ACCESS_DENIED');
    expect(refresh.revokeAllRefreshTokens).toHaveBeenCalledWith(expect.anything(), 'site_a', 'usr_1');
  });

  it('renews as a studio or a frontend session by the site’s current access', async () => {
    vi.mocked(refresh.rotateRefreshToken).mockResolvedValue(rotateOk() as never);
    vi.mocked(siteSwitch.studioAccessFor).mockResolvedValue({ allowed: true } as never);
    const studio = await call({}, '/auth/refresh', 'POST', { refreshToken: 'rt_1' });
    expect(studio.status).toBe(200);
    const studioData = (await json(studio)).data as Record<string, unknown>;
    expect(studioData).toMatchObject({ refreshToken: 'rt_new', refreshTokenExpiresAt: '2026-12-01T00:00:00.000Z' });
    expect(String(studioData.token).split('.')).toHaveLength(3);
    const studioPayload = JSON.parse(Buffer.from(String(studioData.token).split('.')[1]!, 'base64url').toString()) as { aud: string; roles: string[] };
    expect(studioPayload).toMatchObject({ aud: TOKEN_AUDIENCE.studio, roles: ['role_editor'] });

    vi.mocked(siteSwitch.studioAccessFor).mockResolvedValue({ allowed: false } as never);
    const frontend = await call({}, '/auth/refresh', 'POST', { refreshToken: 'rt_1' });
    expect(frontend.status).toBe(200);
    const frontendData = (await json(frontend)).data as Record<string, unknown>;
    const frontendPayload = JSON.parse(Buffer.from(String(frontendData.token).split('.')[1]!, 'base64url').toString()) as { aud: string };
    expect(frontendPayload.aud).toBe(TOKEN_AUDIENCE.frontend);

    // The bootstrap admin has no membership row and still renews as admin.
    vi.mocked(siteSwitch.studioAccessFor).mockResolvedValue({ allowed: true } as never);
    const bootstrap = await call(
      { user: { id: 'usr_1', email: 'boot@example.test', status: 'active', isBootstrap: true, tokenVersion: 2 }, membership: null },
      '/auth/refresh',
      'POST',
      { refreshToken: 'rt_1' },
    );
    expect(bootstrap.status).toBe(200);
    const bootstrapPayload = JSON.parse(
      Buffer.from(String(((await json(bootstrap)).data as Record<string, unknown>).token).split('.')[1]!, 'base64url').toString(),
    ) as { roles: string[] };
    expect(bootstrapPayload.roles).toEqual(['admin']);
  });
});

describe('GET /auth/me', () => {
  it('answers the principal it was given, and an anonymous fallback', async () => {
    const me = await call({}, '/auth/me', 'GET');
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({
      data: {
        logtoId: 'usr_1',
        userId: 'usr_1',
        externalId: undefined,
        email: 'Editor@Example.test',
        roles: ['editor'],
        isFrontendUser: false,
        siteId: 'site_a',
        permissions: null,
      },
    });

    const anon = await call({ auth: null }, '/auth/me', 'GET');
    expect(((await json(anon)).data as Record<string, unknown>).logtoId).toBe('anon');
  });
});
