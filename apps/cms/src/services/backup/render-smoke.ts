import { asc, eq } from 'drizzle-orm';
import { publicHosts, publicItems, type Database } from '@heopress/database';
import { createSiteClassic } from '@heopress/site-classic';

/**
 * The read-only rendering smoke test of a restore drill (HeoPress P13 task 1.3; spec ops/backup-restore
 * "自动恢复演练"): the Classic renderer, in process, on the restored database (a read-only session), asks each public
 * site's home page (up to `limit` sites) and one of its published pages. The home must answer 2xx or 3xx and no page
 * may fail (5xx). AI traffic is not recorded, nothing is swept.
 */

export interface SmokeResult {
  ok: boolean;
  pages: Array<{ host: string; path: string; status: number }>;
  note?: string;
}

export async function renderSmoke(db: Database, limit = 5): Promise<SmokeResult> {
  const hosts = await db.select({ hostname: publicHosts.hostname, siteId: publicHosts.siteId }).from(publicHosts).where(eq(publicHosts.isPrimary, true)).orderBy(asc(publicHosts.hostname)).limit(limit);
  if (hosts.length === 0) return { ok: true, pages: [], note: 'The backup has no public site to render.' };
  const classic = createSiteClassic({ db, traffic: false, sweepIntervalMs: 0, cacheBytes: 1024 * 1024 });
  const pages: SmokeResult['pages'] = [];
  let ok = true;
  try {
    for (const h of hosts) {
      const home = await classic.app.request('/', { headers: { host: h.hostname } });
      pages.push({ host: h.hostname, path: '/', status: home.status });
      if (home.status >= 400) ok = false;
      const [item] = await db
        .select({ path: publicItems.path })
        .from(publicItems)
        .where(eq(publicItems.siteId, h.siteId))
        .orderBy(asc(publicItems.path))
        .limit(1);
      if (item) {
        const page = await classic.app.request(item.path, { headers: { host: h.hostname } });
        pages.push({ host: h.hostname, path: item.path, status: page.status });
        if (page.status >= 500) ok = false;
      }
    }
  } finally {
    await classic.close().catch(() => undefined);
  }
  return { ok, pages };
}
