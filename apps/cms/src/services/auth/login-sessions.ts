/**
 * Login sessions (HeoPress P04 task 9.7, spec sites/site-switching).
 *
 * One row per authenticated login (`lumibase_auth_sessions`, user level).
 * The refresh tokens of that login — on the site the person signed in to and
 * on each site it was extended to — and its access JWTs (`sid`) all depend on
 * it:
 *
 *   - revoking it ends the login on every site at once (logout, reuse of a
 *     rotated refresh token, "log out of all devices");
 *   - a refresh token also carries the user's `token_version` from when the
 *     login began; a password change or reset raises the user's version, so
 *     every older token of every site is refused without touching its row
 *     (rows are site-isolated; the session and user rows are not);
 *   - it records how the person authenticated, so refreshes and switches
 *     carry the same `authTime` and MFA status — neither upgraded nor lost.
 *
 * **Lock order.** Every path that changes a login's state — refresh,
 * switching, logout, reuse revocation, password change or reset, MFA
 * changes, revoking a session — locks in the same order: the `users` row,
 * then the `auth_sessions` row, then the refresh-token row. Per user they
 * run one after another, so nothing can be revoked between "checked live"
 * and "issued".
 *
 * The table is not site-scoped and not exposed as a collection: every
 * statement here names the user it acts for.
 */
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { authSessions, users, type Database } from '@heopress/database';

type Db = Pick<Database, 'select' | 'insert' | 'update' | 'execute'>;
export type LoginSessionRow = typeof authSessions.$inferSelect;

export type RevokeReason =
  | 'logout'
  | 'logout_all'
  | 'reuse'
  | 'password_changed'
  | 'password_reset'
  | 'mfa_changed'
  | 'user_disabled'
  | 'revoked_by_user';

export interface StartLoginSession {
  userId: string;
  mfaVerified: boolean;
  amr: string[];
  source: 'password';
  ip?: string | null;
  userAgent?: string | null;
  authTime?: Date;
}

export async function createLoginSession(db: Db, input: StartLoginSession): Promise<LoginSessionRow> {
  const [row] = await db
    .insert(authSessions)
    .values({
      userId: input.userId,
      authTime: input.authTime ?? new Date(),
      amr: input.amr,
      mfaVerified: input.mfaVerified,
      source: input.source,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null,
    })
    .returning();
  return row!;
}

/**
 * Lock the user row, then the login session row (the shared lock order).
 * Run inside a transaction. Returns both rows, or nulls when missing.
 */
export async function lockUserAndSession(
  tx: Db,
  userId: string,
  sessionId: string | null,
): Promise<{ user: typeof users.$inferSelect | null; session: LoginSessionRow | null }> {
  const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
  if (!user || !sessionId) return { user: user ?? null, session: null };
  const [session] = await tx
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)))
    .for('update');
  return { user, session: session ?? null };
}

/** End one login on every site. Locks user → session. Returns whether it was live. */
export async function revokeLoginSession(
  db: Database,
  userId: string,
  sessionId: string,
  reason: RevokeReason,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const { session } = await lockUserAndSession(tx as unknown as Db, userId, sessionId);
    if (!session || session.revokedAt) return false;
    await tx
      .update(authSessions)
      .set({ revokedAt: new Date(), revokeReason: reason })
      .where(and(eq(authSessions.id, sessionId), eq(authSessions.userId, userId)));
    return true;
  });
}

/**
 * End every login of a user (all devices, all sites). Inside a transaction
 * that already holds the user row lock, pass `tx`; otherwise it takes it.
 */
export async function revokeAllLoginSessions(
  db: Database | Db,
  userId: string,
  reason: RevokeReason,
  opts: { locked?: boolean } = {},
): Promise<number> {
  const run = async (tx: Db) => {
    if (!opts.locked) await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    const rows = await tx
      .update(authSessions)
      .set({ revokedAt: new Date(), revokeReason: reason })
      .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)))
      .returning({ id: authSessions.id });
    return rows.length;
  };
  if (opts.locked || !('transaction' in db)) return run(db as Db);
  return (db as Database).transaction((tx) => run(tx as unknown as Db));
}

/**
 * Raise the user's `token_version` (password changed or reset, MFA turned
 * off) and end all their logins, in one transaction under the user lock:
 * every access JWT and refresh token of every site issued before is refused.
 */
export async function invalidateAllUserSessions(
  db: Database,
  userId: string,
  reason: RevokeReason,
  /** Changed together with the generation (e.g. the new password hash). */
  userFields: Partial<typeof users.$inferInsert> = {},
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    await tx
      .update(users)
      .set({ ...userFields, tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: new Date() })
      .where(eq(users.id, userId));
    await revokeAllLoginSessions(tx as unknown as Db, userId, reason, { locked: true });
  });
}

/** Claims every access JWT of this login carries (sid, authTime, MFA status). */
export function sessionClaims(session: Pick<LoginSessionRow, 'id' | 'authTime' | 'mfaVerified' | 'amr'>): Record<string, unknown> {
  const claims: Record<string, unknown> = {
    sid: session.id,
    authTime: Math.floor(session.authTime.getTime() / 1000),
  };
  if (session.mfaVerified) claims.tfaVerified = true;
  if (session.amr.length > 0) claims.amr = session.amr;
  return claims;
}

export interface LoginSessionSummary {
  id: string;
  createdAt: Date;
  authTime: Date;
  mfaVerified: boolean;
  ip: string | null;
  userAgent: string | null;
  current: boolean;
}

/** The user's live logins, newest first (for `GET /me/sessions`). */
export async function listLoginSessions(db: Db, userId: string, currentSid: string | null): Promise<LoginSessionSummary[]> {
  // Live: not revoked and not past the expiry of its last refresh token.
  const rows = await db
    .select()
    .from(authSessions)
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, new Date())))
    .orderBy(desc(authSessions.createdAt))
    .limit(100);
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt,
    authTime: r.authTime,
    mfaVerified: r.mfaVerified,
    ip: r.ip,
    userAgent: r.userAgent,
    current: r.id === currentSid,
  }));
}
