import { sql } from 'drizzle-orm';
import type { Database } from '@heopress/database';

/**
 * Keep every site administered (HeoPress P07a task 12.4; spec studio/settings, design §15). Disabling an account,
 * changing a member's role, removing a member, changing or deleting roles and policies, unlinking a user's policy and
 * an access import all run through {@link guardAdmins}: in one transaction, it locks the people concerned (`users` rows by
 * id), then the administrator memberships of the sites concerned (by site id) — always in that order, so two such
 * changes never deadlock and never both pass — runs the change, and refuses it when a site that had an effective
 * administrator before has none after.
 *
 * An effective administrator of a site: an active account with administrator access there through its primary role,
 * an additional role, or a policy (of one of those roles, or linked to the user) whose administrator access holds
 * unconditionally — no start or end time, no IP rule.
 */

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export class LastAdminError extends Error {
  readonly code = 'LAST_ADMIN';
  constructor(readonly siteIds: string[]) {
    super(`This would leave ${siteIds.length === 1 ? 'a site' : `${siteIds.length} sites`} without an active administrator: ${siteIds.join(', ')}.`);
  }
}

const UNCONDITIONAL = (p: string) => sql.raw(`(
  ${p}.admin_access
  AND ${p}.valid_from IS NULL AND ${p}.valid_until IS NULL
  AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(${p}.ip_allow) = 'array' THEN ${p}.ip_allow END), 0) = 0
  AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(${p}.ip_deny) = 'array' THEN ${p}.ip_deny END), 0) = 0
  AND ${p}.rules->>'validFrom' IS NULL AND ${p}.rules->>'validUntil' IS NULL
  AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(${p}.rules->'ipAllow') = 'array' THEN ${p}.rules->'ipAllow' END), 0) = 0
  AND coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(${p}.rules->'ipDeny') = 'array' THEN ${p}.rules->'ipDeny' END), 0) = 0
)`);

/** The effective administrators of `siteId` (user ids). Each query names the site. */
async function effectiveAdmins(tx: Pick<Tx, 'execute'>, siteId: string): Promise<string[]> {
  const rows = (await tx.execute(sql`
    WITH member_roles AS (
      SELECT us.user_id, us.role_id FROM lumibase_user_sites us WHERE us.site_id = ${siteId} AND us.role_id IS NOT NULL
      UNION
      SELECT ur.user_id, ur.role_id FROM lumibase_user_roles ur WHERE ur.site_id = ${siteId}
    )
    SELECT DISTINCT u.id
    FROM lumibase_users u
    WHERE u.status = 'active' AND (
      EXISTS (SELECT 1 FROM member_roles mr JOIN lumibase_roles r ON r.id = mr.role_id AND r.site_id = ${siteId}
              WHERE mr.user_id = u.id AND r.admin_access)
      OR EXISTS (SELECT 1 FROM member_roles mr
                 JOIN lumibase_role_policies rp ON rp.role_id = mr.role_id
                 JOIN lumibase_policies p ON p.id = rp.policy_id AND p.site_id = ${siteId}
                 WHERE mr.user_id = u.id AND ${UNCONDITIONAL('p')})
      OR EXISTS (SELECT 1 FROM lumibase_user_policies up
                 JOIN lumibase_policies p ON p.id = up.policy_id AND p.site_id = ${siteId}
                 WHERE up.user_id = u.id AND up.site_id = ${siteId} AND ${UNCONDITIONAL('p')})
    )`)) as unknown as Array<{ id: string }>;
  return rows.map((r) => r.id);
}

/** Sites `userId` is a member of (for a change to the account itself). */
export async function sitesOfUser(db: Pick<Database, 'execute'>, userId: string): Promise<string[]> {
  const rows = (await db.execute(sql`SELECT DISTINCT site_id FROM lumibase_user_sites WHERE user_id = ${userId}
                                      UNION SELECT DISTINCT site_id FROM lumibase_user_roles WHERE user_id = ${userId}`)) as unknown as Array<{ site_id: string }>;
  return rows.map((r) => r.site_id);
}

/**
 * Run `change` under the guard: lock `userIds` (users rows, by id), then the administrator memberships of `siteIds` (by
 * site id); refuse with {@link LastAdminError} — the transaction rolled back — when a site loses its last effective
 * administrator.
 */
export async function guardAdmins<T>(db: Database, scope: { siteIds: string[]; userIds?: string[] }, change: (tx: Tx) => Promise<T>): Promise<T> {
  const siteIds = [...new Set(scope.siteIds)].sort();
  const userIds = [...new Set(scope.userIds ?? [])].sort();
  // A test double without raw SQL: nothing to lock or count; the change runs as given (in its transaction if it has one).
  if (typeof (db as Partial<Database>).execute !== 'function') {
    return typeof (db as Partial<Database>).transaction === 'function' ? db.transaction(change) : change(db as unknown as Tx);
  }
  return db.transaction(async (tx) => {
    for (const id of userIds) await tx.execute(sql`SELECT id FROM lumibase_users WHERE id = ${id} FOR UPDATE`);
    const before = new Map<string, number>();
    for (const siteId of siteIds) {
      // The site's administrators' memberships: two changes to the same site's administrators take turns here.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`site-admins:${siteId}`}, 0))`);
      before.set(siteId, (await effectiveAdmins(tx, siteId)).length);
    }
    const result = await change(tx);
    const orphaned: string[] = [];
    for (const siteId of siteIds) {
      if ((before.get(siteId) ?? 0) > 0 && (await effectiveAdmins(tx, siteId)).length === 0) orphaned.push(siteId);
    }
    if (orphaned.length) throw new LastAdminError(orphaned);
    return result;
  });
}
