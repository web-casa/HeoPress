/**
 * Migration status for readiness checks (P01 `platform/runtime-baseline`).
 *
 * The drizzle migrator records each applied migration in
 * `drizzle.__drizzle_migrations` with `created_at` set to the journal entry's
 * `when` timestamp, so "is this database fully migrated for this build" is a
 * comparison between the newest applied timestamp and the newest migration
 * bundled with the code.
 */
import journal from '../drizzle/meta/_journal.json';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

const entries = (journal as { entries: JournalEntry[] }).entries;
const latest = entries.at(-1);
if (!latest) {
  throw new Error('drizzle/meta/_journal.json has no migrations');
}

/** The newest migration bundled with this build. */
export const LATEST_MIGRATION: Readonly<{ tag: string; when: number }> = Object.freeze({
  tag: latest.tag,
  when: latest.when,
});

/** Minimal tagged-template query shape; a postgres.js `Sql` is called this way (cast at the call site). */
export type MigrationStatusQuery = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => PromiseLike<ReadonlyArray<Record<string, unknown>>>;

export interface MigrationReadiness {
  /** True when every migration bundled with this build has been applied. */
  upToDate: boolean;
  /** `created_at` of the newest applied migration, or null when none are recorded. */
  latestApplied: number | null;
  /** `when` of the newest bundled migration. */
  expected: number;
}

const UNDEFINED_TABLE = '42P01';
const INVALID_SCHEMA_NAME = '3F000';

export async function getMigrationReadiness(sql: MigrationStatusQuery): Promise<MigrationReadiness> {
  let rows: ReadonlyArray<Record<string, unknown>>;
  try {
    rows = await sql`SELECT max(created_at) AS latest FROM drizzle.__drizzle_migrations`;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === UNDEFINED_TABLE || code === INVALID_SCHEMA_NAME) {
      return { upToDate: false, latestApplied: null, expected: LATEST_MIGRATION.when };
    }
    throw err;
  }
  const raw = rows[0]?.latest;
  const latestApplied = raw === null || raw === undefined ? null : Number(raw);
  return {
    upToDate: latestApplied !== null && Number.isFinite(latestApplied) && latestApplied >= LATEST_MIGRATION.when,
    latestApplied: latestApplied !== null && Number.isFinite(latestApplied) ? latestApplied : null,
    expected: LATEST_MIGRATION.when,
  };
}
