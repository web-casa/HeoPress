import { eq, sql, type SQL } from 'drizzle-orm';
import { collections, items, type Database } from '@heopress/database';
import type { PermissionService } from '../permission-service';
import { runSiteTransaction } from '../rls-transaction';

/**
 * Which of a site's items a principal may read, as an SQL condition (HeoPress P07 tasks 5.2, 5.4; spec seo/site-audit
 * "审计结果的读取与导出"): what a report or an export shows of a page is limited to these, and the limit is applied where the
 * rows are chosen (Codex review of batch 10, round 2: what the caller cannot see never takes a place of what it can). Per
 * collection, the principal's `read` grant: none, no item of it; a grant with a row rule, the items the rule lets through
 * (the rule as SQL over the items, as every read applies it); an unrestricted grant, all of them; an administrator, all.
 */
export type ReadableScope = (itemId: SQL, collection: SQL) => SQL;

export async function readableScope(db: Database, siteId: string, permissions: Pick<PermissionService, 'bundle' | 'canAccess' | 'whereFor'>): Promise<ReadableScope> {
  if ((await permissions.bundle()).admin) return () => sql`true`;
  const names = (
    await runSiteTransaction(db, siteId, (tx) => tx.select({ name: collections.name }).from(collections).where(eq(collections.siteId, siteId)))
  ).map((r) => r.name);
  const grants: Array<{ name: string; where: SQL | undefined }> = [];
  for (const name of names) {
    const perm = await permissions.canAccess(name, 'read');
    if (perm) grants.push({ name, where: permissions.whereFor(perm) });
  }
  return (itemId, collection) => {
    if (grants.length === 0) return sql`false`;
    const parts = grants.map((g) =>
      g.where
        ? sql`(${collection} = ${g.name} AND EXISTS (SELECT 1 FROM ${items} WHERE ${items.id} = ${itemId} AND ${items.siteId} = ${siteId} AND ${g.where}))`
        : sql`${collection} = ${g.name}`,
    );
    return sql`(${sql.join(parts, sql` OR `)})`;
  };
}
