// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import type { Context } from 'hono';
import { and, eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { roles, userSites, users, type Database } from '@heopress/database';
import { createLoginSession, sessionClaims } from './login-sessions';
import type { AppEnv } from '../../env';
import {
  TOKEN_AUDIENCE,
  sessionTtlFor,
} from './token-audience';
import {
  issueRefreshToken,
  refreshCookieSettings,
} from './refresh-token';
import { refreshTtlFor, ttlToSeconds } from './token-audience';
import { setCookie } from 'hono/cookie';

const REFRESH_COOKIE = 'heopress_refresh';
const REFRESH_COOKIE_PATH = '/api/v1/auth';

function refreshCookieBase(c: Context<AppEnv>) {
  const { sameSite, secure, domain } = refreshCookieSettings(c.env);
  return {
    httpOnly: true,
    secure,
    sameSite,
    path: REFRESH_COOKIE_PATH,
    ...(domain ? { domain } : {}),
  } as const;
}

function setRefreshCookie(c: Context<AppEnv>, token: string, audience: string): void {
  setCookie(c, REFRESH_COOKIE, token, {
    ...refreshCookieBase(c),
    maxAge: ttlToSeconds(refreshTtlFor(audience, c.env)),
  });
}

async function signSessionJwt(
  payload: Record<string, unknown>,
  secret: string,
  audience: string,
  ttl: string,
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(ttl)
    .sign(secretKey);
}

type UserRow = typeof users.$inferSelect;

/**
 * Begin a login (HeoPress P04): its login session, its first refresh token
 * (new family, the user's current token_version) and its access JWT, which
 * carries `sid`, `authTime` and the MFA status. Session row and refresh token
 * are written in one transaction.
 */
export async function issueLoginTokens(
  c: Context<AppEnv>,
  options: {
    user: UserRow;
    siteId: string;
    audience: string;
    roles: string[];
    tfaVerified?: boolean;
    amr?: string[];
    /**
     * The user's token_version when the credentials were checked. The login
     * is issued only if it is still current (checked under the user lock):
     * a password change or reset in between voids the authentication.
     */
    expectedTokenVersion: number;
  },
): Promise<{ token: string; refresh: { token: string; expiresAt: Date } } | 'stale' | null> {
  const jwtSecret = c.env.JWT_SECRET || process.env.JWT_SECRET;
  if (!jwtSecret) return null;
  const db = c.get('db');
  const ip = c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  const tokenVersion = options.expectedTokenVersion;

  const issued = await db.transaction(async (tx) => {
    // The shared lock order starts with the user row.
    const [locked] = await tx.select().from(users).where(eq(users.id, options.user.id)).for('update');
    if (!locked || locked.status !== 'active' || (locked.tokenVersion ?? 0) !== tokenVersion) return 'stale' as const;
    const session = await createLoginSession(tx as unknown as Database, {
      userId: options.user.id,
      mfaVerified: Boolean(options.tfaVerified),
      amr: options.amr?.length ? options.amr : ['pwd'],
      source: 'password',
      ip,
      userAgent,
    });
    const refresh = await issueRefreshToken(
      tx as unknown as Database,
      { siteId: options.siteId, userId: options.user.id, audience: options.audience, sessionId: session.id, tokenVersion, ip, userAgent },
      c.env,
    );
    return { session, refresh };
  });
  if (issued === 'stale') return 'stale';
  const { session, refresh } = issued;

  const token = await signSessionJwt(
    {
      userId: options.user.id,
      email: options.user.email,
      roles: options.roles,
      siteId: options.siteId,
      // Session generation at sign time; auth rejects tokens whose value is
      // older than the stored one (revocation on password change/reset).
      tokenVersion,
      ...sessionClaims(session),
    },
    jwtSecret,
    options.audience,
    sessionTtlFor(options.audience, c.env),
  );
  setRefreshCookie(c, refresh.token, options.audience);
  return { token, refresh };
}

export async function completePasswordLoginSession(
  c: Context<AppEnv>,
  options: {
    user: UserRow;
    siteId: string;
    audience: string;
    tfaVerified?: boolean;
    amr?: string[];
    /** token_version when the password was checked (from the MFA challenge). */
    expectedTokenVersion: number;
  },
) {
  const db = c.get('db');
  const [membership] = await db
    .select({ roleId: userSites.roleId })
    .from(userSites)
    .where(and(eq(userSites.userId, options.user.id), eq(userSites.siteId, options.siteId)))
    .limit(1);

  const tokenRoles = options.user.isBootstrap ? ['admin'] : [membership?.roleId ?? 'member'];
  const issued = await issueLoginTokens(c, { ...options, roles: tokenRoles });
  if (issued === 'stale') {
    return c.json({ errors: [{ code: 'CHALLENGE_EXPIRED', message: 'Sign in again: the password changed during sign-in.' }] }, 401);
  }
  if (!issued) {
    return c.json({ errors: [{ code: 'AUTH_NOT_CONFIGURED', message: 'JWT_SECRET configuration missing.' }] }, 500);
  }

  return c.json({
    data: {
      token: issued.token,
      refreshToken: issued.refresh.token,
      refreshTokenExpiresAt: issued.refresh.expiresAt.toISOString(),
      user: {
        id: options.user.id,
        email: options.user.email,
        firstName: options.user.firstName,
        lastName: options.user.lastName,
        avatar: options.user.avatar,
      },
    },
  });
}
