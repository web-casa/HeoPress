/**
 * Database extensions and the capabilities they enable (P03 tasks 1.1–1.2,
 * spec platform/infrastructure-adapters "最小依赖部署").
 *
 * - `pg_trgm` (PostgreSQL contrib) is required: full-text search falls back to
 *   trigram matching and fuzzy search always uses it.
 * - `vector` (pgvector) is required only when vector search is enabled
 *   (`HEOPRESS_VECTOR_SEARCH=true`).
 * - `zhparser` is optional: without it Chinese text is searched with pg_trgm
 *   and readiness reports a notice instead of failing.
 *
 * The migrate script creates the extensions this deployment uses before
 * running migrations (`ensureDatabaseExtensions`), so the application role
 * never needs CREATE privileges; readiness only reads `pg_extension`.
 */
import type { MigrationStatusQuery } from './migration-status';

/** Text search configuration created on top of zhparser. */
export const ZH_TEXT_SEARCH_CONFIG = 'heopress_zh';

export interface DatabaseCapabilities {
  trgm: boolean;
  vector: boolean;
  zhparser: boolean;
  /** `ZH_TEXT_SEARCH_CONFIG` exists (zhparser installed and configured). */
  zhConfig: boolean;
}

export interface CapabilityRequirements {
  /** Vector search is enabled for this deployment. */
  vectorSearch: boolean;
}

export interface CapabilityReport {
  ready: boolean;
  /** Missing capabilities that block readiness, e.g. `vector extension (HEOPRESS_VECTOR_SEARCH=true)`. */
  missing: string[];
  /** Degradations that do not block readiness. */
  notices: string[];
  /** How Chinese full-text search runs. */
  chineseSearch: 'zhparser' | 'trgm';
}

/** Read which capability extensions are installed in the current database. */
export async function getDatabaseCapabilities(sql: MigrationStatusQuery): Promise<DatabaseCapabilities> {
  const rows = await sql`
    SELECT
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS trgm,
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS vector,
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'zhparser') AS zhparser,
      EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = ${ZH_TEXT_SEARCH_CONFIG}) AS zh_config`;
  const row = rows[0] ?? {};
  return {
    trgm: row.trgm === true,
    vector: row.vector === true,
    zhparser: row.zhparser === true,
    zhConfig: row.zh_config === true,
  };
}

/** Decide readiness from installed capabilities and what this deployment enables. */
export function evaluateCapabilities(caps: DatabaseCapabilities, req: CapabilityRequirements): CapabilityReport {
  const missing: string[] = [];
  const notices: string[] = [];
  if (!caps.trgm) missing.push('pg_trgm extension (required for search)');
  if (req.vectorSearch && !caps.vector) missing.push('vector extension (HEOPRESS_VECTOR_SEARCH=true)');
  const zh = caps.zhparser && caps.zhConfig;
  if (!zh) notices.push('zhparser not installed: Chinese full-text search uses pg_trgm matching');
  return { ready: missing.length === 0, missing, notices, chineseSearch: zh ? 'zhparser' : 'trgm' };
}

/** `HEOPRESS_VECTOR_SEARCH`: off unless explicitly `true` / `1` / `on`. */
export function capabilityRequirementsFromEnv(env: Record<string, unknown> | undefined): CapabilityRequirements {
  const raw = String(env?.HEOPRESS_VECTOR_SEARCH ?? '').trim().toLowerCase();
  return { vectorSearch: raw === 'true' || raw === '1' || raw === 'on' };
}

/** Minimal shape of a postgres.js client used to create extensions. */
export interface ExtensionAdminSql {
  unsafe(query: string): PromiseLike<unknown>;
  (strings: TemplateStringsArray, ...values: unknown[]): PromiseLike<ReadonlyArray<Record<string, unknown>>>;
}

export interface EnsureExtensionsResult {
  created: string[];
  /** Optional extensions skipped: not offered by the server, not enabled, or not installable. */
  skipped: string[];
}

/**
 * Create the capability extensions this deployment uses. Run by the migrate
 * script (table-owner role) before migrations.
 *   - `pg_trgm` is required; failing to create it throws.
 *   - `vector` is created only when vector search is enabled
 *     (`HEOPRESS_VECTOR_SEARCH=true`); then failing to create it throws, naming
 *     the cause. Enabling vector search later means running the migrate script again.
 *   - `zhparser` is optional: when the server does not offer it, or the role
 *     may not install it, Chinese search falls back to pg_trgm and migrating
 *     continues.
 * Availability is not permission: an untrusted extension needs a superuser
 * (https://www.postgresql.org/docs/18/sql-createextension.html).
 */
export async function ensureDatabaseExtensions(
  sql: ExtensionAdminSql,
  requirements: CapabilityRequirements = { vectorSearch: false },
  log: (message: string) => void = () => {},
): Promise<EnsureExtensionsResult> {
  const rows = await sql`
    SELECT name FROM pg_available_extensions WHERE name IN ('pg_trgm', 'vector', 'zhparser')`;
  const available = new Set(rows.map((r) => String(r.name)));
  const created: string[] = [];
  const skipped: string[] = [];

  const create = async (ext: string) => {
    await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS ${ext}`);
    created.push(ext);
  };
  const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

  if (!available.has('pg_trgm')) throw new Error('pg_trgm is not available on this PostgreSQL server; HeoPress requires it');
  try {
    await create('pg_trgm');
  } catch (err) {
    throw new Error(`could not create the required extension pg_trgm: ${reason(err)}`);
  }

  if (!requirements.vectorSearch) {
    skipped.push('vector');
  } else if (!available.has('vector')) {
    throw new Error('HEOPRESS_VECTOR_SEARCH=true but this PostgreSQL server does not offer the vector extension (pgvector)');
  } else {
    try {
      await create('vector');
    } catch (err) {
      throw new Error(`HEOPRESS_VECTOR_SEARCH=true but the vector extension could not be created: ${reason(err)}`);
    }
  }

  if (!available.has('zhparser')) {
    skipped.push('zhparser');
  } else {
    try {
      await sql.unsafe('CREATE EXTENSION IF NOT EXISTS zhparser');
      // Token types: nouns, verbs, adjectives, idioms, exclamations, temporary
      // idioms (zhparser README). Created once; later runs leave it untouched.
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_ts_config WHERE cfgname = '${ZH_TEXT_SEARCH_CONFIG}') THEN
            CREATE TEXT SEARCH CONFIGURATION ${ZH_TEXT_SEARCH_CONFIG} (PARSER = zhparser);
            ALTER TEXT SEARCH CONFIGURATION ${ZH_TEXT_SEARCH_CONFIG} ADD MAPPING FOR n, v, a, i, e, l WITH simple;
          END IF;
        END $$;`);
      created.push('zhparser');
    } catch (err) {
      skipped.push('zhparser');
      log(`zhparser could not be set up (${reason(err)}); Chinese search will use pg_trgm`);
    }
  }
  return { created, skipped };
}

/**
 * Switch the disposable runtime tables to UNLOGGED (Drizzle cannot declare it).
 * Idempotent; run by the migrate script after migrations. Returns the tables
 * that were changed.
 */
export async function applyUnloggedTables(sql: ExtensionAdminSql, tables: readonly string[]): Promise<string[]> {
  const changed: string[] = [];
  for (const table of tables) {
    const rows = await sql`
      SELECT relpersistence FROM pg_class WHERE oid = to_regclass(${table})`;
    const persistence = rows[0]?.relpersistence;
    if (persistence === undefined) continue;
    if (persistence !== 'u') {
      await sql.unsafe(`ALTER TABLE "${table.replace(/"/g, '""')}" SET UNLOGGED`);
      changed.push(table);
    }
  }
  return changed;
}
