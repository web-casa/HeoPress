import { and, eq } from 'drizzle-orm';
import { roles, type Database } from '@heopress/database';

/**
 * The system roles every site starts with (first-run setup; HeoPress P07 task 0.1, site provisioning).
 * Idempotent through the `roles_site_system_key_unique` index: a second call reads the existing row back.
 *
 *   - `administrator`: `adminAccess` — the PermissionService bundle resolves to full access on the site.
 *   - `member`: Studio access without admin rights; the operator grants what it may do.
 */
const SYSTEM_ROLES = {
  administrator: { key: 'administrator', name: 'Administrator', adminAccess: true, appAccess: true },
  member: { key: 'member', name: 'Member', adminAccess: false, appAccess: true },
} as const;

type SystemRole = keyof typeof SYSTEM_ROLES;

/** The id of the site's system role, created when missing; null only when it can be neither created nor read. */
export async function ensureSystemRole(
  db: Pick<Database, 'insert' | 'select'>,
  siteId: string,
  role: SystemRole,
  description: string,
): Promise<string | null> {
  const def = SYSTEM_ROLES[role];
  const inserted = await db
    .insert(roles)
    .values({ siteId, key: def.key, systemKey: def.key, name: def.name, description, adminAccess: def.adminAccess, appAccess: def.appAccess })
    .onConflictDoNothing()
    .returning({ id: roles.id });
  if (inserted[0]?.id) return inserted[0].id;
  const [existing] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(eq(roles.siteId, siteId), eq(roles.systemKey, def.key)))
    .limit(1);
  return existing?.id ?? null;
}
