import { and, asc, eq, sql } from 'drizzle-orm';
import { publicItems, publicSites, type Database } from '@heopress/database';
import { materializedNodes, type StructuredDataDiagnostic } from '@heopress/seo-geo';
import { runSiteTransaction } from '../rls-transaction';

/**
 * What the site's structured data contributions came to (HeoPress P07 tasks 2.9, 2.10; spec seo/page-metadata
 * "关联结构化数据图": conflicts are reported): the site nodes its extensions contribute, what was left out of the
 * extensions' contributions, and the published items whose own structured data or extension nodes had something left
 * out — each removal once — as the public projection materialised them.
 */
export interface StructuredDataReport {
  site: { nodes: Array<{ source: string; fragment: string; type: unknown }>; diagnostics: StructuredDataDiagnostic[] };
  items: Array<{ itemId: string; collection: string; locale: string; path: string; url: string | null; diagnostics: StructuredDataDiagnostic[] }>;
  /** Items with diagnostics in all (`items` lists the first `limit`, by path). */
  itemsWithDiagnostics: number;
}

const diagnosticsOf = (structured: unknown): StructuredDataDiagnostic[] => {
  const list = (structured as { diagnostics?: unknown } | null)?.diagnostics;
  return Array.isArray(list) ? (list as StructuredDataDiagnostic[]) : [];
};

export async function structuredDataReportOf(db: Database, siteId: string, limit = 200): Promise<StructuredDataReport> {
  return runSiteTransaction(db, siteId, async (tx) => {
    const [site] = await tx.select({ structured: publicSites.structured }).from(publicSites).where(eq(publicSites.siteId, siteId));
    const flagged = and(eq(publicItems.siteId, siteId), sql`${publicItems.structured} ? 'diagnostics'`);
    const rows = await tx
      .select({ itemId: publicItems.itemId, collection: publicItems.collection, locale: publicItems.locale, path: publicItems.path, card: publicItems.card, structured: publicItems.structured })
      .from(publicItems)
      .where(flagged)
      .orderBy(asc(publicItems.locale), asc(publicItems.path))
      .limit(limit);
    const [count] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(publicItems).where(flagged);
    return {
      site: {
        nodes: materializedNodes((site?.structured as { nodes?: unknown } | undefined)?.nodes).map((n) => ({ source: n.source, fragment: n.fragment, type: n.node['@type'] })),
        diagnostics: diagnosticsOf(site?.structured),
      },
      items: rows.map((r) => ({
        itemId: r.itemId,
        collection: r.collection,
        locale: r.locale,
        path: r.path,
        url: typeof (r.card as { url?: unknown }).url === 'string' ? ((r.card as { url: string }).url) : null,
        diagnostics: diagnosticsOf(r.structured),
      })),
      itemsWithDiagnostics: count?.n ?? 0,
    };
  });
}
