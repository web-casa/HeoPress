/**
 * Site switching (HeoPress P04 task 9.8, spec sites/site-switching).
 *
 * A person who can enter Studio on several sites extends their login to
 * another of them instead of signing in again. The new site gets its own
 * access JWT and refresh token — site-bound like any other, carrying only
 * that site's permissions — belonging to the same login session, so ending
 * the login ends both.
 *
 * `studioAccessFor` is the one Studio-access decision: the effective
 * permission bundle of the site (roles and policies, policy conditions,
 * MFA requirement) with the bootstrap user allowed everywhere. Login,
 * refresh, the site list and switching all use it.
 *
 * Under row-level security the work runs in explicit site scopes: the
 * source refresh token is read under the source site, the destination's
 * permissions, its new refresh token and the audit entry under the
 * destination; `user_sites`, `users` and login sessions are not
 * site-isolated. The whole exchange is one transaction in the shared lock
 * order (user → login session → token row), so the source cannot be
 * revoked between being checked and the destination being issued.
 */
import { and, eq, sql } from 'drizzle-orm';
import { refreshTokens, sites, userSites, users, type Database } from '@heopress/database';
import { PermissionService } from '../permission-service';
import { AuditLogger } from '../../modules/audit/logger';
import { hashRefreshToken, issueRefreshToken } from './refresh-token';
import { lockUserAndSession, sessionClaims, type LoginSessionRow } from './login-sessions';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type UserRow = typeof users.$inferSelect;

/** Request facts policy conditions can depend on (IP, headers). */
export interface AccessRequestContext {
  ip: string | null;
  headers: Record<string, string>;
}

export interface StudioAccess {
  allowed: boolean;
  mfaRequired: boolean;
  roleName: string | null;
}

/** Set the row-level-security site scope for the rest of this transaction. */
async function scopeTo(tx: Tx | Database, siteId: string): Promise<void> {
  await tx.execute(sql`SELECT set_config('app.site_id', ${siteId}, true)`);
}

/**
 * May `user` use Studio on `siteId`? Call within that site's scope (a
 * transaction scoped to it, or a request for that site).
 */
export async function studioAccessFor(
  db: Database | Tx,
  user: Pick<UserRow, 'id' | 'email' | 'isBootstrap'>,
  siteId: string,
  req: AccessRequestContext,
): Promise<StudioAccess> {
  if (user.isBootstrap) return { allowed: true, mfaRequired: false, roleName: 'Administrator' };
  const bundle = await new PermissionService({
    db: db as Database,
    ctx: {
      userId: user.id,
      siteId,
      roleId: null,
      user: { id: user.id, email: user.email, roles: [] },
      ip: req.ip,
      headers: req.headers,
      apiKey: null,
    },
  }).bundle();
  return { allowed: bundle.appAccess, mfaRequired: bundle.tfaRequired, roleName: bundle.roles[0]?.name ?? null };
}

export interface MySite {
  id: string;
  name: string;
  displayTitle: string | null;
  roleName: string | null;
  current: boolean;
  mfaRequired: boolean;
}

const MAX_SITES = 500;

/** The sites `user` can enter Studio on, each judged in its own scope. */
export async function listMySites(
  db: Database,
  user: Pick<UserRow, 'id' | 'email' | 'isBootstrap'>,
  currentSiteId: string,
  req: AccessRequestContext,
): Promise<MySite[]> {
  const candidates = user.isBootstrap
    ? await db.select({ id: sites.id, name: sites.name, displayTitle: sites.displayTitle }).from(sites).orderBy(sites.name).limit(MAX_SITES)
    : await db
        .select({ id: sites.id, name: sites.name, displayTitle: sites.displayTitle })
        .from(userSites)
        .innerJoin(sites, eq(sites.id, userSites.siteId))
        .where(eq(userSites.userId, user.id))
        .orderBy(sites.name)
        .limit(MAX_SITES);
  const out: MySite[] = [];
  for (const site of candidates) {
    const access = await db.transaction(async (tx) => {
      await scopeTo(tx, site.id);
      return studioAccessFor(tx, user, site.id, req);
    });
    if (!access.allowed) continue;
    out.push({ ...site, roleName: access.roleName, current: site.id === currentSiteId, mfaRequired: access.mfaRequired });
  }
  return out;
}

export type SwitchOutcome =
  | {
      ok: true;
      session: LoginSessionRow;
      user: UserRow;
      roles: string[];
      tokenVersion: number;
      refresh: { token: string; expiresAt: Date };
      site: { id: string; name: string };
    }
  | { ok: false; status: 401; code: 'INVALID_SESSION' }
  | { ok: false; status: 403; code: 'SITE_NOT_ALLOWED' | 'MFA_REQUIRED' };

export interface SwitchInput {
  userId: string;
  /** The login of the access JWT making the request (`sid`). */
  sid: string;
  sourceSiteId: string;
  targetSiteId: string;
  /** The source site's refresh token: proves the login is live here. */
  refreshToken: string;
  req: AccessRequestContext & { userAgent: string | null; requestId: string | null };
  env: Parameters<typeof issueRefreshToken>[2];
}

/**
 * Extend the login to `targetSiteId`. Denials of the destination — not a
 * member, no Studio access, no such site — are one answer
 * (`SITE_NOT_ALLOWED`); the reason is recorded in the audit log only.
 */
export async function switchSite(db: Database, input: SwitchInput): Promise<SwitchOutcome> {
  const tokenHash = await hashRefreshToken(input.refreshToken);
  const invalid = { ok: false, status: 401, code: 'INVALID_SESSION' } as const;

  return db.transaction(async (tx) => {
    // ── the source: under the source site's scope ─────────────────────────
    await scopeTo(tx, input.sourceSiteId);
    const [found] = await tx
      .select({ id: refreshTokens.id, userId: refreshTokens.userId, sessionId: refreshTokens.sessionId })
      .from(refreshTokens)
      .where(and(eq(refreshTokens.tokenHash, tokenHash), eq(refreshTokens.siteId, input.sourceSiteId)))
      .limit(1);
    if (!found || found.userId !== input.userId) return invalid;

    const { user, session } = await lockUserAndSession(tx, input.userId, found.sessionId);
    const [row] = await tx.select().from(refreshTokens).where(eq(refreshTokens.id, found.id)).for('update');
    if (!row || !user) return invalid;
    // Presenting a rotated or revoked token is reuse, here as on refresh:
    // the login ends everywhere. (Studio submits under its refresh lock.)
    if (row.revokedAt) {
      if (session && !session.revokedAt) {
        await tx.execute(sql`
          UPDATE lumibase_auth_sessions SET revoked_at = now(), revoke_reason = 'reuse'
           WHERE id = ${session.id} AND user_id = ${input.userId}`);
      }
      return invalid;
    }
    if (
      !session ||
      session.revokedAt ||
      session.id !== input.sid ||
      row.tokenVersion !== user.tokenVersion ||
      row.expiresAt.getTime() <= Date.now() ||
      user.status !== 'active'
    ) {
      return invalid;
    }

    // ── the destination: under its own scope ──────────────────────────────
    const deny = async (reason: string) => {
      // The reason is for the audit log only; the answer is the same.
      await scopeTo(tx, input.sourceSiteId);
      await new AuditLogger({ db: tx as unknown as Database, siteId: input.sourceSiteId }).writeInTransaction(tx, {
        event: 'auth_site_switch_denied',
        actorEmail: user.email,
        ip: input.req.ip,
        userAgent: input.req.userAgent,
        requestId: input.req.requestId,
        metadata: { targetSiteId: input.targetSiteId, reason },
      });
      return { ok: false, status: 403, code: 'SITE_NOT_ALLOWED' } as const;
    };
    if (input.targetSiteId === input.sourceSiteId) return deny('same_site');
    const [site] = await tx.select({ id: sites.id, name: sites.name }).from(sites).where(eq(sites.id, input.targetSiteId));
    if (!site) return deny('no_such_site');
    await scopeTo(tx, site.id);
    const access = await studioAccessFor(tx, user, site.id, input.req);
    if (!access.allowed) return deny('no_studio_access');
    if (access.mfaRequired && !session.mfaVerified) return { ok: false, status: 403, code: 'MFA_REQUIRED' } as const;

    const [membership] = await tx
      .select({ roleId: userSites.roleId })
      .from(userSites)
      .where(and(eq(userSites.userId, user.id), eq(userSites.siteId, site.id)))
      .limit(1);
    const roles = user.isBootstrap ? ['admin'] : [membership?.roleId ?? 'member'];
    const refresh = await issueRefreshToken(
      tx as unknown as Database,
      {
        siteId: site.id,
        userId: user.id,
        audience: 'studio',
        sessionId: session.id,
        tokenVersion: row.tokenVersion,
        ip: input.req.ip,
        userAgent: input.req.userAgent,
      },
      input.env,
    );
    // In this transaction: no record of a switch that did not happen, and no
    // switch without its record (Codex review P04-4 #3).
    await new AuditLogger({ db: tx as unknown as Database, siteId: site.id }).writeInTransaction(tx, {
      event: 'auth_site_switched',
      actorEmail: user.email,
      ip: input.req.ip,
      userAgent: input.req.userAgent,
      requestId: input.req.requestId,
      metadata: { fromSiteId: input.sourceSiteId, sessionId: session.id },
    });
    return { ok: true, session, user, roles, tokenVersion: row.tokenVersion, refresh, site } as const;
  });
}

