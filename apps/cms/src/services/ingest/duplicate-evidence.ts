import { and, desc, eq } from 'drizzle-orm';
import { ingestSourceDocuments, type Database } from '@heopress/database';
import { runSiteTransaction } from '../rls-transaction';

/**
 * Duplicate evidence (HeoPress P08 task 4.3; spec ingest/deduplication "跨站点重复", design "数据隔离与去重边界").
 *
 * A same-site near duplicate names the earlier document. A cross-site one names it only to a caller who has rights on
 * the other site **now** — `canReadSite` is evaluated live on every request, never from what was true at detection —
 * and only then is the other site's document read, in that site's scope. Everyone else gets the anonymous flag
 * `duplicateElsewhere: true`: no site, no document id, no title, body or URL.
 */

export type DuplicateEvidence =
  | { scope: null }
  | { scope: 'same_site'; similarity: number | null; document: { id: string; title: string; url: string } | null }
  | { scope: 'cross_site'; duplicateElsewhere: true }
  | { scope: 'cross_site'; similarity: number | null; document: { id: string; siteId: string; title: string; url: string } | null };

export async function duplicateEvidence(
  db: Database,
  siteId: string,
  documentId: string,
  canReadSite: (otherSiteId: string) => Promise<boolean>,
): Promise<DuplicateEvidence | null> {
  const [doc] = await runSiteTransaction(db, siteId, (tx) =>
    tx
      .select({
        duplicateOf: ingestSourceDocuments.duplicateOf,
        scope: ingestSourceDocuments.duplicateScope,
        similarity: ingestSourceDocuments.duplicateSimilarity,
        otherSite: ingestSourceDocuments.duplicateSiteId,
      })
      .from(ingestSourceDocuments)
      .where(and(eq(ingestSourceDocuments.siteId, siteId), eq(ingestSourceDocuments.id, documentId))),
  );
  if (!doc) return null;
  if (!doc.duplicateOf || !doc.scope) return { scope: null };
  const read = (site: string) =>
    runSiteTransaction(db, site, (tx) =>
      tx
        .select({ id: ingestSourceDocuments.id, title: ingestSourceDocuments.title, url: ingestSourceDocuments.url })
        .from(ingestSourceDocuments)
        .where(and(eq(ingestSourceDocuments.siteId, site), eq(ingestSourceDocuments.id, doc.duplicateOf!)))
        .orderBy(desc(ingestSourceDocuments.createdAt))
        .limit(1),
    );
  if (doc.scope === 'same_site') {
    const [other] = await read(siteId);
    return { scope: 'same_site', similarity: doc.similarity, document: other ?? null };
  }
  if (!doc.otherSite || !(await canReadSite(doc.otherSite))) return { scope: 'cross_site', duplicateElsewhere: true };
  const [other] = await read(doc.otherSite);
  return { scope: 'cross_site', similarity: doc.similarity, document: other ? { ...other, siteId: doc.otherSite } : null };
}
