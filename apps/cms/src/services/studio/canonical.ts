import { and, eq } from 'drizzle-orm';
import { siteDomains, type Database } from '@heopress/database';
import { runSiteTransaction } from '../rls-transaction';

/**
 * The site's canonical domain (HeoPress P07a task 8.2; spec studio/seo-settings): the primary hostname and the active
 * hostnames it may be switched to. Every one of them is public, so members read it; switching stays with `/domains`.
 */
export interface CanonicalView {
  primary: string | null;
  domains: Array<{ id: string; hostname: string; primary: boolean }>;
}

export async function canonicalOf(db: Database, siteId: string): Promise<CanonicalView> {
  const rows = await runSiteTransaction(db, siteId, (tx) =>
    tx
      .select({ id: siteDomains.id, hostname: siteDomains.hostname, primary: siteDomains.isPrimary })
      .from(siteDomains)
      .where(and(eq(siteDomains.siteId, siteId), eq(siteDomains.status, 'active'))),
  );
  return { primary: rows.find((r) => r.primary)?.hostname ?? null, domains: rows.sort((a, b) => a.hostname.localeCompare(b.hostname)) };
}
