import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { AppEnv } from '../env';
import { loginRateLimitMiddleware } from '../middleware/login-rate-limit';
import { checkRecoveryRateLimit } from '../modules/recovery/rate-limit';
import { checkTotpVerifyRateLimit } from '../modules/mfa/rate-limit';

/**
 * Security budgets fail closed (P03 task 2.4): when the rate limiter cannot
 * answer — the database is down — login, recovery and MFA verification are
 * refused instead of allowed uncounted.
 */

const broken = { consume: async () => { throw new Error('database unavailable'); } };

describe('security rate limits fail closed', () => {
  it('login answers 429 with Retry-After when the limiter fails', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('runtime', { rateLimiter: broken } as never);
      await next();
    });
    app.use('/login', loginRateLimitMiddleware());
    app.post('/login', (c) => c.text('reached'));
    const res = await app.request('/login', { method: 'POST', headers: { 'cf-connecting-ip': '203.0.113.1' } });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });

  it('recovery and MFA verification are refused when the limiter fails', async () => {
    expect((await checkRecoveryRateLimit(broken, '203.0.113.2')).allowed).toBe(false);
    expect((await checkTotpVerifyRateLimit(broken, 'user-1', '203.0.113.3')).allowed).toBe(false);
  });

  it('a working limiter still lets requests through', async () => {
    const ok = { consume: async () => ({ allowed: true, remaining: 1, resetAt: 0 }) };
    expect((await checkRecoveryRateLimit(ok, '203.0.113.4')).allowed).toBe(true);
    expect((await checkTotpVerifyRateLimit(ok, 'user-2', '203.0.113.5')).allowed).toBe(true);
  });
});
