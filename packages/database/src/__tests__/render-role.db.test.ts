import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureAppRole } from '../app-role';
import { ensureRenderRole, RENDER_READABLE, RENDER_WRITABLE } from '../render-role';

/**
 * The rendering service's role (HeoPress P06 task 1.2; design R20): it reads the public projection
 * and nothing else, holds no attribute or membership, and a rerun takes back what was granted
 * beyond the list. Every case runs in an owner transaction with throwaway roles and is rolled back.
 *
 * Needs DATABASE_OWNER_URL (see rls.db.test.ts).
 */

const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const RENDER = 'heopress_render_probe';
const APP = 'heopress_app_probe';
const POLICIES = readFileSync(path.resolve(__dirname, '../../migrations/rls-policies.sql'), 'utf8').replace(/^ALTER DATABASE .*$/m, '');

/** Base and administration tables the renderer must not read. */
const NOT_READABLE = ['lumibase_items', 'lumibase_site_seo_settings', 'lumibase_site_identity', 'lumibase_deleted_site_ids', 'lumibase_site_id_reuse_exemption', 'lumibase_preview_links', 'lumibase_theme_versions', 'lumibase_theme_assets', 'lumibase_redirects', 'lumibase_content_routes', 'lumibase_users', 'lumibase_sites', 'lumibase_projection_dirty', 'lumibase_public_path_memory', 'lumibase_cdc_change_events'];

class Rollback extends Error {}

describe.skipIf(!OWNER_URL)('rendering role provisioning', () => {
  let owner: postgres.Sql;

  beforeAll(() => {
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {}, prepare: false });
  });
  afterAll(async () => {
    await owner?.end({ timeout: 1 });
  });

  async function inRollback(body: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
    try {
      await owner.begin(async (tx) => {
        await body(tx);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  }

  const can = async (tx: postgres.TransactionSql, table: string, priv: string) =>
    (await tx<{ ok: boolean }[]>`SELECT has_table_privilege(${RENDER}, ${table}, ${priv}) AS ok`)[0]!.ok;

  it('reads the projection only: SELECT on the list, nothing else, no attribute, no membership', async () => {
    await inRollback(async (tx) => {
      await tx.unsafe(POLICIES); // creates app_site_id()
      await ensureRenderRole(tx, { role: RENDER, password: 'probe' });
      for (const t of RENDER_READABLE) {
        expect(await can(tx, t, 'SELECT'), t).toBe(true);
        for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER', 'REFERENCES']) expect(await can(tx, t, p), `${t} ${p}`).toBe(false);
      }
      for (const t of NOT_READABLE) expect(await can(tx, t, 'SELECT'), t).toBe(false);
      // Its page cache: read and write, nothing more (no TRUNCATE, TRIGGER, REFERENCES).
      for (const t of RENDER_WRITABLE) {
        for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) expect(await can(tx, t, p), `${t} ${p}`).toBe(true);
        for (const p of ['TRUNCATE', 'TRIGGER', 'REFERENCES']) expect(await can(tx, t, p), `${t} ${p}`).toBe(false);
      }
      // Every table of the schema outside the list: no privilege at all.
      const others = await tx<{ t: string }[]>`
        SELECT c.relname AS t FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'm', 'p')
          AND c.relname <> ALL(${[...RENDER_READABLE, ...RENDER_WRITABLE]})
          AND (has_table_privilege(${RENDER}, c.oid, 'SELECT') OR has_table_privilege(${RENDER}, c.oid, 'INSERT')
               OR has_table_privilege(${RENDER}, c.oid, 'UPDATE') OR has_table_privilege(${RENDER}, c.oid, 'DELETE')
               OR has_any_column_privilege(${RENDER}, c.oid, 'SELECT') OR has_any_column_privilege(${RENDER}, c.oid, 'INSERT')
               OR has_any_column_privilege(${RENDER}, c.oid, 'UPDATE'))`;
      expect(others.map((r) => r.t)).toEqual([]);
      const fns = await tx<{ f: string }[]>`
        SELECT p.oid::regprocedure::text AS f FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND has_function_privilege(${RENDER}, p.oid, 'EXECUTE')`;
      // `app_site_id()`, and the one write: an AI traffic hit through its checked entry (P07 task 6.4) — not the tables.
      expect(fns.map((r) => r.f).sort()).toEqual([
        'app_site_id()',
        'lumibase_record_crawl_hit(text,text,text,text,text,text,text,text,integer)',
        'lumibase_robots_noindex(text)',
        'lumibase_robots_own_index(text)',
        'lumibase_robots_tokens(text)',
      ]);
      for (const t of ['lumibase_crawl_hits', 'lumibase_crawl_daily']) expect(await can(tx, t, 'INSERT'), t).toBe(false);
      const [r] = await tx`SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication, rolinherit, rolcanlogin FROM pg_roles WHERE rolname = ${RENDER}`;
      expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolinherit: false, rolcanlogin: true });
      expect(await tx`SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = ${RENDER}`).toHaveLength(0);
      const [schema] = await tx`SELECT has_schema_privilege(${RENDER}, 'public', 'CREATE') AS create, has_schema_privilege(${RENDER}, 'public', 'USAGE') AS usage`;
      expect(schema).toEqual({ create: false, usage: true });
      // No default privilege names it: a table created later is not readable.
      expect(await tx`SELECT 1 FROM pg_default_acl d WHERE d.defaclacl::text LIKE ${`%${RENDER}=%`}`).toHaveLength(0);
      await tx`CREATE TABLE heopress_render_probe_later (id int)`;
      expect(await can(tx, 'heopress_render_probe_later', 'SELECT')).toBe(false);
    });
  });

  it('a rerun takes back what was granted beyond the list; the application role keeps its functions', async () => {
    await inRollback(async (tx) => {
      await ensureAppRole(tx, { role: APP, password: 'probe' });
      await ensureRenderRole(tx, { role: RENDER, password: 'probe' });
      // What an operator or an earlier version granted.
      await tx.unsafe(`GRANT SELECT ON lumibase_items TO ${RENDER}`);
      await tx.unsafe(`GRANT INSERT ON lumibase_public_items TO ${RENDER}`);
      await tx.unsafe(`GRANT EXECUTE ON FUNCTION heopress_projection_take() TO ${RENDER}`);
      await tx.unsafe(`GRANT CREATE ON SCHEMA public TO ${RENDER}`);
      // Column grants and default privileges outlive a table-level REVOKE ALL.
      await tx.unsafe(`GRANT SELECT (data, status) ON lumibase_items TO ${RENDER}`);
      await tx.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO ${RENDER}`);
      await ensureRenderRole(tx, { role: RENDER, password: 'probe' });
      expect((await tx`SELECT has_any_column_privilege(${RENDER}, 'lumibase_items', 'SELECT') AS ok`)[0]!.ok).toBe(false);
      expect(await tx`SELECT 1 FROM pg_default_acl d WHERE d.defaclacl::text LIKE ${`%${RENDER}=%`}`).toHaveLength(0);
      await tx`CREATE TABLE heopress_render_probe_later (id int)`;
      expect(await can(tx, 'heopress_render_probe_later', 'SELECT')).toBe(false);
      expect(await can(tx, 'lumibase_items', 'SELECT')).toBe(false);
      expect(await can(tx, 'lumibase_public_items', 'INSERT')).toBe(false);
      expect((await tx`SELECT has_function_privilege(${RENDER}, 'heopress_projection_take()', 'EXECUTE') AS ok`)[0]!.ok).toBe(false);
      expect((await tx`SELECT has_schema_privilege(${RENDER}, 'public', 'CREATE') AS ok`)[0]!.ok).toBe(false);
      // Revoking PUBLIC's EXECUTE leaves the application role's own grant.
      expect((await tx`SELECT has_function_privilege(${APP}, 'heopress_projection_take()', 'EXECUTE') AS ok`)[0]!.ok).toBe(true);
    });
  });

  it('refuses an existing role that is a member of another role, or owns an object', async () => {
    await inRollback(async (tx) => {
      await tx.unsafe(`CREATE ROLE ${RENDER} LOGIN`);
      await tx.unsafe(`GRANT pg_read_all_data TO ${RENDER}`);
      await expect(ensureRenderRole(tx, { role: RENDER, password: 'probe' })).rejects.toThrow(/member of another role/);
    });
    await inRollback(async (tx) => {
      await tx.unsafe(`CREATE ROLE ${RENDER} LOGIN`);
      await tx`CREATE TABLE heopress_render_probe_own (id int)`;
      await tx.unsafe(`ALTER TABLE heopress_render_probe_own OWNER TO ${RENDER}`);
      await expect(ensureRenderRole(tx, { role: RENDER, password: 'probe' })).rejects.toThrow(/owns database objects/);
    });
  });

  it('under the policies, it reads one site’s projection and redirects — hosts across sites, base tables never', async () => {
    await inRollback(async (tx) => {
      await tx`INSERT INTO lumibase_sites (id, name) VALUES ('rr_a', 'A'), ('rr_b', 'B')`;
      for (const s of ['rr_a', 'rr_b']) {
        await tx`INSERT INTO lumibase_public_hosts (hostname, site_id, is_primary, primary_hostname) VALUES (${`${s}.example.com`}, ${s}, true, ${`${s}.example.com`})`;
        await tx`INSERT INTO lumibase_public_items (item_id, site_id, collection, locale, path, data, card, sanitizer, updated_at)
                 VALUES (${`${s}_1`}, ${s}, 'articles', 'en', '/x/', '{}'::jsonb, '{}'::jsonb, 1, now())`;
        await tx`INSERT INTO lumibase_redirects (id, site_id, scope, locale, from_path, match, to_path, status, source)
                 VALUES (${`${s}_r`}, ${s}, 'content', 'en', '/old/', 'exact', '/new/', 301, 'import')`;
      }
      await tx.unsafe(POLICIES);
      await ensureRenderRole(tx, { role: RENDER, password: 'probe' });
      await tx.unsafe(`SET LOCAL ROLE ${RENDER}`);
      expect((await tx`SELECT site_id FROM lumibase_public_hosts WHERE site_id LIKE 'rr_%' ORDER BY 1`).map((r) => r.site_id)).toEqual(['rr_a', 'rr_b']);
      await tx`SELECT set_config('app.site_id', '', true)`;
      expect(await tx`SELECT 1 FROM lumibase_public_items WHERE site_id LIKE 'rr_%'`).toHaveLength(0);
      await tx`SELECT set_config('app.site_id', 'rr_a', true)`;
      expect((await tx`SELECT item_id FROM lumibase_public_items WHERE site_id LIKE 'rr_%'`).map((r) => r.item_id)).toEqual(['rr_a_1']);
      expect((await tx`SELECT site_id FROM lumibase_render_redirects WHERE site_id LIKE 'rr_%'`).map((r) => r.site_id)).toEqual(['rr_a']);
      await expect(tx.savepoint((sp) => sp`SELECT 1 FROM lumibase_items LIMIT 1`)).rejects.toThrow(/permission denied/);
      await expect(tx.savepoint((sp) => sp`DELETE FROM lumibase_public_items`)).rejects.toThrow(/permission denied/);
      await expect(tx.savepoint((sp) => sp`SELECT * FROM heopress_projection_take()`)).rejects.toThrow(/permission denied/);
    });
  });
});
