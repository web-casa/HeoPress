import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { collections, contentRoutes, items, redirects, translationGroupMembers, type Database } from '@heopress/database';
import { resolvePublicPathWith, type PublicPathRequest, type PublicPathResult, type PublicReadPort } from '@heopress/public-site';
import { resolvePublicHost } from '../domains/public-host';
import { runSiteTransaction } from '../rls-transaction';
import { loadSpace } from './site-rules';

/**
 * Public path resolution over the CMS's own tables (HeoPress P05 tasks 1.6, 3.1, 3.3–3.5): the resolver
 * itself lives in `@heopress/public-site` (P06 task 1.1), shared with the rendering service, which reads
 * the public projection instead. Behaviour unchanged: the CMS reader has no 410 (tombstones are the
 * rendering service's).
 */

export type { PublicPathRequest, PublicPathResult } from '@heopress/public-site';

/**
 * The SQL condition for an item the public may see (design §0): published, not deleted, and not an
 * internal-only translation source (which cannot be published anyway; this keeps it out of every
 * public read should it ever be). Path resolution, language switch data and the public reads use it.
 */
export function publicItemPredicate(): SQL {
  return and(
    eq(items.status, 'published'),
    isNull(items.deletedAt),
    sql`NOT EXISTS (SELECT 1 FROM ${translationGroupMembers} m WHERE m.item_id = ${items.id} AND m.internal_only)`,
  )!;
}

/** The CMS's tables as the resolver's read port. */
function cmsReadPort(db: Database): PublicReadPort {
  return {
    host: (hostname) => resolvePublicHost(db, hostname),
    inSite: (siteId, fn) =>
      runSiteTransaction(db, siteId, (tx) =>
        fn({
          space: (primaryHost) => loadSpace(tx, siteId, { primaryHost }),
          ruleStats: async () => {
            const [row] = (await tx.execute(sql`
              SELECT count(*)::int AS n, coalesce(max(cardinality(string_to_array(trim(both '/' from ${redirects.toPath}), '/'))), 0)::int AS m
              FROM ${redirects} WHERE ${redirects.siteId} = ${siteId}`)) as unknown as Array<{ n: number; m: number }>;
            return { ruleCount: row?.n ?? 0, maxTarget: row?.m ?? 0 };
          },
          redirectsFrom: (urlPaths, content) => {
            const urlScope = and(eq(redirects.scope, 'url'), inArray(redirects.fromPath, urlPaths));
            const contentScope = content ? and(eq(redirects.scope, 'content'), eq(redirects.locale, content.locale), inArray(redirects.fromPath, content.paths)) : undefined;
            return tx
              .select()
              .from(redirects)
              .where(and(eq(redirects.siteId, siteId), contentScope ? or(urlScope, contentScope) : urlScope));
          },
          liveItemAt: async (locale, contentPath) => {
            const [row] = await tx
              .select({ itemId: contentRoutes.itemId, locale: contentRoutes.locale, collection: collections.name })
              .from(contentRoutes)
              .innerJoin(items, eq(items.id, contentRoutes.itemId))
              .innerJoin(collections, eq(collections.id, contentRoutes.collectionId))
              .where(and(eq(contentRoutes.siteId, siteId), eq(contentRoutes.locale, locale), eq(contentRoutes.path, contentPath), publicItemPredicate()));
            return row ?? null;
          },
        }),
      ),
  };
}

export function resolvePublicPath(db: Database, request: PublicPathRequest): Promise<PublicPathResult> {
  return resolvePublicPathWith(cmsReadPort(db), request);
}
