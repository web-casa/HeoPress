import { and, asc, eq } from 'drizzle-orm';
import { notifications, sites, users, userSites, type Database } from '@heopress/database';
import { recordSystemEvent } from '../ops/system-events';
import { runSiteTransaction } from '../rls-transaction';
import { allSiteIds, inSiteScope } from '../site-scope';

/**
 * Telling the instance administrator about a failed backup or drill (HeoPress P13 task 1.3; spec ops/backup-restore
 * "演练失败"): an instance event (`error`, in Logs & monitoring for the bootstrap administrator) and a notification to
 * the bootstrap administrator in each site they belong to (the first site when none).
 */
export async function notifyInstanceAdministrator(db: Database, input: { event: string; subject: string; message: string; data?: Record<string, unknown> }): Promise<void> {
  await recordSystemEvent(db, { level: 'error', source: 'scheduler', event: input.event, message: input.subject, data: input.data ?? {} }).catch(() => undefined);
  const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.isBootstrap, true)).limit(1);
  if (!admin) return;
  // One person's memberships across sites: each site's rows are read in its scope (HeoPress P14, ADR-0023).
  const siteIds: string[] = [];
  for (const siteId of await allSiteIds(db)) {
    const rows = await inSiteScope(db, siteId)
      .select({ siteId: userSites.siteId })
      .from(userSites)
      .where(and(eq(userSites.userId, admin.id), eq(userSites.siteId, siteId)));
    if (rows.length > 0) siteIds.push(siteId);
  }
  if (siteIds.length === 0) siteIds.push(...(await db.select({ id: sites.id }).from(sites).orderBy(asc(sites.createdAt)).limit(1)).map((r) => r.id));
  for (const siteId of [...new Set(siteIds)]) {
    await runSiteTransaction(db, siteId, (tx) => tx.insert(notifications).values({ siteId, recipient: admin.id, subject: input.subject.slice(0, 300), message: input.message.slice(0, 4000) })).catch(() => undefined);
  }
}
