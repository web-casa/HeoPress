import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Every SECURITY DEFINER function of the schema, and every function of ours (`heopress_*`, trigger
 * functions included: a trigger fired inside a definer function runs with the owner's privileges),
 * resolves names through pg_catalog and pg_temp only, naming our own objects public.<name> (HeoPress P06
 * review): an unlisted temporary schema is searched first. Until P14 the application role could also create
 * objects in public, so an exact-type overload there (public.unnest(text[])) would beat the catalog's
 * function and run with the owner's privileges; since P14 2.2 it has no CREATE on public at all, and the
 * pinning stays as defence in depth. A new function without the setting fails here.
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

  it('search only pg_catalog and pg_temp (public is no longer writable by the application role)', async () => {
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

  it('the application role cannot create a public overload to hijack a definer entry (P14 2.2)', async () => {
    const role = process.env.HEOPRESS_TEST_APP_ROLE || 'heopress_app';
    const marker = `heopress_hijack_${Date.now()}`;
    class Rollback extends Error {}
    let failure: Error | undefined;
    try {
      await owner.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        // Exact-type overloads of functions our definer functions call: refused outright now that the role has no
        // CREATE on public. The pinned search_path (the test above) stays as the second line of defence.
        try {
          await tx.unsafe(`CREATE FUNCTION public.unnest(text[]) RETURNS SETOF text LANGUAGE sql AS $$ SELECT '${marker}'::text $$`);
        } catch (err) {
          failure = err as Error;
        }
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    expect(failure?.message).toContain('permission denied for schema public');
  });
});
