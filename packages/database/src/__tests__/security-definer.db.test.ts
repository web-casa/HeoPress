import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Every SECURITY DEFINER function of the schema, and every function of ours (`heopress_*`, trigger
 * functions included: a trigger fired inside a definer function runs with the owner's privileges),
 * resolves names through pg_catalog and pg_temp only, naming our own objects public.<name> (HeoPress P06
 * review): an unlisted temporary schema is searched first, and the application role may create objects in
 * public — an exact-type overload there (public.unnest(text[])) would beat the catalog's function and run
 * with the owner's privileges. A new function without the setting fails here.
 *
 * Needs DATABASE_OWNER_URL (see rls.db.test.ts).
 */
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;

describe.skipIf(!OWNER_URL)('SECURITY DEFINER and HeoPress functions', () => {
  let owner: postgres.Sql;
  beforeAll(() => {
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {}, prepare: false });
  });
  afterAll(async () => {
    await owner?.end({ timeout: 1 });
  });

  it("search only pg_catalog and pg_temp (nothing writable: public is the application role's to create in)", async () => {
    const rows = await owner<{ fn: string; config: string[] | null }[]>`
      SELECT p.oid::regprocedure::text AS fn, p.proconfig AS config
      FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.prosecdef OR p.proname LIKE 'heopress\\_%')`;
    expect(rows.length).toBeGreaterThan(0);
    const bad = rows.filter((r) => {
      const path = (r.config ?? []).find((c) => c.startsWith('search_path='));
      return path?.slice('search_path='.length).replace(/"/g, '').split(',').map((s) => s.trim()).join(',') !== 'pg_catalog,pg_temp';
    });
    expect(bad.map((r) => `${r.fn}: ${(r.config ?? []).join(';') || 'no search_path'}`)).toEqual([]);
  });

  it("an overload the application role creates in public is never called with the owner's privileges", async () => {
    const role = process.env.HEOPRESS_TEST_APP_ROLE || 'heopress_app';
    const marker = `heopress_hijack_${Date.now()}`;
    class Rollback extends Error {}
    try {
      await owner.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        // Exact-type overloads of functions our definer functions call, created by the application role.
        await tx.unsafe(`CREATE FUNCTION public.unnest(text[]) RETURNS SETOF text LANGUAGE sql AS $$ SELECT '${marker}'::text $$`);
        await tx.unsafe(`CREATE FUNCTION public.txid_current() RETURNS bigint LANGUAGE sql AS $$ SELECT -1::bigint $$`);
        // Writing through the projection gate (mark runs as its owner): the real txid_current is used.
        await tx.unsafe(`SELECT set_config('app.site_id', '', true)`);
        await tx.unsafe(`RESET ROLE`);
        await tx.unsafe(`INSERT INTO lumibase_sites (id, name) VALUES ('${marker}', 'x')`);
        const dirty = await tx.unsafe<{ txid: string; mine: string }[]>(`SELECT txid::text, txid_current()::text AS mine FROM lumibase_projection_dirty WHERE site_id = '${marker}'`);
        expect(dirty.length).toBeGreaterThan(0);
        expect(dirty[0]!.txid).toBe(dirty[0]!.mine);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  });
});
