/**
 * `/api/v1/auth/verify-totp` and `/api/v1/me/tfa*`: every refusal the two-factor routes can answer (HeoPress P04,
 * P14 task 8.1).
 *
 * The route decides who may try, in what order, and what a failure says. The MFA service itself (TOTP verification,
 * recovery codes, the pending setup record) has its own tests; here it is a boundary whose result the route must
 * interpret: a consumed challenge, a rate-limited attempt, a dead seed (`TotpError`), a disabled account, a
 * non-studio audience. Those orderings are the security contract — a rate-limited attempt must not consume the
 * challenge, a disabled account must not receive a session, a recovery code must still remove a dead factor.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { signMfaChallengeToken } from '../../services/auth/mfa-challenge';
import { TOKEN_AUDIENCE } from '../../services/auth/token-audience';
import { tfaAuthRouter, tfaMeRouter } from '../tfa';

vi.mock('../../modules/mfa/totp-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/mfa/totp-service')>();
  return {
    ...actual,
    beginTotpSetup: vi.fn(),
    confirmTotpSetup: vi.fn(),
    consumeMfaChallengeJti: vi.fn(),
    disableUserTotp: vi.fn(),
    getTotpStatus: vi.fn(),
    regenerateRecoveryCodes: vi.fn(),
    verifyStepUpPassword: vi.fn(),
    verifyUserRecoveryCode: vi.fn(),
    verifyUserTotpCode: vi.fn(),
  };
});
vi.mock('../../modules/login-guard/hooks', () => ({ recordLoginSuccess: vi.fn(async () => undefined) }));
vi.mock('../../services/auth/login-session', () => ({
  completePasswordLoginSession: vi.fn(async (c: { json: (body: unknown, status: 200) => Response }) => c.json({ data: { session: true } }, 200)),
}));
vi.mock('../../services/auth/refresh-token', () => ({ revokeAllRefreshTokens: vi.fn(async () => undefined) }));
vi.mock('../../services/auth/login-sessions', () => ({ invalidateAllUserSessions: vi.fn(async () => undefined) }));

const mfa = await import('../../modules/mfa/totp-service');
const { TotpError } = mfa;
const hooks = await import('../../modules/login-guard/hooks');
const loginSession = await import('../../services/auth/login-session');
const refreshToken = await import('../../services/auth/refresh-token');
const loginSessions = await import('../../services/auth/login-sessions');

const JWT_SECRET = 'test-secret-value';

interface HarnessOptions {
  user?: { id: string; email: string; status: string } | null;
  auth?: { userId?: string | null; email?: string | null } | null;
  cache?: Record<string, unknown>;
  rateLimiter?: unknown;
}

function harness(options: HarnessOptions = {}) {
  const audits: Array<Record<string, unknown>> = [];
  const user = options.user === undefined ? { id: 'usr_1', email: 'Editor@Example.test', status: 'active' } : options.user;
  const db = {
    select: () => {
      const chain: Record<string, unknown> = {};
      chain.from = () => chain;
      chain.where = () => chain;
      chain.limit = () => Promise.resolve(user ? [user] : []);
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(user ? [user] : []).then(resolve);
      return chain;
    },
    insert: (table: unknown) => {
      const chain: Record<string, unknown> = {};
      chain.values = (values: Record<string, unknown>) => {
        audits.push({ table, ...values });
        return Promise.resolve(undefined);
      };
      chain.then = (resolve: (v: unknown) => void) => Promise.resolve(undefined).then(resolve);
      return chain;
    },
  };
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', db as never);
    c.set('siteId', 'site_a');
    c.set('requestId', 'req_1');
    c.set('ip', '203.0.113.7');
    c.set(
      'runtime',
      {
        cache: options.cache ?? { get: async () => null, set: async () => undefined, delete: async () => undefined },
        rateLimiter: options.rateLimiter ?? { consume: async () => ({ allowed: true, remaining: 9, resetAt: Math.ceil(Date.now() / 1000) + 60 }) },
        keys: { get: async () => null },
      } as never,
    );
    if (options.auth !== null) {
      c.set('auth', (options.auth ?? { userId: 'usr_1', email: 'Editor@Example.test' }) as never);
    }
    await next();
  });
  app.route('/auth', tfaAuthRouter);
  app.route('/me', tfaMeRouter);
  return { app, audits };
}

const post = (app: Hono<AppEnv>, path: string, body: unknown, init: RequestInit = {}) =>
  app.request(path, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), ...init }, { JWT_SECRET });

const del = (app: Hono<AppEnv>, path: string, body: unknown) =>
  app.request(path, { method: 'DELETE', body: typeof body === 'string' ? body : JSON.stringify(body) }, { JWT_SECRET });

const challenge = (overrides: { userId?: string; siteId?: string; audience?: string; tokenVersion?: number } = {}) =>
  signMfaChallengeToken(
    {
      userId: overrides.userId ?? 'usr_1',
      siteId: overrides.siteId ?? 'site_a',
      loginAudience: overrides.audience ?? TOKEN_AUDIENCE.studio,
      tokenVersion: overrides.tokenVersion ?? 1,
    },
    JWT_SECRET,
  );

beforeEach(() => {
  vi.mocked(mfa.consumeMfaChallengeJti).mockReset().mockResolvedValue(true);
  vi.mocked(mfa.verifyUserTotpCode).mockReset().mockResolvedValue(true);
  vi.mocked(mfa.verifyUserRecoveryCode).mockReset().mockResolvedValue(true);
  vi.mocked(mfa.verifyStepUpPassword).mockReset().mockResolvedValue(true);
  vi.mocked(mfa.getTotpStatus).mockReset().mockResolvedValue({ enabled: false, recoveryCodesRemaining: 0 } as never);
  vi.mocked(mfa.beginTotpSetup).mockReset().mockResolvedValue({ secret: 'SECRETSECRETSECR', otpauthUrl: 'otpauth://totp/x' });
  vi.mocked(mfa.confirmTotpSetup).mockReset().mockResolvedValue({ recoveryCodes: ['aaaa-bbbb'] });
  vi.mocked(mfa.regenerateRecoveryCodes).mockReset().mockResolvedValue(['cccc-dddd']);
  vi.mocked(mfa.disableUserTotp).mockReset().mockResolvedValue(undefined);
  vi.mocked(hooks.recordLoginSuccess).mockClear();
  vi.mocked(loginSession.completePasswordLoginSession).mockClear();
  vi.mocked(refreshToken.revokeAllRefreshTokens).mockClear();
  vi.mocked(loginSessions.invalidateAllUserSessions).mockClear();
});

describe('POST /auth/verify-totp', () => {
  it('refuses to run without a JWT secret', async () => {
    const { app } = harness();
    // A process-wide secret would be picked up as a fallback; remove it for this request only.
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    const res = await app.request('/auth/verify-totp', { method: 'POST', body: '{}' }, {});
    if (saved !== undefined) process.env.JWT_SECRET = saved;
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'AUTH_NOT_CONFIGURED' }] });
  });

  it('rejects a body that is not JSON and one that does not parse', async () => {
    const { app } = harness();
    const notJson = await post(app, '/auth/verify-totp', '{not json');
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toMatchObject({ errors: [{ code: 'VALIDATION', message: 'Body must be valid JSON.' }] });

    const missingCode = await post(app, '/auth/verify-totp', { challengeToken: 'x' });
    expect(missingCode.status).toBe(400);
    const body = (await missingCode.json()) as { errors: Array<{ code: string }> };
    expect(body.errors.every((e) => e.code === 'VALIDATION')).toBe(true);
  });

  it('refuses an unverifiable challenge token and one minted for another site', async () => {
    const { app } = harness();
    const forged = await post(app, '/auth/verify-totp', { challengeToken: 'not.a.token', code: '123456' });
    expect(forged.status).toBe(401);
    expect(await forged.json()).toMatchObject({ errors: [{ code: 'INVALID_TOKEN' }] });

    const otherSite = await challenge({ siteId: 'site_b' });
    const res = await post(app, '/auth/verify-totp', { challengeToken: otherSite.token, code: '123456' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'INVALID_TOKEN' }] });
  });

  it('refuses a challenge whose jti was already consumed', async () => {
    vi.mocked(mfa.consumeMfaChallengeJti).mockResolvedValue(false);
    const { app } = harness();
    const token = await challenge();
    const res = await post(app, '/auth/verify-totp', { challengeToken: token.token, code: '123456' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'INVALID_TOKEN' }] });
    expect(mfa.verifyUserTotpCode).not.toHaveBeenCalled();
  });

  it('rate limits before spending a verification attempt', async () => {
    const { app } = harness({
      rateLimiter: { consume: async () => ({ allowed: false, remaining: 0, resetAt: Math.ceil(Date.now() / 1000) + 30 }) },
    });
    const token = await challenge();
    const res = await post(app, '/auth/verify-totp', { challengeToken: token.token, code: '123456' });
    expect(res.status).toBe(429);
    const body = (await res.json()) as { errors: Array<{ code: string; retryAfterSeconds: number }> };
    expect(body.errors[0]!.code).toBe('RATE_LIMITED');
    expect(body.errors[0]!.retryAfterSeconds).toBeGreaterThan(0);
    expect(mfa.verifyUserTotpCode).not.toHaveBeenCalled();
  });

  it('maps a dead seed (TotpError) to 409 and its own code', async () => {
    vi.mocked(mfa.verifyUserTotpCode).mockRejectedValue(new TotpError('KEY_UNAVAILABLE', 'the seed cannot be decrypted'));
    const { app } = harness();
    const token = await challenge();
    const res = await post(app, '/auth/verify-totp', { challengeToken: token.token, code: '123456' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'KEY_UNAVAILABLE', message: 'the seed cannot be decrypted' }] });
  });

  it('a wrong code is 401 and audited, without a session', async () => {
    vi.mocked(mfa.verifyUserTotpCode).mockResolvedValue(false);
    const { app, audits } = harness();
    const token = await challenge();
    const res = await post(app, '/auth/verify-totp', { challengeToken: token.token, code: '000000' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'INVALID_CODE' }] });
    expect(audits.some((entry) => entry.event === 'mfa_verify_failed' && entry.metadata)).toBe(true);
    expect(loginSession.completePasswordLoginSession).not.toHaveBeenCalled();
  });

  it('verifies a recovery code by the same route', async () => {
    const { app } = harness();
    const token = await challenge();
    const res = await post(app, '/auth/verify-totp', { challengeToken: token.token, recoveryCode: 'abcd-efgh' });
    expect(res.status).toBe(200);
    expect(mfa.verifyUserRecoveryCode).toHaveBeenCalledWith(expect.anything(), 'usr_1', 'abcd-efgh', expect.any(String));
    expect(mfa.verifyUserTotpCode).not.toHaveBeenCalled();
    expect(loginSession.completePasswordLoginSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ siteId: 'site_a', tfaVerified: true, amr: ['pwd', 'totp'], expectedTokenVersion: 1 }),
    );
  });

  it('refuses a disabled or missing account after the code checked out', async () => {
    for (const user of [null, { id: 'usr_1', email: 'a@example.test', status: 'suspended' }]) {
      const { app } = harness({ user });
      const token = await challenge();
      const res = await post(app, '/auth/verify-totp', { challengeToken: token.token, code: '123456' });
      expect(res.status, JSON.stringify(user)).toBe(403);
      expect(await res.json()).toMatchObject({ errors: [{ code: 'ACCOUNT_DISABLED' }] });
      expect(loginSession.completePasswordLoginSession).not.toHaveBeenCalled();
    }
  });

  it('issues a session only for a studio audience', async () => {
    const { app } = harness();
    const api = await challenge({ audience: TOKEN_AUDIENCE.frontend });
    const res = await post(app, '/auth/verify-totp', { challengeToken: api.token, code: '123456' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'MFA_NOT_SUPPORTED' }] });
    expect(hooks.recordLoginSuccess).toHaveBeenCalledTimes(1);
    expect(loginSession.completePasswordLoginSession).not.toHaveBeenCalled();
  });
});

describe('the signed-in two-factor routes', () => {
  it('refuse an unauthenticated caller on every path', async () => {
    const { app } = harness({ auth: null });
    for (const path of ['/me/tfa']) {
      const res = await app.request(path, {}, { JWT_SECRET });
      expect(res.status, path).toBe(401);
    }
    for (const [path, method] of [['/me/tfa/setup', 'POST'], ['/me/tfa/confirm', 'POST'], ['/me/tfa/recovery-codes', 'POST'], ['/me/tfa', 'DELETE']] as const) {
      const res = await app.request(path, { method, body: '{}' }, { JWT_SECRET });
      expect(res.status, path).toBe(401);
    }
    expect(mfa.verifyStepUpPassword).not.toHaveBeenCalled();
  });

  it('GET /me/tfa answers the enrollment status', async () => {
    const { app } = harness();
    const res = await app.request('/me/tfa', {}, { JWT_SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { enabled: false, recoveryCodesRemaining: 0 } });
    expect(mfa.getTotpStatus).toHaveBeenCalledWith(expect.anything(), 'usr_1');
  });

  it('setup: rejects malformed input, a wrong password, and maps TotpError by code', async () => {
    const { app } = harness();
    expect((await post(app, '/me/tfa/setup', '{x')).status).toBe(400);
    expect((await post(app, '/me/tfa/setup', {})).status).toBe(400);

    vi.mocked(mfa.verifyStepUpPassword).mockResolvedValue(false);
    const wrong = await post(app, '/me/tfa/setup', { password: 'nope' });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ errors: [{ code: 'INVALID_CREDENTIALS' }] });
    expect(mfa.beginTotpSetup).not.toHaveBeenCalled();

    vi.mocked(mfa.verifyStepUpPassword).mockResolvedValue(true);
    vi.mocked(mfa.beginTotpSetup).mockRejectedValueOnce(new TotpError('ENCRYPTION_NOT_CONFIGURED', 'no key'));
    const unavailable = await post(app, '/me/tfa/setup', { password: 'correct' });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ errors: [{ code: 'ENCRYPTION_NOT_CONFIGURED' }] });

    vi.mocked(mfa.beginTotpSetup).mockRejectedValueOnce(new TotpError('TFA_ALREADY_ENABLED', 'already on'));
    const conflict = await post(app, '/me/tfa/setup', { password: 'correct' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ errors: [{ code: 'TFA_ALREADY_ENABLED' }] });
  });

  it('setup: begins enrollment with the issuer from the environment', async () => {
    const { app } = harness();
    const previous = process.env.HEOPRESS_TOTP_ISSUER;
    process.env.HEOPRESS_TOTP_ISSUER = 'Example Press';
    try {
      const res = await post(app, '/me/tfa/setup', { password: 'correct' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ data: { secret: 'SECRETSECRETSECR', otpauthUrl: 'otpauth://totp/x' } });
      expect(mfa.beginTotpSetup).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), 'usr_1', 'Editor@Example.test', 'Example Press');
    } finally {
      if (previous === undefined) delete process.env.HEOPRESS_TOTP_ISSUER;
      else process.env.HEOPRESS_TOTP_ISSUER = previous;
    }
  });

  it('confirm: validates, maps an expired setup to 410 and a wrong code to 400, and audits enrollment', async () => {
    const { app, audits } = harness();
    expect((await post(app, '/me/tfa/confirm', '{x')).status).toBe(400);
    expect((await post(app, '/me/tfa/confirm', { code: '123456' })).status).toBe(400);

    vi.mocked(mfa.confirmTotpSetup).mockRejectedValueOnce(new TotpError('SETUP_EXPIRED', 'expired'));
    const expired = await post(app, '/me/tfa/confirm', { secret: 'SECRETSECRETSECR', code: '123456' });
    expect(expired.status).toBe(410);

    vi.mocked(mfa.confirmTotpSetup).mockRejectedValueOnce(new TotpError('INVALID_CODE', 'wrong'));
    const wrong = await post(app, '/me/tfa/confirm', { secret: 'SECRETSECRETSECR', code: '123456' });
    expect(wrong.status).toBe(400);

    const ok = await post(app, '/me/tfa/confirm', { secret: 'SECRETSECRETSECR', code: '123456' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: { recoveryCodes: ['aaaa-bbbb'] } });
    expect(audits.some((entry) => entry.event === 'mfa_enrolled')).toBe(true);
  });

  it('recovery codes: needs the password and a live code, then replaces the codes', async () => {
    const { app } = harness();
    const body = { password: 'correct', code: '123456' };
    expect((await post(app, '/me/tfa/recovery-codes', '{x')).status).toBe(400);
    expect((await post(app, '/me/tfa/recovery-codes', { password: 'correct' })).status).toBe(400);

    vi.mocked(mfa.verifyStepUpPassword).mockResolvedValueOnce(false);
    expect((await post(app, '/me/tfa/recovery-codes', body)).status).toBe(401);

    vi.mocked(mfa.verifyUserTotpCode).mockRejectedValueOnce(new TotpError('KEY_UNAVAILABLE', 'dead seed'));
    const dead = await post(app, '/me/tfa/recovery-codes', body);
    expect(dead.status).toBe(409);

    vi.mocked(mfa.verifyUserTotpCode).mockResolvedValueOnce(false);
    const wrong = await post(app, '/me/tfa/recovery-codes', body);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toMatchObject({ errors: [{ code: 'INVALID_CODE' }] });

    vi.mocked(mfa.regenerateRecoveryCodes).mockRejectedValueOnce(new TotpError('TFA_NOT_ENABLED', 'not on'));
    expect((await post(app, '/me/tfa/recovery-codes', body)).status).toBe(409);

    const ok = await post(app, '/me/tfa/recovery-codes', body);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ data: { recoveryCodes: ['cccc-dddd'] } });
  });

  it('disable: refuses a wrong step-up password and maps a dead seed to 409', async () => {
    const { app } = harness();
    const body = { password: 'correct', code: '123456' };
    expect((await del(app, '/me/tfa', '{x')).status).toBe(400);
    expect((await del(app, '/me/tfa', { password: 'correct' })).status).toBe(400);

    vi.mocked(mfa.verifyStepUpPassword).mockResolvedValueOnce(false);
    expect((await del(app, '/me/tfa', body)).status).toBe(401);

    vi.mocked(mfa.verifyUserTotpCode).mockRejectedValueOnce(new TotpError('KEY_UNAVAILABLE', 'dead seed'));
    const dead = await del(app, '/me/tfa', body);
    expect(dead.status).toBe(409);
    expect(mfa.disableUserTotp).not.toHaveBeenCalled();
  });

  it('disable: a wrong code removes nothing', async () => {
    vi.mocked(mfa.verifyUserTotpCode).mockResolvedValue(false);
    const { app } = harness();
    const res = await del(app, '/me/tfa', { password: 'correct', code: '000000' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ errors: [{ code: 'INVALID_CODE' }] });
    expect(mfa.disableUserTotp).not.toHaveBeenCalled();
  });

  it('disable: ends every session and every refresh token, and audits it', async () => {
    const { app, audits } = harness();
    const res = await del(app, '/me/tfa', { password: 'correct', code: '123456' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { disabled: true } });
    expect(mfa.disableUserTotp).toHaveBeenCalledWith(expect.anything(), 'usr_1');
    expect(loginSessions.invalidateAllUserSessions).toHaveBeenCalledWith(expect.anything(), 'usr_1', 'mfa_changed');
    expect(refreshToken.revokeAllRefreshTokens).toHaveBeenCalledWith(expect.anything(), 'site_a', 'usr_1');
    expect(audits.some((entry) => entry.event === 'mfa_disabled')).toBe(true);
  });

  it('disable: a recovery code removes a factor whose seed can no longer be read', async () => {
    const { app } = harness();
    const res = await del(app, '/me/tfa', { password: 'correct', recoveryCode: 'abcd-efgh' });
    expect(res.status).toBe(200);
    expect(mfa.verifyUserRecoveryCode).toHaveBeenCalled();
    expect(mfa.verifyUserTotpCode).not.toHaveBeenCalled();
    expect(mfa.disableUserTotp).toHaveBeenCalledWith(expect.anything(), 'usr_1');
  });

  it('disable: a used-up recovery code removes nothing', async () => {
    vi.mocked(mfa.verifyUserRecoveryCode).mockResolvedValue(false);
    const { app } = harness();
    const res = await del(app, '/me/tfa', { password: 'correct', recoveryCode: 'abcd-efgh' });
    expect(res.status).toBe(401);
    expect(mfa.disableUserTotp).not.toHaveBeenCalled();
  });
});
