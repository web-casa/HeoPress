#!/usr/bin/env tsx
/**
 * The row-level security emergency switch (HeoPress P14 task 1.7; ADR-0023). Run as the owner of the tables, from the
 * release checkout:
 *
 *   DATABASE_URL=<owner url> pnpm --filter @heopress/database rls -- --disable
 *   DATABASE_URL=<owner url> pnpm --filter @heopress/database rls -- --enable
 *
 * `--disable` turns row-level security off on every registered table but keeps the policies (the migration's text is
 * repeatable, so `--enable` restores them). It exists for one situation: a release whose requests fail because the
 * scope is missing, where an operator must keep the site serving while the fix is prepared. Writes are no longer
 * isolated per site while it is off — the command prints that, and the application should be kept single-site or
 * behind maintenance until `--enable`. Exempt tables are untouched.
 *
 * The migration (0124) is the normal path; this command only flips the switch. It refuses a connection that does not
 * own the tables (a runtime role cannot disable the policies).
 */
import postgres from 'postgres';
import { RLS_REGISTRY } from '../src/rls/registry';
import { rlsPolicyStatements } from '../src/rls/policies';

const url = process.env.DATABASE_URL;
const enable = process.argv.includes('--enable');
const disable = process.argv.includes('--disable');

async function main(): Promise<number> {
  if (!url) {
    console.error('[rls] DATABASE_URL (the owner connection) is required.');
    return 1;
  }
  if (enable === disable) {
    console.error('[rls] pass exactly one of --disable or --enable.');
    return 1;
  }
  const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 15, fetch_types: false });
  try {
    const [owner] = (await sql.unsafe(
      `SELECT pg_has_role(current_user, c.relowner, 'USAGE') AS owns
         FROM pg_class c WHERE c.oid = to_regclass('public.lumibase_items')`,
    )) as Array<{ owns: boolean }>;
    if (!owner?.owns) {
      console.error('[rls] this connection does not own the tables: run it as the owner (DATABASE_OWNER_URL).');
      return 1;
    }
    if (disable) {
      let changed = 0;
      for (const entry of RLS_REGISTRY) {
        if (entry.policy === 'exempt') continue;
        await sql.unsafe(`ALTER TABLE public.${entry.table} DISABLE ROW LEVEL SECURITY`);
        changed++;
      }
      console.warn(`[rls] row-level security is OFF on ${changed} tables: site isolation is no longer enforced by the database.`);
      console.warn('[rls] keep the application on one site (or in maintenance) until --enable restores it.');
      return 0;
    }
    // Enable: the same repeatable statements the policy migration uses.
    for (const statement of rlsPolicyStatements()) await sql.unsafe(statement);
    console.log(`[rls] row-level security restored on ${RLS_REGISTRY.filter((e) => e.policy !== 'exempt').length} tables (policies match the registry).`);
    return 0;
  } catch (err) {
    console.error('[rls] failed:', err instanceof Error ? err.message : err);
    return 1;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

process.exitCode = await main();
