import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { siteExports, sites, type Database } from '@heopress/database';
import type { KeyProvider, StorageProvider } from '@heopress/runtime';
import { runSiteTransaction } from '../rls-transaction';
import { exportSite } from './export-service';

/**
 * Single-site exports asked for from Studio or the API (HeoPress P13 task 1.2): a `queued` row per request, taken up by
 * the worker (`processSiteExports`, every minute), which writes the bundle under `HEOPRESS_SITE_EXPORT_DIR/<site>/<id>`
 * as the person who asked — the export checks again that they administer the site.
 */

export type SiteExportRow = typeof siteExports.$inferSelect;

/** Where bundles go (default `./data/exports`). */
export function siteExportDir(env: Record<string, string | undefined>): string {
  return path.resolve(env.HEOPRESS_SITE_EXPORT_DIR?.trim() || './data/exports');
}

export async function requestSiteExport(db: Database, siteId: string, requestedBy: string | null): Promise<SiteExportRow> {
  const [row] = await runSiteTransaction(db, siteId, (tx) => tx.insert(siteExports).values({ siteId, status: 'queued', requestedBy }).returning());
  return row!;
}

export async function listSiteExports(db: Database, siteId: string, limit = 20): Promise<SiteExportRow[]> {
  return runSiteTransaction(db, siteId, (tx) => tx.select().from(siteExports).where(eq(siteExports.siteId, siteId)).orderBy(desc(siteExports.createdAt)).limit(limit));
}

export async function processSiteExports(deps: { db: Database; keys: KeyProvider; defaultStorage: StorageProvider; storageDir?: string; exportDir: string }): Promise<number> {
  const { db } = deps;
  let done = 0;
  for (const { id: siteId } of await db.select({ id: sites.id }).from(sites).orderBy(sites.id)) {
    const queued = await runSiteTransaction(db, siteId, (tx) => tx.select().from(siteExports).where(and(eq(siteExports.siteId, siteId), eq(siteExports.status, 'queued'))).orderBy(siteExports.createdAt));
    for (const row of queued) {
      const claimed = await runSiteTransaction(db, siteId, (tx) =>
        tx.update(siteExports).set({ status: 'running' }).where(and(eq(siteExports.id, row.id), eq(siteExports.status, 'queued'))).returning({ id: siteExports.id }),
      );
      if (claimed.length === 0) continue;
      const dir = path.join(deps.exportDir, siteId, row.id);
      try {
        const report = await exportSite(deps, { siteId, actor: { userId: row.requestedBy }, dir });
        await runSiteTransaction(db, siteId, (tx) =>
          tx
            .update(siteExports)
            .set({ status: 'succeeded', location: dir, bundleHash: report.bundleHash, items: report.items, media: report.media, report: report as unknown as Record<string, unknown>, finishedAt: new Date() })
            .where(eq(siteExports.id, row.id)),
        );
      } catch (err) {
        await runSiteTransaction(db, siteId, (tx) =>
          tx
            .update(siteExports)
            .set({ status: 'failed', error: (err instanceof Error ? err.message : String(err)).slice(0, 2000), finishedAt: new Date() })
            .where(eq(siteExports.id, row.id)),
        );
      }
      done++;
    }
  }
  return done;
}
