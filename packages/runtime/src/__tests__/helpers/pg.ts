import postgres from 'postgres';

/**
 * PostgreSQL for the runtime adapter suites (`*.db.test.ts`). Without
 * DATABASE_URL the suites skip; with it set but unreachable they fail. The
 * database must be migrated (`pnpm --filter @heopress/database migrate`); the
 * suites only truncate the runtime infrastructure tables.
 */
export const PG_URL = process.env.DATABASE_URL?.trim() || undefined;

export async function connectRuntimeDb(max = 4): Promise<postgres.Sql> {
  const sql = postgres(PG_URL!, { max, onnotice: () => {}, prepare: false });
  likeDrizzle(sql);
  await sql`SELECT 1`;
  return sql;
}

/**
 * In production the runtime's pool is also handed to Drizzle, whose
 * postgres-js driver replaces the timestamp parsers/serializers and the JSON
 * serializers with pass-throughs (drizzle-orm/postgres-js/driver.js). Raw SQL
 * in the adapters must work on such a client, so the suites use one too: a
 * Date or object parameter then fails here as it would in production.
 */
export function likeDrizzle(sql: postgres.Sql): postgres.Sql {
  const options = sql.options as unknown as { parsers: Record<string, unknown>; serializers: Record<string, unknown> };
  const passThrough = (val: unknown) => val;
  for (const type of ['1184', '1082', '1083', '1114', '1182', '1185', '1115', '1231']) {
    options.parsers[type] = passThrough;
    options.serializers[type] = passThrough;
  }
  options.serializers['114'] = passThrough;
  options.serializers['3802'] = passThrough;
  return sql;
}

export async function resetRuntimeTables(sql: postgres.Sql): Promise<void> {
  await sql`TRUNCATE lumibase_cache_entries, lumibase_cache_tags, lumibase_cache_unique_members, lumibase_rate_limit_windows, lumibase_external_actions`;
}

/** Resolve once `check` passes, polling every 20 ms; reject after `timeoutMs`. */
export async function eventually(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
