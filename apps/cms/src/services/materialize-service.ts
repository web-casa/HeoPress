// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Materialize Service — POST-GA Task #4.
 *
 * Handles physical table creation, refresh, and cleanup for materialized
 * collections. Provides denormalized read tables for hot-path delivery API
 * traffic.
 *
 * Strategy:
 *   1. `createPhysicalTable()` — creates `mat_{materialization_id}` with flattened columns
 *   2. `refreshPhysicalTable()` — TRUNCATE + INSERT INTO ... SELECT
 *   3. `dropPhysicalTable()` — drops the physical table
 *
 * The runtime creates no database object (HeoPress P14, ADR-0024): the table is created, emptied and dropped by the
 * owner's entries `heopress_materialize_create|truncate|drop` (migration 0124), which take the materialization id,
 * check that it belongs to the caller's site scope and derive the table name the way `sanitizeTableName` does. The
 * table has row-level security; every statement here runs in the materialization's site scope.
 *
 * Auto refresh is the item service's (`triggerMaterializeRefresh`: a refresh job after each write). The database
 * trigger on `lumibase_items` that an earlier version installed only sent a NOTIFY nothing listened to (and could not
 * be created: its WHEN clause read OLD on INSERT), and the application role cannot attach triggers to the owner's
 * tables (HeoPress P13, security review S-5): it is gone.
 */

import type { Database } from '@heopress/database';
import { collections, databaseScope, items, scopedDatabase } from '@heopress/database';
import { and, eq, sql } from 'drizzle-orm';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MaterializeConfig {
  id: string;
  siteId: string;
  collection: string;
  target: string;
  refreshStrategy: string;
  projection: { fields: string[]; orderBy?: string };
  filter: Record<string, unknown>;
}

export interface RefreshResult {
  rowCount: number;
  lastRefreshedAt: Date;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Sanitize a materialization id to prevent SQL injection in DDL.
 *
 * Physical table names must be unique per materialization, not just per target:
 * target names are only unique within a site and may be reused by other
 * tenants. Using the metadata id keeps DDL, refreshes, drops, and reads scoped
 * to a caller-owned materialization.
 */
export function sanitizeTableName(materializationId: string): string {
  const clean = materializationId
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 59);
  if (!clean) {
    throw new Error(`Invalid materialized collection id: ${materializationId}`);
  }
  return `mat_${clean}`;
}

/**
 * `db` in the site's scope: a handle already in it as is, one in another scope refused; a pool handle is scoped; a
 * transaction (or a stand-in) is the caller's, in the scope the caller set.
 */
function inSite(db: Database, siteId: string): Database {
  const scope = databaseScope(db);
  if (scope && 'site' in scope && scope.site === siteId) return db;
  if (scope) throw new Error(`materialize: the database handle is not in site ${siteId}'s scope`);
  const client = (db as { $client?: { unsafe?: unknown; begin?: unknown } }).$client;
  return typeof client?.unsafe === 'function' && typeof client?.begin === 'function' ? scopedDatabase(db, { site: siteId }) : db;
}

/**
 * Creates a physical table for a materialized collection.
 *
 * The table uses a flat schema:
 *   - id TEXT PRIMARY KEY
 *   - site_id TEXT NOT NULL
 *   - status TEXT
 *   - data JSONB
 *   - created_at TIMESTAMPTZ
 *   - updated_at TIMESTAMPTZ
 *
 * For specific field projections (not `*`), individual columns are
 * extracted from JSONB into typed columns in future iterations.
 */
export async function createPhysicalTable(
  db: Database,
  config: MaterializeConfig,
): Promise<void> {
  sanitizeTableName(config.id); // an id with nothing usable is refused before the database is asked
  // The entry creates the table (and its (site_id, status) index) and returns its name.
  await inSite(db, config.siteId).execute(sql`SELECT public.heopress_materialize_create(${config.id}) AS table_name`);
}

/**
 * Refreshes the physical table by truncating and re-inserting from the
 * source `items` table, applying the projection and filter.
 */
export async function refreshPhysicalTable(
  db: Database,
  config: MaterializeConfig,
): Promise<RefreshResult> {
  const tableName = sanitizeTableName(config.id);
  const table = sql.identifier(tableName);
  const startTime = Date.now();

  // One transaction in the site's scope: readers see the old rows or the new ones, never an empty table.
  return inSite(db, config.siteId).transaction(async (tx) => refreshIn(tx as unknown as Database, config, table, startTime));
}

async function refreshIn(
  db: Database,
  config: MaterializeConfig,
  table: ReturnType<typeof sql.identifier>,
  startTime: number,
): Promise<RefreshResult> {
  // Resolve source collection id
  const [coll] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(
      and(
        eq(collections.siteId, config.siteId),
        eq(collections.name, config.collection),
      ),
    );

  if (!coll) {
    throw new Error(`Source collection '${config.collection}' not found`);
  }

  // Empty the materialized table (the entry: the role has no TRUNCATE)
  await db.execute(sql`SELECT public.heopress_materialize_truncate(${config.id})`);

  // Build the INSERT ... SELECT query. Every user/config-derived VALUE below is
  // passed as a bind parameter (not string-interpolated); only the validated
  // physical table name is an identifier.
  const statusFilter =
    config.filter && config.filter['status']
      ? sql`AND i.status = ${String(config.filter['status'])}`
      : sql``;

  // Build field projection (if not wildcard, extract specific JSONB keys).
  const projectionFields = config.projection?.fields ?? ['*'];
  let dataProjection = sql`i.data`;
  if (!projectionFields.includes('*') && projectionFields.length > 0) {
    const fieldExprs = projectionFields.map(
      (f) => sql`${f}::text, i.data -> ${f}::text`,
    );
    dataProjection = sql`jsonb_build_object(${sql.join(fieldExprs, sql`, `)})`;
  }

  const orderClause = config.projection?.orderBy
    ? sql`ORDER BY i.data ->> ${config.projection.orderBy}::text`
    : sql`ORDER BY i.sort, i.created_at`;

  await db.execute(sql`
    INSERT INTO ${table} (id, site_id, collection_id, status, data, sort, user_created, user_updated, created_at, updated_at)
    SELECT i.id, i.site_id, i.collection_id, i.status, ${dataProjection}, i.sort, i.user_created, i.user_updated, i.created_at, i.updated_at
    FROM lumibase_items i
    WHERE i.site_id = ${config.siteId}
      AND i.collection_id = ${coll.id}
      AND i.deleted_at IS NULL
      ${statusFilter}
    ${orderClause}
  `);

  // Count rows in the materialized table
  const countResult = await db.execute(
    sql`SELECT COUNT(*) as cnt FROM ${table}`,
  );
  const rowCount = Number((countResult as unknown as Array<{ cnt: string }>)[0]?.cnt ?? 0);

  const durationMs = Date.now() - startTime;

  return {
    rowCount,
    lastRefreshedAt: new Date(),
    durationMs,
  };
}

/**
 * Drops the physical materialized table.
 */
export async function dropPhysicalTable(
  db: Database,
  config: MaterializeConfig,
): Promise<void> {
  sanitizeTableName(config.id); // as above
  await inSite(db, config.siteId).execute(sql`SELECT public.heopress_materialize_drop(${config.id})`);
}

/**
 * Query a materialized physical table directly.
 * Returns rows from the denormalized table (much faster than JSONB queries).
 */
export async function queryPhysicalTable(
  db: Database,
  materializationId: string,
  siteId: string,
  opts: { limit?: number; offset?: number; status?: string } = {},
): Promise<{ data: unknown[]; total: number }> {
  const tableName = sanitizeTableName(materializationId);
  const table = sql.identifier(tableName);
  const limit = opts.limit ?? 100;
  const offset = opts.offset ?? 0;
  const statusFilter = opts.status ? sql`AND status = ${opts.status}` : sql``;
  const scoped = inSite(db, siteId);

  const rows = await scoped.execute(sql`
    SELECT * FROM ${table}
    WHERE site_id = ${siteId} ${statusFilter}
    ORDER BY sort, created_at
    LIMIT ${limit} OFFSET ${offset}
  `);

  const countResult = await scoped.execute(sql`
    SELECT COUNT(*) as cnt FROM ${table}
    WHERE site_id = ${siteId} ${statusFilter}
  `);
  const total = Number((countResult as unknown as Array<{ cnt: string }>)[0]?.cnt ?? 0);

  return { data: rows as unknown as unknown[], total };
}
