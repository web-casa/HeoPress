import { eq, sql } from 'drizzle-orm';
import { collections, siteDomains, sites, type Database } from '@heopress/database';
import { runSiteTransaction, withSiteScope } from '../rls-transaction';
import { lockContentSettingsExclusive, releaseMemberships, withTransactionRetry } from './translation-groups';

/** Serialises deletions: the count of remaining sites is taken under it (an arbitrary constant: "site"). */
const KEEP_ONE_LOCK = 0x73697465;

export interface DeleteSiteResult {
  outcome: 'deleted' | 'missing' | 'last' | 'caller_gone';
  /** What caches may still hold of the site, read under the same locks as the deletion. */
  hostnames: string[];
  collections: string[];
}

export interface DeleteSiteOptions {
  /**
   * The site the request comes from (the instance control plane): it must still exist when the deletion
   * happens — two requests deleting each other's sites are serialised, the second refused — and `record`
   * writes there, in its scope, in the deletion's transaction (the record and the deletion stand or fall together).
   */
  caller?: { siteId: string; record: (tx: Database) => Promise<void> };
}

/**
 * Delete a site and everything it owns (cascades), its items leaving other sites' translation
 * groups first so those groups stay consistent (HeoPress P05, design R44). The last site is never
 * deleted (HeoPress P07 task 0.1: signing in, the instance control plane included, needs a site);
 * deletions are serialised so two of them cannot both see another site left. The database remembers the
 * id (migration 0042): a new site cannot take it while caches may remember this one.
 * Answers the outcome and the site's host and collection names, for the caller to clear its caches.
 */
export async function deleteSite(db: Database, siteId: string, opts: DeleteSiteOptions = {}): Promise<DeleteSiteResult> {
  const none = (outcome: DeleteSiteResult['outcome']): DeleteSiteResult => ({ outcome, hostnames: [], collections: [] });
  return withTransactionRetry(db, () =>
    runSiteTransaction(db, siteId, async (tx): Promise<DeleteSiteResult> => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${KEEP_ONE_LOCK})`);
      const [row] = (await tx.execute(
        sql`SELECT count(*)::int AS n, bool_or(${sites.id} = ${siteId}) AS present, bool_or(${sites.id} = ${opts.caller?.siteId ?? null}) AS caller FROM ${sites}`,
      )) as unknown as Array<{ n: number; present: boolean | null; caller: boolean | null }>;
      if (!row?.present) return none('missing');
      if (row.n <= 1) return none('last');
      if (opts.caller && (!row.caller || opts.caller.siteId === siteId)) return none('caller_gone');
      // Exclusively from the start (design R46): no join of its items meanwhile, no lock upgrade at the cascade.
      await lockContentSettingsExclusive(tx, siteId);
      const hostnames = (await tx.select({ h: siteDomains.hostname }).from(siteDomains).where(eq(siteDomains.siteId, siteId))).map((r) => r.h);
      const names = (await tx.select({ n: collections.name }).from(collections).where(eq(collections.siteId, siteId))).map((r) => r.n);
      await releaseMemberships(tx, siteId);
      await tx.delete(sites).where(eq(sites.id, siteId));
      if (opts.caller) {
        const caller = opts.caller;
        await withSiteScope(tx as never, caller.siteId, () => caller.record(tx as unknown as Database));
      }
      return { outcome: 'deleted', hostnames, collections: names };
    }),
  );
}
