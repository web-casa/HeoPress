/**
 * Per-IP request budget for `POST /auth/login` (HeoPress P03 task 2.3).
 *
 * Runs through the generic {@link RateLimiterProvider} (the logged PostgreSQL
 * table), on its own key so it never shares budget with recovery
 * (`rl:recovery:<ip>`) or MFA. It complements the LoginGuard, which locks
 * accounts and IPs after repeated *failures*; this budget caps *all* attempts.
 *
 *   HEOPRESS_LOGIN_RATE_LIMIT = attempts per IP per site per minute (default 30; 0 = off)
 *
 * Fails closed: if the budget cannot be checked the attempt is refused (429).
 * Requests whose client IP is unknown are not counted here (a shared
 * `unknown` bucket would let one client lock everyone out); the LoginGuard
 * still applies to them.
 */
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { extractClientIp } from '../modules/login-guard/ip-extract';
import {
  consumeRateLimit,
  RATE_LIMIT_UNAVAILABLE_RETRY_SECONDS,
} from './rate-limit-helper';

const LOGIN_RATE_LIMIT_DEFAULT = 30;
const LOGIN_RATE_WINDOW_SECONDS = 60;

function loginLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return LOGIN_RATE_LIMIT_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : LOGIN_RATE_LIMIT_DEFAULT;
}

export function loginRateLimitMiddleware() {
  return createMiddleware<AppEnv>(async (c, next) => {
    const limit = loginLimit(c.env?.HEOPRESS_LOGIN_RATE_LIMIT);
    // Test harnesses that mount the router without a runtime have no limiter.
    const limiter = c.get('runtime')?.rateLimiter;
    const ip = extractClientIp(c);
    if (limit === 0 || !limiter || !ip || ip === 'unknown') return next();

    const siteId = c.get('siteId') ?? 'global';
    const verdict = await consumeRateLimit(limiter, `rl:login:${siteId}:${ip}`, limit, LOGIN_RATE_WINDOW_SECONDS);
    if (verdict.status === 'allow') return next();
    const retryAfter =
      verdict.status === 'unavailable' ? RATE_LIMIT_UNAVAILABLE_RETRY_SECONDS : Math.max(1, verdict.retryAfterSeconds);
    return c.json(
      { errors: [{ code: 'RATE_LIMITED', message: 'Too many login attempts. Try again later.' }] },
      429,
      { 'Retry-After': String(retryAfter) },
    );
  });
}
