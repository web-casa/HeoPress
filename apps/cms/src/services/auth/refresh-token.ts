// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Rotating, revocable refresh tokens (see `schema/access.ts:refreshTokens`).
 *
 * The login access JWT is a short working credential; this refresh token is
 * the longer-lived, server-side-tracked secret that silently renews it via
 * `POST /auth/refresh`. Security model:
 *
 *   - **Hashed at rest** — only `sha256(plaintext)` is stored; the plaintext
 *     is handed to the client once (login/refresh) and never persisted.
 *   - **One-time use / rotation** — every refresh revokes the presented row
 *     and issues a new one in the same `familyId`.
 *   - **Reuse detection** — presenting an already-revoked token is the
 *     classic stolen-token signal, so the entire `familyId` is revoked,
 *     logging out both the attacker and the legitimate holder (who must
 *     re-authenticate). A benign double-submit trips this too; that is the
 *     accepted cost of strict rotation.
 *
 * Web Crypto only (`crypto.subtle` / `randomUUID` / `getRandomValues`) so it
 * runs unchanged on both Cloudflare Workers and Node.
 */

import { authSessions, refreshTokens, type Database } from '@heopress/database';
import { lockUserAndSession, revokeLoginSession, type LoginSessionRow } from './login-sessions';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { refreshTtlFor, ttlToSeconds } from './token-audience';

/** Entropy of the raw refresh secret. 32 bytes = 256 bits. */
const TOKEN_BYTES = 32;

const textEncoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** sha256(plaintext) hex — the stored lookup key. */
export async function hashRefreshToken(plaintext: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(plaintext));
  return toHex(new Uint8Array(digest));
}

function newSecret(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(TOKEN_BYTES)));
}

export interface RefreshTtlEnv {
  STUDIO_REFRESH_TTL?: string;
  FRONTEND_REFRESH_TTL?: string;
}

/** Header a client echoes to drive cookie-based refresh/logout (CSRF brake). */
export const REFRESH_CSRF_HEADER = 'x-heopress-refresh';

/**
 * CSRF decision for the refresh/logout endpoints. A cookie is an ambient
 * credential (CSRF-reachable under `SameSite=None`), so it additionally
 * requires a custom header that a cross-site simple request cannot set. A
 * body-supplied token is explicit and exempt.
 */
export function refreshCsrfOk(
  source: 'body' | 'cookie' | 'none',
  headerValue: string | undefined,
): boolean {
  if (source !== 'cookie') return true;
  return (headerValue ?? '').trim().length > 0;
}

export interface RefreshCookieEnv {
  /** `Lax` (default) | `Strict` | `None`. `None` is required for cross-site. */
  REFRESH_COOKIE_SAMESITE?: string;
  /** Cookie `Domain`, e.g. `.example.com` to share across subdomains. */
  REFRESH_COOKIE_DOMAIN?: string;
  /** `"false"` allows the cookie over plain http (local dev only). */
  REFRESH_COOKIE_SECURE?: string;
}

export interface RefreshCookieSettings {
  sameSite: 'Lax' | 'Strict' | 'None';
  secure: boolean;
  domain?: string;
}

/**
 * Resolve the cross-domain cookie attributes from env. Defaults to the
 * safe same-site posture (`Lax`, `Secure`, no explicit domain). Browsers
 * reject `SameSite=None` without `Secure`, so `None` always forces
 * `secure: true` regardless of the override.
 */
export function refreshCookieSettings(env?: RefreshCookieEnv): RefreshCookieSettings {
  const raw = env?.REFRESH_COOKIE_SAMESITE?.trim().toLowerCase();
  const sameSite: RefreshCookieSettings['sameSite'] =
    raw === 'none' ? 'None' : raw === 'strict' ? 'Strict' : 'Lax';

  // Default secure=true; only an explicit "false" (dev over http) disables
  // it — but SameSite=None mandates Secure, so it wins.
  let secure = env?.REFRESH_COOKIE_SECURE?.trim().toLowerCase() !== 'false';
  if (sameSite === 'None') secure = true;

  const domain = env?.REFRESH_COOKIE_DOMAIN?.trim();
  return { sameSite, secure, ...(domain ? { domain } : {}) };
}

export interface IssuedRefreshToken {
  /** Row id of the inserted token. */
  id: string;
  /** Plaintext secret — return to the client, never log or store. */
  token: string;
  expiresAt: Date;
  familyId: string;
}

interface IssueArgs {
  siteId: string;
  userId: string;
  audience: string;
  /** Reuse the chain id on rotation; omit to start a new family at login. */
  familyId?: string;
  /** The login session this token renews (P04). */
  sessionId: string;
  /** The user's token_version when the login began; never raised later. */
  tokenVersion: number;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Insert a fresh refresh-token row and return its plaintext. Used by login
 * (new family) and rotation (same family). `db` may be a transaction.
 */
export async function issueRefreshToken(
  db: Database,
  args: IssueArgs,
  env: RefreshTtlEnv | undefined,
): Promise<IssuedRefreshToken> {
  const token = newSecret();
  const tokenHash = await hashRefreshToken(token);
  const familyId = args.familyId ?? crypto.randomUUID();
  const ttlSeconds = ttlToSeconds(refreshTtlFor(args.audience, env));
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const [row] = await db
    .insert(refreshTokens)
    .values({
      siteId: args.siteId,
      userId: args.userId,
      audience: args.audience,
      tokenHash,
      familyId,
      expiresAt,
      lastIp: args.ip ?? null,
      lastUserAgent: args.userAgent ?? null,
      sessionId: args.sessionId,
      tokenVersion: args.tokenVersion,
    })
    .returning({ id: refreshTokens.id });
  // The login lasts as long as its latest refresh token.
  await db
    .update(authSessions)
    .set({ expiresAt: sql`GREATEST(COALESCE(${authSessions.expiresAt}, ${expiresAt.toISOString()}::timestamptz), ${expiresAt.toISOString()}::timestamptz)` })
    .where(eq(authSessions.id, args.sessionId));

  return { id: row!.id, token, expiresAt, familyId };
}

/**
 * Revoke every still-live token in a family. Shared by rotation's
 * reuse-detection paths and {@link revokeRefreshToken}. Accepts a tx or db.
 */
async function revokeFamily(
  db: Database,
  siteId: string,
  familyId: string,
): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.siteId, siteId),
        eq(refreshTokens.familyId, familyId),
        isNull(refreshTokens.revokedAt),
      ),
    );
}

export type RefreshOutcome =
  | {
      ok: true;
      userId: string;
      audience: string;
      token: string;
      expiresAt: Date;
      /** The login this token renews: its sid, authTime and MFA status go into the new JWT. */
      session: LoginSessionRow;
      /** The generation the login was issued under (unchanged by rotation). */
      tokenVersion: number;
    }
  | { ok: false; reason: 'invalid' | 'expired' | 'reuse' | 'ended' | 'stale' };

/**
 * Verify + rotate a presented refresh token within a transaction, in the
 * shared lock order (user → login session → token row; see
 * `login-sessions.ts`). Refused when the login has ended (`ended`), when
 * the user's password changed since it began (`stale`), when expired, or
 * unknown. Presenting a token that was already rotated or revoked is
 * reuse: the family and the whole login (every site) are revoked.
 */
export async function rotateRefreshToken(
  db: Database,
  args: { rawToken: string; siteId: string; ip?: string | null; userAgent?: string | null },
  env: RefreshTtlEnv | undefined,
): Promise<RefreshOutcome> {
  const tokenHash = await hashRefreshToken(args.rawToken);

  return db.transaction(async (tx) => {
    const [found] = await tx
      .select({ id: refreshTokens.id, userId: refreshTokens.userId, sessionId: refreshTokens.sessionId })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, tokenHash), eq(refreshTokens.siteId, args.siteId)))
      .limit(1);
    if (!found) return { ok: false, reason: 'invalid' } as const;

    const { user, session } = await lockUserAndSession(tx as unknown as Database, found.userId, found.sessionId);
    const [row] = await tx.select().from(refreshTokens).where(eq(refreshTokens.id, found.id)).for('update');
    if (!row || !user) return { ok: false, reason: 'invalid' } as const;

    // Reuse of a dead token → the theft response: this chain and the whole
    // login, on every site.
    if (row.revokedAt) {
      await revokeFamily(tx as unknown as Database, args.siteId, row.familyId);
      if (session && !session.revokedAt) {
        await tx
          .update(authSessions)
          .set({ revokedAt: new Date(), revokeReason: 'reuse' })
          .where(and(eq(authSessions.id, session.id), eq(authSessions.userId, user.id)));
      }
      return { ok: false, reason: 'reuse' } as const;
    }

    const kill = async (reason: 'ended' | 'stale' | 'expired') => {
      await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));
      return { ok: false, reason } as const;
    };
    // A token of no login (before P04), or of an ended one.
    if (!session || session.revokedAt) return kill('ended');
    // Issued before the user's password changed or was reset.
    if (row.tokenVersion !== user.tokenVersion) return kill('stale');
    if (row.expiresAt.getTime() <= Date.now()) return kill('expired');

    // The row is locked: this caller alone rotates it.
    await tx.update(refreshTokens).set({ revokedAt: new Date() }).where(eq(refreshTokens.id, row.id));

    // The successor: same family, same login, same generation.
    const next = await issueRefreshToken(
      tx as unknown as Database,
      {
        siteId: args.siteId,
        userId: row.userId,
        audience: row.audience,
        familyId: row.familyId,
        sessionId: session.id,
        tokenVersion: row.tokenVersion,
        ip: args.ip,
        userAgent: args.userAgent,
      },
      env,
    );

    await tx
      .update(refreshTokens)
      .set({ replacedBy: next.id })
      .where(eq(refreshTokens.id, row.id));

    return {
      ok: true,
      userId: row.userId,
      audience: row.audience,
      token: next.token,
      expiresAt: next.expiresAt,
      session,
      tokenVersion: row.tokenVersion,
    } as const;
  });
}

/**
 * Logout: end the login the presented token belongs to — on every site it
 * reached — and revoke its chain here. Idempotent; a missing or already
 * revoked token is a no-op. Returns true when something was revoked.
 */
export async function revokeRefreshToken(
  db: Database,
  rawToken: string,
  siteId: string,
): Promise<boolean> {
  const tokenHash = await hashRefreshToken(rawToken);
  const [row] = await db
    .select({ familyId: refreshTokens.familyId, userId: refreshTokens.userId, sessionId: refreshTokens.sessionId })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, tokenHash), eq(refreshTokens.siteId, siteId)))
    .limit(1);
  if (!row) return false;

  const ended = row.sessionId ? await revokeLoginSession(db, row.userId, row.sessionId, 'logout') : false;
  const revoked = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.siteId, siteId),
        eq(refreshTokens.familyId, row.familyId),
        isNull(refreshTokens.revokedAt),
      ),
    )
    .returning({ id: refreshTokens.id });
  return ended || revoked.length > 0;
}

/**
 * Revoke every active refresh token for a user on a site — e.g. after a
 * password reset, so existing sessions cannot be silently renewed.
 */
export async function revokeAllRefreshTokens(
  db: Database,
  siteId: string,
  userId: string,
): Promise<void> {
  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(refreshTokens.siteId, siteId),
        eq(refreshTokens.userId, userId),
        isNull(refreshTokens.revokedAt),
      ),
    );
}

/**
 * Delete refresh-token rows that have passed their natural expiry. Revoked
 * rows keep their original `expiresAt`, so they linger until then — which
 * preserves reuse-detection for a token's whole intended lifetime, then are
 * swept here. Returns the deleted count. Best-effort by the caller.
 */
export async function pruneRefreshTokens(
  db: Database,
  before: Date = new Date(),
): Promise<number> {
  const deleted = await db
    .delete(refreshTokens)
    .where(lt(refreshTokens.expiresAt, before))
    .returning({ id: refreshTokens.id });
  // Logins whose every refresh token has expired are over (P04).
  await db.delete(authSessions).where(lt(authSessions.expiresAt, before));
  return deleted.length;
}

/**
 * Scheduled-cron wrapper for {@link pruneRefreshTokens} — mirrors the audit
 * rotator glue. NEVER throws: a cron tick (or Workers `scheduled` handler)
 * must not surface a runtime error.
 */
export async function runScheduledRefreshTokenPrune(db: Database): Promise<{ deleted: number }> {
  try {
    const deleted = await pruneRefreshTokens(db);
    console.log(`[heopress-cms] refresh-token prune removed ${deleted} expired row(s).`);
    return { deleted };
  } catch (err) {
    console.error('[heopress-cms] refresh-token prune failed:', err);
    return { deleted: 0 };
  }
}
