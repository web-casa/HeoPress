/**
 * Public auth routes: register, verify-email, resend-verification, forgot-password, reset-password (HeoPress P04
 * self-service spec; P14 task 8.1).
 *
 * Each of these is reachable without a session, so the branches are the security contract: an unknown, inactive or
 * passwordless account must answer the same generic 202 as a real one (no enumeration), a token bound to another site
 * or user is refused, a suspended account is cut off, a reset token is single-use, and changing a password ends every
 * session and refresh token. Tokens are minted and verified by the real codecs; outbound mail and PostgreSQL are
 * boundaries.
 */
import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { ZodError } from 'zod';
import { users, userSites } from '@heopress/database';
import type { AppEnv } from '../../env';
import { signVerificationToken } from '../../services/auth/email-verification';
import { signPasswordResetToken as signResetToken } from '../../services/auth/password-reset';

const sendVerificationEmail = vi.fn(async () => undefined);
const sendPasswordResetEmail = vi.fn(async () => undefined);
vi.mock('../../modules/email/verify-email', () => ({ sendVerificationEmail: (...args: unknown[]) => sendVerificationEmail(...(args as [])) }));
vi.mock('../../modules/email/password-reset', () => ({ sendPasswordResetEmail: (...args: unknown[]) => sendPasswordResetEmail(...(args as [])) }));
vi.mock('../../services/auth/frontend-role', () => ({ ensureSubscriberRole: vi.fn(async () => 'role_sub') }));
const registrationRate = { allowed: true, retryAfterSeconds: 0 } as { allowed: boolean; retryAfterSeconds: number };
const ipRate = { allowed: true, retryAfterSeconds: 0 } as { allowed: boolean; retryAfterSeconds: number };
vi.mock('../../modules/auth/registration-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/auth/registration-guard')>();
  return {
    ...actual,
    checkRegistrationRate: vi.fn(async () => registrationRate),
    checkIpRateLimit: vi.fn(async () => ipRate),
  };
});
vi.mock('../../services/auth/refresh-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth/refresh-token')>();
  return { ...actual, revokeAllRefreshTokens: vi.fn(async () => undefined) };
});
vi.mock('../../services/auth/login-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/auth/login-sessions')>();
  return { ...actual, invalidateAllUserSessions: vi.fn(async () => undefined) };
});
vi.mock('../../services/auth/password', () => ({
  hashPassword: vi.fn(async () => 'hashed-new-password'),
  verifyPassword: vi.fn(async () => false),
}));

const sessions = await import('../../services/auth/login-sessions');
const refresh = await import('../../services/auth/refresh-token');
const { authRouter } = await import('../auth');

const JWT_SECRET = 'registration-routes-secret';
const SITE = 'site_a';
const PASSWORD = 'New-Password-2026!';

interface HarnessOptions {
  user?: Record<string, unknown> | null;
  insertFails?: 'unique' | 'other';
  registerRate?: { allowed: boolean; retryAfterSeconds: number };
  ipRate?: { allowed: boolean; retryAfterSeconds: number };
}

function harness(options: HarnessOptions = {}) {
  const state = {
    user: options.user === undefined ? null : options.user,
    inserted: [] as Array<{ table: unknown; values: Array<Record<string, unknown>> }>,
    updates: [] as Array<{ table: unknown; set: Record<string, unknown> }>,
    audits: [] as Array<Record<string, unknown>>,
  };
  const nextUser = (values: Record<string, unknown>) => ({
    id: 'usr_new',
    status: 'invited',
    passwordHash: 'hashed-password',
    tokenVersion: 1,
    isBootstrap: false,
    email: String(values.email ?? 'new@example.test'),
    preferences: {},
    ...values,
  });

  const db = {
    select: () => {
      let table: unknown;
      const chain: Record<string, unknown> = {};
      chain.from = (t: unknown) => {
        table = t;
        return chain;
      };
      chain.where = () => chain;
      chain.limit = () => Promise.resolve(table === users && state.user ? [{ ...state.user }] : []);
      chain.then = (resolve: (v: unknown) => void, reject?: (r?: unknown) => void) =>
        Promise.resolve(table === users && state.user ? [{ ...state.user }] : []).then(resolve, reject);
      return chain;
    },
    insert: (table: unknown) => {
      const chain: Record<string, unknown> = {};
      let values: Array<Record<string, unknown>> = [];
      chain.values = (input: Record<string, unknown> | Array<Record<string, unknown>>) => {
        values = Array.isArray(input) ? input : [input];
        state.inserted.push({ table, values });
        if (table !== users && table !== userSites && !(table as { name?: string })?.name?.includes('roles')) {
          state.audits.push({ ...(values[0] ?? {}) });
        }
        return chain;
      };
      chain.onConflictDoNothing = () => chain;
      chain.onConflictDoUpdate = () => chain;
      chain.returning = () => {
        if (options.insertFails === 'unique') {
          const error = Object.assign(new Error('duplicate key'), { code: '23505' });
          return Promise.reject(error);
        }
        if (options.insertFails === 'other') return Promise.reject(new Error('connection lost'));
        if (table === users) {
          state.user = nextUser(values[0] ?? {});
          return Promise.resolve([{ id: state.user.id, email: state.user.email }]);
        }
        return Promise.resolve([{ id: 'role_sub' }]);
      };
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
    update: (table: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.set = (set: Record<string, unknown>) => {
        state.updates.push({ table, set });
        if (table === users && state.user) Object.assign(state.user, set);
        return chain;
      };
      chain.where = () => chain;
      chain.returning = () => Promise.resolve([]);
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
    execute: async () => [],
  };

  const app = new Hono<AppEnv>();
  app.onError((err, c) => {
    if (err instanceof ZodError) return c.json({ errors: [{ code: 'VALIDATION_ERROR', issues: err.issues }] }, 400);
    return c.json({ errors: [{ code: 'INTERNAL' }] }, 500);
  });
  app.use('*', async (c, next) => {
    c.set('db', db as never);
    c.set('siteId', SITE);
    c.set('requestId', 'req_1');
    c.set('ip', '203.0.113.5');
    c.set('runtime', { cache: {} } as never);
    await next();
  });
  app.route('/auth', authRouter);
  registrationRate.allowed = options.registerRate?.allowed ?? true;
  registrationRate.retryAfterSeconds = options.registerRate?.retryAfterSeconds ?? 0;
  ipRate.allowed = options.ipRate?.allowed ?? true;
  return { app, state };
}

const post = (options: HarnessOptions, path: string, body: unknown, env: Record<string, unknown> = { JWT_SECRET }) =>
  harness(options).app.request(
    `/auth${path}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) },
    env,
  );

/** Run without a process-wide secret, so the route sees only the env the test supplies. */
async function withoutProcessSecret<T>(run: () => Promise<T>): Promise<T> {
  const saved = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    return await run();
  } finally {
    if (saved !== undefined) process.env.JWT_SECRET = saved;
  }
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown> & { errors?: Array<{ code: string }>; data?: Record<string, unknown> };

describe('POST /auth/register', () => {
  it('brakes a flood before parsing the body', async () => {
    const res = await post({ registerRate: { allowed: false, retryAfterSeconds: 60 } }, '/register', { email: 'x@example.test' });
    expect(res.status).toBe(429);
    expect((await json(res)).errors?.[0]).toMatchObject({ code: 'RATE_LIMITED', retryAfterSeconds: 60 });
  });

  it('validates the body and never chooses a role from it', async () => {
    const res = await post({}, '/register', { email: 'not-an-email', password: 'short' });
    expect(res.status).toBe(400);
    expect((await json(res)).errors?.[0]?.code).toBe('VALIDATION');

    const { app, state } = harness();
    const ok = await app.request(
      '/auth/register',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'New@Example.test', password: PASSWORD, firstName: 'Ada', roles: ['admin'] }),
      },
      { JWT_SECRET },
    );
    expect(ok.status).toBe(202);
    const user = state.inserted.find((entry) => entry.table === users)!;
    expect(user.values[0]).toMatchObject({ status: 'invited', firstName: 'Ada' });
    expect(user.values[0]).not.toHaveProperty('roles');
    expect(state.inserted.find((entry) => entry.table === userSites)!.values[0]).toMatchObject({ userId: 'usr_new', siteId: SITE, roleId: 'role_sub' });
    expect(sendVerificationEmail).toHaveBeenCalled();
    expect(state.audits.some((entry) => entry.event === 'user_registered')).toBe(true);
  });

  it('answers the same generic 202 for an existing email and sends nothing', async () => {
    sendVerificationEmail.mockClear();
    const { app, state } = harness({ user: { id: 'usr_1', status: 'active', passwordHash: 'h', email: 'taken@example.test' } });
    const res = await app.request(
      '/auth/register',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'taken@example.test', password: PASSWORD }) },
      { JWT_SECRET },
    );
    expect(res.status).toBe(202);
    expect((await json(res)).data).toMatchObject({ status: 'pending_verification' });
    expect(state.inserted).toHaveLength(0);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
    expect(state.audits).toEqual([]);
  });

  it('swallows a lost insert race and answers the same 202 without an audit', async () => {
    const { app, state } = harness({ insertFails: 'unique' });
    const res = await app.request(
      '/auth/register',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'race@example.test', password: PASSWORD }) },
      { JWT_SECRET },
    );
    expect(res.status).toBe(202);
    expect(state.inserted.map((entry) => entry.table)).toEqual([users]);
    expect(state.audits).toEqual([]);
  });

  it('surfaces an unexpected insert failure', async () => {
    const { app } = harness({ insertFails: 'other' });
    const res = await app.request(
      '/auth/register',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'boom@example.test', password: PASSWORD }) },
      { JWT_SECRET },
    );
    expect(res.status).toBe(500);
  });

  it('registers without a secret but cannot send the link', async () => {
    sendVerificationEmail.mockClear();
    const { app, state } = harness();
    const res = await withoutProcessSecret(async () =>
      app.request(
        '/auth/register',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nosecret@example.test', password: PASSWORD }) },
        {},
      ),
    );
    expect(res.status).toBe(202);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
    expect(state.audits.some((entry) => entry.event === 'user_registered')).toBe(true);
  });
});

describe('POST /auth/verify-email', () => {
  const invited = { id: 'usr_1', status: 'invited', email: 'invited@example.test', passwordHash: 'h' };

  it('needs a secret and a token bound to the caller’s site', async () => {
    expect(await withoutProcessSecret(async () => (await post({}, '/verify-email', { token: 'x' }, {})).status)).toBe(500);
    expect((await post({}, '/verify-email', {})).status).toBe(400);

    const otherSite = await signVerificationToken({ userId: 'usr_1', siteId: 'site_b' }, JWT_SECRET);
    const crossTenant = await post({ user: invited }, '/verify-email', { token: otherSite });
    expect(crossTenant.status).toBe(400);
    expect((await json(crossTenant)).errors?.[0]?.code).toBe('INVALID_TOKEN');

    const garbage = await post({ user: invited }, '/verify-email', { token: 'not-a-token' });
    expect(garbage.status).toBe(400);
  });

  it('refuses an unknown user, reports an already-verified one and refuses a suspended one', async () => {
    const token = await signVerificationToken({ userId: 'usr_1', siteId: SITE }, JWT_SECRET);
    const missing = await post({ user: null }, '/verify-email', { token });
    expect(missing.status).toBe(400);

    const active = await post({ user: { ...invited, status: 'active' } }, '/verify-email', { token });
    expect(active.status).toBe(200);
    expect(await active.json()).toEqual({ data: { status: 'already_verified' } });

    const suspended = await post({ user: { ...invited, status: 'suspended' } }, '/verify-email', { token });
    expect(suspended.status).toBe(403);
    expect((await json(suspended)).errors?.[0]?.code).toBe('ACCOUNT_DISABLED');
  });

  it('activates an invited account, audits it, and accepts the token from the query string', async () => {
    const token = await signVerificationToken({ userId: 'usr_1', siteId: SITE }, JWT_SECRET);
    const { app, state } = harness({ user: { ...invited } });
    const res = await app.request(`/auth/verify-email?token=${encodeURIComponent(token)}`, { method: 'POST' }, { JWT_SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'verified' } });
    expect(state.updates[0]!.set).toMatchObject({ status: 'active' });
    expect(state.audits.some((entry) => entry.event === 'email_verified' && entry.actorEmail === invited.email)).toBe(true);
  });
});

describe('POST /auth/resend-verification', () => {
  it('rate-limits, validates, and answers 202 without an eligible account', async () => {
    const limited = await post({ ipRate: { allowed: false, retryAfterSeconds: 30 } }, '/resend-verification', { email: 'x@example.test' });
    expect(limited.status).toBe(429);

    expect((await post({}, '/resend-verification', { email: 'bad' })).status).toBe(400);

    sendVerificationEmail.mockClear();
    for (const user of [null, { id: 'usr_1', status: 'active', passwordHash: 'h', email: 'a@example.test' }, { id: 'usr_2', status: 'invited', passwordHash: null, email: 'b@example.test' }]) {
      const res = await post({ user }, '/resend-verification', { email: 'a@example.test' });
      expect(res.status, JSON.stringify(user)).toBe(202);
    }
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('re-sends the link and audits it for an invited password account', async () => {
    sendVerificationEmail.mockClear();
    const { app, state } = harness({ user: { id: 'usr_1', status: 'invited', passwordHash: 'h', email: 'in@example.test' } });
    const res = await app.request(
      '/auth/resend-verification',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'in@example.test' }) },
      { JWT_SECRET },
    );
    expect(res.status).toBe(202);
    expect(sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(state.audits.some((entry) => entry.event === 'verification_resent')).toBe(true);
  });

  it('does not audit when no secret is configured', async () => {
    sendVerificationEmail.mockClear();
    const { app, state } = harness({ user: { id: 'usr_1', status: 'invited', passwordHash: 'h', email: 'in@example.test' } });
    const res = await withoutProcessSecret(async () =>
      app.request(
        '/auth/resend-verification',
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'in@example.test' }) },
        {},
      ),
    );
    expect(res.status).toBe(202);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
    expect(state.audits).toEqual([]);
  });
});

describe('POST /auth/forgot-password', () => {
  it('rate-limits, validates, and stays generic for ineligible accounts', async () => {
    expect((await post({ ipRate: { allowed: false, retryAfterSeconds: 10 } }, '/forgot-password', { email: 'x@example.test' })).status).toBe(429);
    expect((await post({}, '/forgot-password', { email: 'bad' })).status).toBe(400);
    sendPasswordResetEmail.mockClear();
    const ineligible = [
      null,
      { id: 'usr_1', status: 'invited', passwordHash: 'h', email: 'a@example.test' },
      { id: 'usr_2', status: 'active', passwordHash: null, email: 'b@example.test' },
      { id: 'usr_3', status: 'suspended', passwordHash: 'h', email: 'c@example.test' },
    ];
    for (const user of ineligible) {
      const res = await post({ user }, '/forgot-password', { email: 'a@example.test' });
      expect(res.status, JSON.stringify(user)).toBe(202);
    }
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('mints and sends a reset link for an active password account, and audits it', async () => {
    sendPasswordResetEmail.mockClear();
    const { app, state } = harness({ user: { id: 'usr_1', status: 'active', passwordHash: 'h', email: 'in@example.test' } });
    const res = await app.request(
      '/auth/forgot-password',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'in@example.test' }) },
      { JWT_SECRET },
    );
    expect(res.status).toBe(202);
    expect((await json(res)).data).toMatchObject({ status: 'reset_requested' });
    expect(sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect(state.audits.some((entry) => entry.event === 'password_reset_requested')).toBe(true);
  });
});

describe('POST /auth/reset-password', () => {
  const active = { id: 'usr_1', status: 'active', email: 'in@example.test', passwordChangedAt: null };

  it('needs a secret, a valid body and a token bound to this site and user', async () => {
    expect(await withoutProcessSecret(async () => (await post({}, '/reset-password', { token: 'x', password: PASSWORD }, {})).status)).toBe(500);
    expect((await post({}, '/reset-password', { token: '' })).status).toBe(400);

    const otherSite = await signResetToken({ userId: 'usr_1', siteId: 'site_b' }, JWT_SECRET);
    const crossTenant = await post({ user: active }, '/reset-password', { token: otherSite, password: PASSWORD });
    expect(crossTenant.status).toBe(400);
    expect((await json(crossTenant)).errors?.[0]?.code).toBe('INVALID_TOKEN');

    const token = await signResetToken({ userId: 'usr_1', siteId: SITE }, JWT_SECRET);
    const missing = await post({ user: null }, '/reset-password', { token, password: PASSWORD });
    expect(missing.status).toBe(400);
  });

  it('refuses a suspended account and a token already used', async () => {
    const token = await signResetToken({ userId: 'usr_1', siteId: SITE }, JWT_SECRET);
    const suspended = await post({ user: { ...active, status: 'suspended' } }, '/reset-password', { token, password: PASSWORD });
    expect(suspended.status).toBe(403);

    const used = await post(
      { user: { ...active, passwordChangedAt: new Date(Date.now() + 60_000) } },
      '/reset-password',
      { token, password: PASSWORD },
    );
    expect(used.status).toBe(400);
    expect((await json(used)).errors?.[0]?.code).toBe('INVALID_TOKEN');
  });

  it('sets the new password, ends every session and refresh token, and audits it', async () => {
    vi.mocked(sessions.invalidateAllUserSessions).mockClear();
    vi.mocked(refresh.revokeAllRefreshTokens).mockClear();
    const token = await signResetToken({ userId: 'usr_1', siteId: SITE }, JWT_SECRET);
    const { app, state } = harness({ user: { ...active } });
    const res = await app.request(
      '/auth/reset-password',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, password: PASSWORD }) },
      { JWT_SECRET },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { status: 'reset' } });
    expect(sessions.invalidateAllUserSessions).toHaveBeenCalledWith(expect.anything(), 'usr_1', 'password_reset', {
      passwordHash: 'hashed-new-password',
      passwordChangedAt: expect.any(Date),
    });
    expect(refresh.revokeAllRefreshTokens).toHaveBeenCalledWith(expect.anything(), SITE, 'usr_1');
    expect(state.audits.some((entry) => entry.event === 'password_reset_completed')).toBe(true);
  });
});
