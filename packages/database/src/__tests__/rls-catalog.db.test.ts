import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RLS_REGISTRY } from '../rls/registry';
import { policiesFor } from '../rls/policies';

/**
 * The migrated database's row-level security matches the registry (HeoPress P14 task 1.7; ADR-0023, design D1.1).
 *
 * The policy migration (0124) is generated from `RLS_REGISTRY`; this suite is the other direction: for every registered
 * table the catalog has exactly the policies the registry declares, row-level security is enabled (never forced: the
 * owner migrates and backs up), and an exception has none. It also checks the two tables the runtime creates at run
 * time (a vector space and a materialized collection's table): the owner's entries create them with the site policy.
 *
 * Needs DATABASE_OWNER_URL (see rls.db.test.ts). A database without the policy migration fails here instead of
 * silently proving nothing.
 */
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;

describe.skipIf(!OWNER_URL)('row-level security catalog (P14 task 1.7)', () => {
  let owner: postgres.Sql;
  beforeAll(() => {
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {}, prepare: false });
  });
  afterAll(async () => {
    await owner?.end({ timeout: 1 });
  });

  it('every registered table has exactly the registry’s policies, enabled and not forced', async () => {
    const flags = await owner<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`;
    const byName = new Map(flags.map((f) => [f.relname, f]));
    const missing: string[] = [];
    const wrong: string[] = [];
    for (const entry of RLS_REGISTRY) {
      const row = byName.get(entry.table);
      if (!row) {
        missing.push(entry.table);
        continue;
      }
      const enabled = entry.policy !== 'exempt';
      if (row.relrowsecurity !== enabled) wrong.push(`${entry.table}: relrowsecurity=${row.relrowsecurity}, expected ${enabled}`);
      if (row.relforcerowsecurity) wrong.push(`${entry.table}: FORCE is set (the owner would be bound)`);
      const actual = await owner<{ policyname: string; cmd: string }[]>`
        SELECT policyname, cmd FROM pg_policies WHERE schemaname = 'public' AND tablename = ${entry.table} ORDER BY policyname`;
      const expected = policiesFor(entry).map((p) => ({ policyname: p.name, cmd: p.command })).sort((a, b) => (a.policyname < b.policyname ? -1 : 1));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) wrong.push(`${entry.table}: policies ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
    }
    expect(missing).toEqual([]);
    expect(wrong).toEqual([]);
  });

  it('a table with a site_id that is not registered is not silently unprotected', async () => {
    const registered = new Set(RLS_REGISTRY.map((e) => e.table));
    const tables = await owner<{ table_name: string }[]>`
      SELECT c.relname AS table_name FROM information_schema.columns i
      JOIN pg_class c ON c.relname = i.table_name
      JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = i.table_schema
      WHERE i.table_schema = 'public' AND i.column_name = 'site_id' AND i.table_name LIKE 'lumibase_%' AND c.relkind = 'r'`;
    const unknown = tables.map((t) => t.table_name).filter((t) => !registered.has(t));
    // The registry test scans the schema sources; this catches a table that exists in the migrated database only.
    expect(unknown).toEqual([]);
  });

  it('a materialized collection’s table is created with the site policy (the runtime creates no object)', async () => {
    class Rollback extends Error {}
    let table = '';
    try {
      await owner.begin(async (tx) => {
        await tx`INSERT INTO lumibase_sites (id, name) VALUES ('site_rls_catalog', 'RLS catalog')`;
        await tx`SELECT set_config('app.site_id', 'site_rls_catalog', true)`;
        await tx`INSERT INTO lumibase_materialized_collections (id, site_id, collection, target)
                 VALUES ('p14catalog', 'site_rls_catalog', 'articles', 'p14catalog')`;
        const [row] = await tx<{ tbl: string }[]>`SELECT public.heopress_materialize_create('p14catalog') AS tbl`;
        table = row!.tbl;
        const [flags] = await tx<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
          SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.' || ${table})`;
        expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: false });
        const policies = await tx<{ policyname: string }[]>`SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = ${table}`;
        expect(policies.map((p) => p.policyname)).toEqual(['site_isolation']);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    expect(table).toMatch(/^mat_/);
  });

  it('a vector space is created with the site policy when pgvector is available', async (ctx) => {
    const [hasVector] = await owner<{ ok: boolean }[]>`SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS ok`;
    if (!hasVector?.ok) return ctx.skip();
    let table = '';
    try {
      const [row] = await owner<{ tbl: string }[]>`SELECT public.heopress_ensure_vector_space('p14-catalog-model', 3) AS tbl`;
      table = row!.tbl;
      const [flags] = await owner<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = to_regclass('public.' || ${table})`;
      expect(flags).toEqual({ relrowsecurity: true, relforcerowsecurity: false });
      const policies = await owner<{ policyname: string }[]>`SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = ${table}`;
      expect(policies.map((p) => p.policyname)).toEqual(['site_isolation']);
    } finally {
      if (table) await owner.unsafe(`DROP TABLE IF EXISTS public.${table}`).catch(() => undefined);
    }
  });
});
