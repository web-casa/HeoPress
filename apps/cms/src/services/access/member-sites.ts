import { sql } from 'drizzle-orm';
import { sites, type Database } from '@heopress/database';

/**
 * The sites `userId` belongs to: a membership (`lumibase_user_sites`) or an additional role (`lumibase_user_roles`).
 *
 * Both are site-isolated (HeoPress P14, ADR-0023), so no one statement sees a person's memberships on every site: the
 * sites come from `lumibase_sites` (no row-level security) and each is checked in its own scope, all in one
 * transaction. The scope the caller's transaction had (when `db` is one) is restored before returning.
 */
export async function memberSiteIds(db: Database, userId: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    const [prev] = (await tx.execute(sql`SELECT current_setting('app.site_id', true) AS v`)) as unknown as Array<{ v: string | null }>;
    const all = await tx.select({ id: sites.id }).from(sites).orderBy(sites.id);
    const out: string[] = [];
    for (const { id } of all) {
      await tx.execute(sql`SELECT set_config('app.site_id', ${id}, true)`);
      const rows = (await tx.execute(sql`
        SELECT 1 FROM lumibase_user_sites WHERE user_id = ${userId} AND site_id = ${id}
        UNION ALL
        SELECT 1 FROM lumibase_user_roles WHERE user_id = ${userId} AND site_id = ${id}
        LIMIT 1`)) as unknown as unknown[];
      if (rows.length > 0) out.push(id);
    }
    await tx.execute(sql`SELECT set_config('app.site_id', ${prev?.v ?? ''}, true)`);
    return out;
  });
}
