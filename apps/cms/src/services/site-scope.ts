import { asc } from 'drizzle-orm';
import { databaseScope, scopedDatabase, sites, type Database } from '@heopress/database';

/**
 * Background entry points under row-level security (HeoPress P14, ADR-0023): a worker gets the root application-role
 * handle, finds its sites in `lumibase_sites` (no row-level security) and runs each site's work in that site's scope.
 */

/**
 * `db` in `siteId`'s scope: a handle already in it as is, one in another scope refused; a pool handle is scoped; a
 * transaction (or a test stand-in) is the caller's, in the scope the caller set.
 */
export function inSiteScope(db: Database, siteId: string): Database {
  const scope = databaseScope(db);
  if (scope && 'site' in scope && scope.site === siteId) return db;
  if (scope) throw new Error(`the database handle is not in site ${siteId}'s scope`);
  const client = (db as { $client?: { unsafe?: unknown; begin?: unknown } }).$client;
  return typeof client?.unsafe === 'function' && typeof client?.begin === 'function' ? scopedDatabase(db, { site: siteId }) : db;
}

/** Every site's id, in id order (`lumibase_sites` has no row-level security). */
export async function allSiteIds(db: Database): Promise<string[]> {
  const rows = await db.select({ id: sites.id }).from(sites).orderBy(asc(sites.id));
  return rows.map((r) => r.id);
}

/**
 * `db`'s connection pool in `siteId`'s scope, whatever scope `db` has (an instance-level path reading one site's rows,
 * e.g. a person's membership there); a transaction (or a test stand-in) is returned as is.
 */
export function siteHandle(db: Database, siteId: string): Database {
  const client = (db as { $client?: { unsafe?: unknown; begin?: unknown } }).$client;
  return typeof client?.unsafe === 'function' && typeof client?.begin === 'function' ? scopedDatabase(db, { site: siteId }) : db;
}
