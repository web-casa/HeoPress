import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertRlsApplies } from '../app-role';

/**
 * Row-level security under the application role (HeoPress P03 task 7.1;
 * docs/known-issues.md "数据库测试以超级用户运行").
 *
 * The policies in `migrations/rls-policies.sql` are applied inside a
 * transaction on the owner connection, the transaction then switches to the
 * application role (`SET LOCAL ROLE`) — no superuser, no BYPASSRLS — and the
 * site isolation is exercised there. Everything is rolled back, so other
 * suites never see the policies.
 *
 * Needs DATABASE_OWNER_URL (the role that owns the tables, a member of the
 * application role); CI sets it. HEOPRESS_TEST_APP_ROLE names the
 * application role (default heopress_app). When a database is configured
 * (DATABASE_URL) the owner URL is required and DATABASE_URL itself must be a
 * role RLS applies to: the suites are meant to run as the application role,
 * so a missing fixture or a superuser connection fails instead of skipping.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim() || undefined;
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const APP_ROLE = process.env.HEOPRESS_TEST_APP_ROLE || 'heopress_app';
const POLICIES = readFileSync(path.resolve(__dirname, '../../migrations/rls-policies.sql'), 'utf8')
  // A database-level default; inside the test the setting is set per transaction.
  .replace(/^ALTER DATABASE .*$/m, '');

class Rollback extends Error {}

describe.skipIf(!DATABASE_URL)('the database suites run as a role RLS applies to', () => {
  it('DATABASE_OWNER_URL is set', () => {
    expect(
      OWNER_URL,
      'DATABASE_OWNER_URL is required when DATABASE_URL is set: migrate as the owner, run ' +
        '`pnpm --filter @heopress/database app-role --test-database`, and point DATABASE_URL at the application role',
    ).toBeDefined();
  });

  it('DATABASE_URL connects as the application role, not one that bypasses RLS', async () => {
    const app = postgres(DATABASE_URL!, { max: 1, onnotice: () => {}, prepare: false });
    try {
      await assertRlsApplies(app);
    } finally {
      await app.end({ timeout: 1 });
    }
  });
});

describe.skipIf(!OWNER_URL)('row-level security as the application role', () => {
  let owner: postgres.Sql;

  beforeAll(() => {
    owner = postgres(OWNER_URL!, { max: 2, onnotice: () => {}, prepare: false });
  });
  afterAll(async () => {
    await owner?.end({ timeout: 1 });
  });

  /** Seed two sites, apply the policies, become the app role, run `body`, roll back. */
  async function asAppRole(
    body: (tx: postgres.TransactionSql) => Promise<void>,
    /** Extra rows to write as the owner before the policies apply. */
    seed?: (tx: postgres.TransactionSql) => Promise<void>,
  ): Promise<void> {
    try {
      await owner.begin(async (tx) => {
        await tx`INSERT INTO lumibase_sites (id, name) VALUES ('rls_a', 'RLS A'), ('rls_b', 'RLS B')`;
        await tx`INSERT INTO lumibase_extensions (id, site_id, name, version, type, bundle_url)
                 VALUES ('rls_ext_global', NULL, 'global', '1', 'hook', 'x'),
                        ('rls_ext_a', 'rls_a', 'a', '1', 'hook', 'x'),
                        ('rls_ext_b', 'rls_b', 'b', '1', 'hook', 'x')`;
        for (const site of ['rls_a', 'rls_b']) {
          await tx`INSERT INTO lumibase_collections (id, site_id, name) VALUES (${`${site}_posts`}, ${site}, 'posts')`;
          await tx`INSERT INTO lumibase_items (id, site_id, collection_id, status, data)
                   VALUES (${`${site}_1`}, ${site}, ${`${site}_posts`}, 'published', '{"title":"x"}'::jsonb)`;
        }
        if (seed) await seed(tx);
        await tx.unsafe(POLICIES);
        await tx.unsafe(`SET LOCAL ROLE ${APP_ROLE}`);
        await body(tx);
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
  }

  it('the guard refuses a role that bypasses RLS', async () => {
    const [me] = await owner<{ bypass: boolean }[]>`
      SELECT rolsuper OR rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
    if (me!.bypass) {
      await expect(assertRlsApplies(owner)).rejects.toThrow(/must not run as/);
    }
    await asAppRole(async (tx) => {
      await expect(assertRlsApplies(tx)).resolves.toBeUndefined();
    });
  });

  it('a site sees only its own rows, and cannot write into another site', async () => {
    await asAppRole(async (tx) => {
      await assertRlsApplies(tx);
      await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
      // No site condition in the query: the policy supplies it.
      const visible = await tx<{ id: string }[]>`SELECT id FROM lumibase_items WHERE id LIKE 'rls_%' ORDER BY id`;
      expect(visible.map((r) => r.id)).toEqual(['rls_a_1']);
      const updated = await tx`UPDATE lumibase_items SET status = 'draft' WHERE id = 'rls_b_1' RETURNING id`;
      expect(updated).toHaveLength(0);
      await expect(
        tx.savepoint((sp) => sp`INSERT INTO lumibase_items (id, site_id, collection_id, status, data)
                                VALUES ('rls_b_2', 'rls_b', 'rls_b_posts', 'draft', '{}'::jsonb)`),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('without a site, nothing is visible (fail closed)', async () => {
    await asAppRole(async (tx) => {
      await assertRlsApplies(tx);
      await tx`SELECT set_config('app.site_id', '', true)`;
      expect(await tx`SELECT id FROM lumibase_items WHERE id LIKE 'rls_%'`).toHaveLength(0);
      expect(await tx`SELECT id FROM lumibase_collections WHERE id LIKE 'rls_%'`).toHaveLength(0);
    });
  });

  it('model providers, routes, settings and the ledger are isolated per site (P04 7.x)', async () => {
    const LLM_TABLES = ['lumibase_llm_providers', 'lumibase_llm_routes', 'lumibase_llm_site_settings', 'lumibase_llm_calls', 'lumibase_llm_attempts'];
    await asAppRole(
      async (tx) => {
        // The policy file covers every model table, forced.
        const flags = await tx<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
          SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = ANY(${LLM_TABLES})`;
        expect(flags.map((f) => [f.relname, f.relrowsecurity && f.relforcerowsecurity]).sort()).toEqual(LLM_TABLES.map((t) => [t, true]).sort());

        await tx`SELECT set_config('app.site_id', '', true)`;
        for (const t of LLM_TABLES) expect(await tx.unsafe(`SELECT 1 FROM ${t} WHERE site_id LIKE 'rls_%'`), t).toHaveLength(0);

        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        for (const t of LLM_TABLES) {
          const rows = await tx.unsafe<{ site_id: string }[]>(`SELECT site_id FROM ${t} WHERE site_id LIKE 'rls_%'`);
          expect(rows.length, t).toBeGreaterThan(0);
          expect(new Set(rows.map((r) => r.site_id)), t).toEqual(new Set(['rls_a']));
        }
        expect(await tx`UPDATE lumibase_llm_providers SET name = 'x' WHERE id = 'rls_llm_b' RETURNING id`).toHaveLength(0);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_llm_routes (site_id, task_type, position, provider_id) VALUES ('rls_b', 'chat', 1, 'rls_llm_b')`),
        ).rejects.toThrow(/row-level security/);
      },
      async (tx) => {
        for (const site of ['rls_a', 'rls_b']) {
          const p = `rls_llm_${site.slice(-1)}`;
          await tx`INSERT INTO lumibase_llm_providers (id, site_id, name, kind, base_url, model, capabilities, pricing_kind, input_price_micros, output_price_micros, currency)
                   VALUES (${p}, ${site}, 'p', 'openai_compatible', 'https://api.example.com/v1', 'm', '{"tools":true,"json":true,"maxContext":null}'::jsonb, 'per_1m_tokens', 1, 1, 'USD')`;
          await tx`INSERT INTO lumibase_llm_routes (site_id, task_type, position, provider_id) VALUES (${site}, 'chat', 0, ${p})`;
          await tx`INSERT INTO lumibase_llm_site_settings (site_id, currency) VALUES (${site}, 'USD')`;
          await tx`INSERT INTO lumibase_llm_calls (id, site_id, call_key, task_type, origin_kind, request_digest, candidates, deadline_at, status, terminal_reason)
                   VALUES (${`${p}_call`}, ${site}, 'k', 'chat', 'test', 'd', '[]'::jsonb, now(), 'failed', 'TEST')`;
          await tx`INSERT INTO lumibase_llm_attempts (id, site_id, call_id, seq, position, source, provider_id, snapshot, request_digest, period, outcome, billing, reserved_micros)
                   VALUES (${`${p}_att`}, ${site}, ${`${p}_call`}, 1, 0, 'site', ${p}, '{}'::jsonb, 'd', '2026-10', 'failed_final', 'cancelled', 0)`;
        }
      },
    );
  });

  it('the public projection is isolated per site; hosts, change records and rebuild marks are not (P06 design R20)', async () => {
    const PROJECTION = ['lumibase_public_sites', 'lumibase_public_items', 'lumibase_public_alternates', 'lumibase_public_path_memory', 'lumibase_route_tombstones', 'lumibase_site_render_versions'];
    await asAppRole(
      async (tx) => {
        const flags = await tx<{ relname: string; on: boolean }[]>`
          SELECT relname, relrowsecurity AND relforcerowsecurity AS on FROM pg_class
          WHERE relname = ANY(${[...PROJECTION, 'lumibase_public_hosts', 'lumibase_projection_dirty', 'lumibase_projection_rebuilds']})`;
        expect(Object.fromEntries(flags.map((f) => [f.relname, f.on]))).toEqual({
          ...Object.fromEntries(PROJECTION.map((t) => [t, true])),
          lumibase_public_hosts: false,
          lumibase_projection_dirty: false,
          lumibase_projection_rebuilds: false,
        });
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        for (const t of PROJECTION) {
          const rows = await tx.unsafe<{ site_id: string }[]>(`SELECT site_id FROM ${t} WHERE site_id LIKE 'rls_%'`);
          expect(new Set(rows.map((r) => r.site_id)), t).toEqual(new Set(['rls_a']));
        }
        expect(await tx`DELETE FROM lumibase_public_items WHERE site_id = 'rls_b' RETURNING item_id`).toHaveLength(0);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_route_tombstones (site_id, locale, path, item_id) VALUES ('rls_b', 'en', '/gone/', 'rls_b_1')`),
        ).rejects.toThrow(/row-level security/);
      },
      async (tx) => {
        for (const site of ['rls_a', 'rls_b']) {
          await tx`INSERT INTO lumibase_public_sites (site_id, name, default_language, settings) VALUES (${site}, 'x', 'en', '{}'::jsonb)`;
          await tx`INSERT INTO lumibase_public_items (item_id, site_id, collection, locale, path, data, card, sanitizer, updated_at)
                   VALUES (${`${site}_1`}, ${site}, 'posts', 'en', '/x/', '{}'::jsonb, '{}'::jsonb, 1, now())`;
          await tx`INSERT INTO lumibase_public_alternates (site_id, item_id, target_item_id, locale, url) VALUES (${site}, ${`${site}_1`}, ${`${site}_1`}, 'en', '/x/')`;
          await tx`INSERT INTO lumibase_public_path_memory (item_id, site_id, locale, path) VALUES (${`${site}_1`}, ${site}, 'en', '/x/')`;
          await tx`INSERT INTO lumibase_route_tombstones (site_id, locale, path, item_id) VALUES (${site}, 'en', '/old/', ${`${site}_1`})`;
          await tx`INSERT INTO lumibase_site_render_versions (site_id, version) VALUES (${site}, 1)`;
        }
      },
    );
  });

  it('themes: versions, assets and the active pointer are isolated per site (P06 task 2.3)', async () => {
    const THEME_TABLES = ['lumibase_themes', 'lumibase_theme_versions', 'lumibase_theme_assets', 'lumibase_site_themes'];
    await asAppRole(
      async (tx) => {
        const flags = await tx<{ relname: string; on: boolean }[]>`
          SELECT relname, relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = ANY(${THEME_TABLES})`;
        expect(Object.fromEntries(flags.map((f) => [f.relname, f.on]))).toEqual(Object.fromEntries(THEME_TABLES.map((t) => [t, true])));
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        for (const t of THEME_TABLES) {
          const rows = await tx.unsafe<{ site_id: string }[]>(`SELECT site_id FROM ${t} WHERE site_id LIKE 'rls_%'`);
          expect(new Set(rows.map((r) => r.site_id)), t).toEqual(new Set(['rls_a']));
        }
        await expect(tx.savepoint((sp) => sp`INSERT INTO lumibase_themes (id, site_id, name) VALUES ('rls_t_x', 'rls_b', 'x')`)).rejects.toThrow(/row-level security/);
      },
      async (tx) => {
        for (const site of ['rls_a', 'rls_b']) {
          await tx`INSERT INTO lumibase_themes (id, site_id, name) VALUES (${`${site}_t`}, ${site}, 'main')`;
          await tx`INSERT INTO lumibase_theme_versions (id, site_id, theme_id, number, templates, assets) VALUES (${`${site}_v`}, ${site}, ${`${site}_t`}, 1, '{}'::jsonb,
                   jsonb_build_array(jsonb_build_object('path', 'a.css', 'sha256', encode(sha256('a'::bytea), 'hex'), 'contentType', 'text/css', 'size', 1)))`;
          await tx`INSERT INTO lumibase_theme_assets (version_id, site_id, path, sha256, content_type, bytes) VALUES (${`${site}_v`}, ${site}, 'a.css', encode(sha256('a'::bytea), 'hex'), 'text/css', 'a'::bytea)`;
          // The pointer names a sealed, published version only.
          await tx`SELECT heopress_seal_theme_version(${`${site}_v`}, ${site})`;
          await tx`UPDATE lumibase_theme_versions SET published_at = now() WHERE id = ${`${site}_v`}`;
          await tx`INSERT INTO lumibase_site_themes (site_id, theme_version_id) VALUES (${site}, ${`${site}_v`})`;
        }
      },
    );
  });

  it('SEO settings: isolated per site (P07 task 1.4)', async () => {
    await asAppRole(
      async (tx) => {
        const [flag] = await tx<{ on: boolean }[]>`
          SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = 'lumibase_site_seo_settings'`;
        expect(flag?.on).toBe(true);
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        // Both sites have a row; only A's is visible, B's cannot be changed or deleted.
        expect((await tx`SELECT site_id FROM lumibase_site_seo_settings WHERE site_id LIKE 'rls_%'`).map((r) => r.site_id)).toEqual(['rls_a']);
        expect(await tx`UPDATE lumibase_site_seo_settings SET version = version + 1 WHERE site_id = 'rls_b' RETURNING site_id`).toHaveLength(0);
        expect(await tx`DELETE FROM lumibase_site_seo_settings WHERE site_id = 'rls_b' RETURNING site_id`).toHaveLength(0);
        // A's row cannot be moved to another site, nor a row written for one.
        await expect(tx.savepoint((sp) => sp`UPDATE lumibase_site_seo_settings SET site_id = 'rls_c' WHERE site_id = 'rls_a'`)).rejects.toThrow(/row-level security/);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_site_seo_settings (site_id, settings, version) VALUES ('rls_c', '{}'::jsonb, 1)`),
        ).rejects.toThrow(/row-level security/);
        await tx`SELECT set_config('app.site_id', 'rls_b', true)`;
        expect((await tx`SELECT version FROM lumibase_site_seo_settings WHERE site_id = 'rls_b'`).map((r) => r.version)).toEqual([7]);
      },
      async (tx) => {
        await tx`INSERT INTO lumibase_sites (id, name) VALUES ('rls_c', 'RLS C')`;
        await tx`INSERT INTO lumibase_site_seo_settings (site_id, settings, version) VALUES ('rls_a', '{}'::jsonb, 1), ('rls_b', '{}'::jsonb, 7)`;
      },
    );
  });

  it('site identity: isolated per site (P07 task 2.12)', async () => {
    await asAppRole(
      async (tx) => {
        const [flag] = await tx<{ on: boolean }[]>`
          SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = 'lumibase_site_identity'`;
        expect(flag?.on).toBe(true);
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        expect((await tx`SELECT site_id FROM lumibase_site_identity WHERE site_id LIKE 'rls_%'`).map((r) => r.site_id)).toEqual(['rls_a']);
        expect(await tx`UPDATE lumibase_site_identity SET version = version + 1 WHERE site_id = 'rls_b' RETURNING site_id`).toHaveLength(0);
        expect(await tx`DELETE FROM lumibase_site_identity WHERE site_id = 'rls_b' RETURNING site_id`).toHaveLength(0);
        await expect(tx.savepoint((sp) => sp`UPDATE lumibase_site_identity SET site_id = 'rls_c' WHERE site_id = 'rls_a'`)).rejects.toThrow(/row-level security/);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_site_identity (site_id, identity, version) VALUES ('rls_c', '{}'::jsonb, 1)`),
        ).rejects.toThrow(/row-level security/);
        await tx`SELECT set_config('app.site_id', 'rls_b', true)`;
        expect((await tx`SELECT version FROM lumibase_site_identity WHERE site_id = 'rls_b'`).map((r) => r.version)).toEqual([4]);
      },
      async (tx) => {
        await tx`INSERT INTO lumibase_sites (id, name) VALUES ('rls_c', 'RLS C') ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO lumibase_site_identity (site_id, identity, version) VALUES ('rls_a', '{"kind":"person","name":"A"}'::jsonb, 1), ('rls_b', '{"kind":"person","name":"B"}'::jsonb, 4)`;
      },
    );
  });

  it('root files: isolated per site (P07 task 3.8)', async () => {
    await asAppRole(
      async (tx) => {
        const [flag] = await tx<{ on: boolean }[]>`
          SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = 'lumibase_site_root_files'`;
        expect(flag?.on).toBe(true);
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        expect((await tx`SELECT site_id FROM lumibase_site_root_files WHERE site_id LIKE 'rls_%'`).map((r) => r.site_id)).toEqual(['rls_a']);
        expect(await tx`UPDATE lumibase_site_root_files SET content = 'x' WHERE site_id = 'rls_b' RETURNING site_id`).toHaveLength(0);
        expect(await tx`DELETE FROM lumibase_site_root_files WHERE site_id = 'rls_b' RETURNING site_id`).toHaveLength(0);
        await expect(tx.savepoint((sp) => sp`UPDATE lumibase_site_root_files SET site_id = 'rls_b' WHERE site_id = 'rls_a'`)).rejects.toThrow(/row-level security/);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_site_root_files (id, site_id, filename, content_type, content, sha256, size) VALUES ('rls_rf_c', 'rls_b', 'x.txt', 'text/plain', 'x', 'h', 1)`),
        ).rejects.toThrow(/row-level security/);
        await tx`SELECT set_config('app.site_id', 'rls_b', true)`;
        expect((await tx`SELECT content FROM lumibase_site_root_files WHERE site_id = 'rls_b'`).map((r) => r.content)).toEqual(['b']);
      },
      async (tx) => {
        await tx`INSERT INTO lumibase_site_root_files (id, site_id, filename, content_type, content, sha256, size)
                 VALUES ('rls_rf_a', 'rls_a', 'ads.txt', 'text/plain', 'a', 'h', 1), ('rls_rf_b', 'rls_b', 'ads.txt', 'text/plain', 'b', 'h', 1)`;
      },
    );
  });

  it('IndexNow state and status: isolated per site; the queue is the worker\'s, read across sites (P07 task 3.4)', async () => {
    await asAppRole(
      async (tx) => {
        for (const table of ['lumibase_indexnow_state', 'lumibase_indexnow_sites']) {
          const [flag] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = ${table}`;
          expect(flag?.on, table).toBe(true);
        }
        const [queue] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'lumibase_indexnow_queue'`;
        expect(queue?.on).toBe(false);
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        expect((await tx`SELECT url FROM lumibase_indexnow_state WHERE site_id LIKE 'rls_%'`).map((r) => r.url)).toEqual(['https://a.example.com/x/']);
        expect((await tx`SELECT site_id FROM lumibase_indexnow_sites WHERE site_id LIKE 'rls_%'`).map((r) => r.site_id)).toEqual(['rls_a']);
        expect(await tx`DELETE FROM lumibase_indexnow_state WHERE site_id = 'rls_b' RETURNING url`).toHaveLength(0);
        expect(await tx`UPDATE lumibase_indexnow_sites SET lease_token = 'x' WHERE site_id = 'rls_b' RETURNING site_id`).toHaveLength(0);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_indexnow_state (site_id, url, fingerprint) VALUES ('rls_b', 'https://evil.example.com/', 'f')`),
        ).rejects.toThrow(/row-level security/);
        // The queue: every site's rows, whatever the scope (the worker picks the due sites).
        expect((await tx`SELECT site_id FROM lumibase_indexnow_queue WHERE site_id LIKE 'rls_%' ORDER BY site_id`).map((r) => r.site_id)).toEqual(['rls_a', 'rls_b']);
      },
      async (tx) => {
        await tx`INSERT INTO lumibase_indexnow_state (site_id, url, fingerprint) VALUES ('rls_a', 'https://a.example.com/x/', 'f'), ('rls_b', 'https://b.example.com/x/', 'f')`;
        await tx`INSERT INTO lumibase_indexnow_sites (site_id) VALUES ('rls_a'), ('rls_b')`;
        await tx`INSERT INTO lumibase_indexnow_queue (id, site_id, event_id, due_at) VALUES ('rls_q_a', 'rls_a', 'rls:a', now()), ('rls_q_b', 'rls_b', 'rls:b', now())`;
      },
    );
  });

  it('link graph: edges isolated per site; the scans are the worker\'s, read across sites (P07 task 5.3)', async () => {
    await asAppRole(
      async (tx) => {
        const [flag] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = 'lumibase_link_edges'`;
        expect(flag?.on).toBe(true);
        const [scans] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'lumibase_link_scans'`;
        expect(scans?.on).toBe(false);
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        expect((await tx`SELECT id FROM lumibase_link_edges WHERE site_id LIKE 'rls_%'`).map((r) => r.id)).toEqual(['rls_le_a']);
        expect(await tx`DELETE FROM lumibase_link_edges WHERE site_id = 'rls_b' RETURNING id`).toHaveLength(0);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_link_edges (id, site_id, origin, href, target_url) VALUES ('rls_le_x', 'rls_b', 'manual', '/x', 'https://b.example.com/x')`),
        ).rejects.toThrow(/row-level security/);
        expect((await tx`SELECT site_id FROM lumibase_link_scans WHERE site_id LIKE 'rls_%' ORDER BY site_id`).map((r) => r.site_id)).toEqual(['rls_a', 'rls_b']);
      },
      async (tx) => {
        await tx`INSERT INTO lumibase_link_edges (id, site_id, origin, href, target_url) VALUES ('rls_le_a', 'rls_a', 'auto', '/x', 'https://a.example.com/x'), ('rls_le_b', 'rls_b', 'auto', '/x', 'https://b.example.com/x')`;
        await tx`INSERT INTO lumibase_link_scans (site_id, status, started_at) VALUES ('rls_a', 'running', now()), ('rls_b', 'running', now())`;
      },
    );
  });

  it('system events: the app role inserts; reads only under app.platform_reader or app.retention; deletes only under app.retention (HeoPress P07a task 11.4)', async () => {
    await asAppRole(
      async (tx) => {
        const [flag] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = 'lumibase_system_events'`;
        expect(flag?.on).toBe(true);
        await tx`INSERT INTO lumibase_system_events (id, level, source, event, message, occurred_at) VALUES ('rls_se_new', 'info', 'scheduler', 'x', 'm', now())`;
        expect(await tx`SELECT id FROM lumibase_system_events WHERE id LIKE 'rls_se_%'`).toHaveLength(0);
        expect(await tx`DELETE FROM lumibase_system_events WHERE id LIKE 'rls_se_%' RETURNING id`).toHaveLength(0);
        await tx`SELECT set_config('app.platform_reader', 'on', true)`;
        expect((await tx`SELECT id FROM lumibase_system_events WHERE id LIKE 'rls_se_%' ORDER BY id`).map((r) => r.id)).toEqual(['rls_se_new', 'rls_se_old']);
        expect(await tx`DELETE FROM lumibase_system_events WHERE id LIKE 'rls_se_%' RETURNING id`).toHaveLength(0);
        await tx`SELECT set_config('app.retention', 'on', true)`;
        expect((await tx`DELETE FROM lumibase_system_events WHERE id LIKE 'rls_se_%' AND occurred_at < now() - interval '90 days' RETURNING id`).map((r) => r.id)).toEqual(['rls_se_old']);
      },
      async (tx) => {
        await tx`INSERT INTO lumibase_system_events (id, level, source, event, message, occurred_at) VALUES ('rls_se_old', 'info', 'scheduler', 'x', 'm', now() - interval '91 days')`;
      },
    );
  });

  it('audit triage: ignore states and resolutions isolated per site (HeoPress P07a task 10.1)', async () => {
    await asAppRole(
      async (tx) => {
        for (const table of ['lumibase_audit_issue_states', 'lumibase_audit_issue_resolutions']) {
          const [flag] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = ${table}`;
          expect(flag?.on, table).toBe(true);
        }
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        expect((await tx`SELECT fingerprint FROM lumibase_audit_issue_states WHERE site_id LIKE 'rls_%'`).map((r) => r.fingerprint)).toEqual(['links/broken:a']);
        expect((await tx`SELECT id FROM lumibase_audit_issue_resolutions WHERE site_id LIKE 'rls_%'`).map((r) => r.id)).toEqual(['rls_res_a']);
        expect(await tx`DELETE FROM lumibase_audit_issue_states WHERE site_id = 'rls_b' RETURNING fingerprint`).toHaveLength(0);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_audit_issue_resolutions (id, site_id, fingerprint, rule, severity, title, first_seen_at) VALUES ('rls_res_x', 'rls_b', 'x', 'r', 'error', 't', now())`),
        ).rejects.toThrow(/row-level security/);
      },
      async (tx) => {
        await tx`INSERT INTO lumibase_audit_issue_states (site_id, fingerprint, status, until) VALUES ('rls_a', 'links/broken:a', 'ignored', now() + interval '1 day'), ('rls_b', 'links/broken:b', 'ignored', now() + interval '1 day')`;
        await tx`INSERT INTO lumibase_audit_issue_resolutions (id, site_id, fingerprint, rule, severity, title, first_seen_at) VALUES ('rls_res_a', 'rls_a', 'a', 'r', 'error', 't', now()), ('rls_res_b', 'rls_b', 'b', 'r', 'error', 't', now())`;
      },
    );
  });

  it('site audit: issues isolated per site; the run states are the worker\'s, read across sites (P07 task 5.1)', async () => {
    await asAppRole(
      async (tx) => {
        const [flag] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = 'lumibase_audit_issues'`;
        expect(flag?.on).toBe(true);
        const [runs] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'lumibase_audit_sites'`;
        expect(runs?.on).toBe(false);
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        expect((await tx`SELECT id FROM lumibase_audit_issues WHERE site_id LIKE 'rls_%'`).map((r) => r.id)).toEqual(['rls_ai_a']);
        expect(await tx`DELETE FROM lumibase_audit_issues WHERE site_id = 'rls_b' RETURNING id`).toHaveLength(0);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_audit_issues (id, site_id, rule, severity, fingerprint, evidence) VALUES ('rls_ai_x', 'rls_b', 'r', 'error', 'x', '{}')`),
        ).rejects.toThrow(/row-level security/);
        expect((await tx`SELECT site_id FROM lumibase_audit_sites WHERE site_id LIKE 'rls_%' ORDER BY site_id`).map((r) => r.site_id)).toEqual(['rls_a', 'rls_b']);
      },
      async (tx) => {
        await tx`INSERT INTO lumibase_audit_issues (id, site_id, rule, severity, fingerprint, evidence) VALUES ('rls_ai_a', 'rls_a', 'r', 'error', 'a', '{}'), ('rls_ai_b', 'rls_b', 'r', 'error', 'b', '{}')`;
        await tx`INSERT INTO lumibase_audit_sites (site_id) VALUES ('rls_a'), ('rls_b')`;
      },
    );
  });

  it('reachability check: reports isolated per site; the run states are the worker\'s, read across sites (P07 task 3.9)', async () => {
    await asAppRole(
      async (tx) => {
        const [flag] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = 'lumibase_reachability_reports'`;
        expect(flag?.on).toBe(true);
        const [runs] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'lumibase_reachability_sites'`;
        expect(runs?.on).toBe(false);
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        expect((await tx`SELECT site_id FROM lumibase_reachability_reports WHERE site_id LIKE 'rls_%'`).map((r) => r.site_id)).toEqual(['rls_a']);
        expect(await tx`UPDATE lumibase_reachability_reports SET errors = 9 WHERE site_id = 'rls_b' RETURNING site_id`).toHaveLength(0);
        expect(await tx`DELETE FROM lumibase_reachability_reports WHERE site_id = 'rls_b' RETURNING site_id`).toHaveLength(0);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_reachability_reports (site_id, report) VALUES ('rls_c', '{}')`),
        ).rejects.toThrow(/row-level security/);
        expect((await tx`SELECT site_id FROM lumibase_reachability_sites WHERE site_id LIKE 'rls_%' ORDER BY site_id`).map((r) => r.site_id)).toEqual(['rls_a', 'rls_b']);
      },
      async (tx) => {
        await tx`INSERT INTO lumibase_reachability_reports (site_id, report) VALUES ('rls_a', '{}'), ('rls_b', '{}')`;
        await tx`INSERT INTO lumibase_reachability_sites (site_id) VALUES ('rls_a'), ('rls_b')`;
      },
    );
  });

  it('AI traffic: details, day totals and day paths isolated per site (P07 task 6.4)', async () => {
    await asAppRole(
      async (tx) => {
        for (const table of ['lumibase_crawl_hits', 'lumibase_crawl_daily', 'lumibase_crawl_daily_paths']) {
          const [flag] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = ${table}`;
          expect(flag?.on, table).toBe(true);
        }
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        expect((await tx`SELECT site_id FROM lumibase_crawl_hits WHERE site_id LIKE 'rls_%'`).map((r) => r.site_id)).toEqual(['rls_a']);
        expect((await tx`SELECT site_id FROM lumibase_crawl_daily WHERE site_id LIKE 'rls_%'`).map((r) => r.site_id)).toEqual(['rls_a']);
        expect((await tx`SELECT site_id FROM lumibase_crawl_daily_paths WHERE site_id LIKE 'rls_%'`).map((r) => r.site_id)).toEqual(['rls_a']);
        expect(await tx`DELETE FROM lumibase_crawl_hits WHERE site_id = 'rls_b' RETURNING id`).toHaveLength(0);
        expect(await tx`DELETE FROM lumibase_crawl_daily_paths WHERE site_id = 'rls_b' RETURNING path`).toHaveLength(0);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_crawl_daily (site_id, day, kind, agent, operator, resource, path, hits) VALUES ('rls_b', current_date, 'crawler', 'x', 'x', 'page', '/', 1)`),
        ).rejects.toThrow(/row-level security/);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_crawl_daily_paths (site_id, day, path) VALUES ('rls_b', current_date, '/y')`),
        ).rejects.toThrow(/row-level security/);
      },
      async (tx) => {
        await tx`INSERT INTO lumibase_crawl_daily_paths (site_id, day, path) VALUES ('rls_a', current_date, '/'), ('rls_b', current_date, '/')`;
        await tx`INSERT INTO lumibase_crawl_hits (site_id, kind, agent, operator, resource, path, status) VALUES ('rls_a', 'crawler', 'gptbot', 'OpenAI', 'page', '/', 200), ('rls_b', 'crawler', 'gptbot', 'OpenAI', 'page', '/', 200)`;
        await tx`INSERT INTO lumibase_crawl_daily (site_id, day, kind, agent, operator, resource, path, hits) VALUES ('rls_a', current_date, 'crawler', 'gptbot', 'OpenAI', 'page', '/', 1), ('rls_b', current_date, 'crawler', 'gptbot', 'OpenAI', 'page', '/', 1)`;
      },
    );
  });

  it('ingest fetching: snapshots, source documents, attempts and processing jobs isolated per site; host slots global (P08 task 2.7)', async () => {
    await asAppRole(
      async (tx) => {
        for (const table of ['lumibase_ingest_snapshots', 'lumibase_ingest_source_documents', 'lumibase_ingest_fetch_attempts', 'lumibase_ingest_processing_jobs']) {
          const [flag] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = ${table}`;
          expect(flag?.on, table).toBe(true);
        }
        const [slots] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'lumibase_ingest_host_slots'`;
        expect(slots?.on).toBe(false);
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        expect((await tx`SELECT id FROM lumibase_ingest_snapshots WHERE site_id LIKE 'rls_%'`).map((r) => r.id)).toEqual(['rls_snap_a']);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_ingest_snapshots (id, site_id, sha256, storage_key, byte_size, content_type) VALUES ('rls_snap_x', 'rls_b', 'x', 'k', 1, 'text/html')`),
        ).rejects.toThrow(/row-level security/);
      },
      async (tx) => {
        for (const s of ['a', 'b']) {
          await tx`INSERT INTO lumibase_ingest_snapshots (id, site_id, sha256, storage_key, byte_size, content_type)
                   VALUES (${`rls_snap_${s}`}, ${`rls_${s}`}, ${`sha_${s}`}, ${`ingest/snapshots/rls_${s}/x.html`}, 1, 'text/html')`;
        }
      },
    );
  });

  it('ingest discovery: cursors, discovered URLs and event clusters isolated per site; the near-duplicate index global (P08 tasks 1.3, 4.2)', async () => {
    await asAppRole(
      async (tx) => {
        for (const table of ['lumibase_ingest_source_cursors', 'lumibase_ingest_discovered_urls', 'lumibase_ingest_event_clusters']) {
          const [flag] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = ${table}`;
          expect(flag?.on, table).toBe(true);
        }
        const [index] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'lumibase_ingest_dedup_index'`;
        expect(index?.on).toBe(false);
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        expect((await tx`SELECT id FROM lumibase_ingest_event_clusters WHERE site_id LIKE 'rls_%'`).map((r) => r.id)).toEqual(['rls_ev_a']);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_ingest_event_clusters (id, site_id, fingerprint, entities, representative_document_id, first_seen_at, last_seen_at) VALUES ('rls_ev_x', 'rls_b', 'f', '{}', 'd', now(), now())`),
        ).rejects.toThrow(/row-level security/);
      },
      async (tx) => {
        for (const s of ['a', 'b']) {
          await tx`INSERT INTO lumibase_ingest_event_clusters (id, site_id, fingerprint, entities, representative_document_id, first_seen_at, last_seen_at)
                   VALUES (${`rls_ev_${s}`}, ${`rls_${s}`}, 'f', '{n:x}', 'd', now(), now())`;
        }
      },
    );
  });

  it('content sources: sources, licence revisions and runs isolated per site; the schedule is the worker\'s, read across sites (P08 task 1.1)', async () => {
    await asAppRole(
      async (tx) => {
        for (const table of ['lumibase_ingest_sources', 'lumibase_ingest_source_licences', 'lumibase_ingest_source_runs']) {
          const [flag] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = ${table}`;
          expect(flag?.on, table).toBe(true);
        }
        const [schedule] = await tx<{ on: boolean }[]>`SELECT relrowsecurity AS on FROM pg_class WHERE relname = 'lumibase_ingest_schedule'`;
        expect(schedule?.on).toBe(false);
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        expect((await tx`SELECT id FROM lumibase_ingest_sources WHERE site_id LIKE 'rls_%'`).map((r) => r.id)).toEqual(['rls_src_a']);
        expect((await tx`SELECT id FROM lumibase_ingest_source_licences WHERE site_id LIKE 'rls_%'`).map((r) => r.id)).toEqual(['rls_lic_a']);
        expect((await tx`SELECT id FROM lumibase_ingest_source_runs WHERE site_id LIKE 'rls_%'`).map((r) => r.id)).toEqual(['rls_run_a']);
        expect(await tx`UPDATE lumibase_ingest_sources SET licence_status = 'licensed' WHERE site_id = 'rls_b' RETURNING id`).toHaveLength(0);
        expect(await tx`DELETE FROM lumibase_ingest_source_licences WHERE site_id = 'rls_b' RETURNING id`).toHaveLength(0);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_ingest_sources (id, site_id, name, type, url, schedule_times, timezone) VALUES ('rls_src_x', 'rls_b', 'x', 'rss', 'https://b.example.com/x', '{08:00}', 'UTC')`),
        ).rejects.toThrow(/row-level security/);
        expect((await tx`SELECT site_id FROM lumibase_ingest_schedule WHERE site_id LIKE 'rls_%' ORDER BY site_id`).map((r) => r.site_id)).toEqual(['rls_a', 'rls_b']);
      },
      async (tx) => {
        for (const s of ['a', 'b']) {
          await tx`INSERT INTO lumibase_ingest_sources (id, site_id, name, type, url, schedule_times, timezone)
                   VALUES (${`rls_src_${s}`}, ${`rls_${s}`}, 'feed', 'rss', ${`https://${s}.example.com/feed`}, '{08:00}', 'UTC')`;
          await tx`INSERT INTO lumibase_ingest_source_licences (id, site_id, source_id, licence_status, usage_mode, commercial_use, trust_level)
                   VALUES (${`rls_lic_${s}`}, ${`rls_${s}`}, ${`rls_src_${s}`}, 'unknown', 'discovery_only', false, 'low')`;
          await tx`INSERT INTO lumibase_ingest_source_runs (id, site_id, source_id, scheduled_for) VALUES (${`rls_run_${s}`}, ${`rls_${s}`}, ${`rls_src_${s}`}, now())`;
          await tx`INSERT INTO lumibase_ingest_schedule (source_id, site_id, next_run_at) VALUES (${`rls_src_${s}`}, ${`rls_${s}`}, now())`;
        }
      },
    );
  });

  it('preview links: looked up in one site only (P06 task 4.3)', async () => {
    await asAppRole(
      async (tx) => {
        const [flags] = await tx<{ on: boolean }[]>`
          SELECT relrowsecurity AND relforcerowsecurity AS on FROM pg_class WHERE relname = 'lumibase_preview_links'`;
        expect(flags?.on).toBe(true);
        // A token of site A looked up while serving site B finds nothing.
        await tx`SELECT set_config('app.site_id', 'rls_b', true)`;
        expect(await tx`SELECT id FROM lumibase_preview_links WHERE token_hash = 'rls_hash_a'`).toHaveLength(0);
        await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
        expect((await tx`SELECT id FROM lumibase_preview_links WHERE token_hash = 'rls_hash_a'`).map((r) => r.id)).toEqual(['rls_pl_a']);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_preview_links (id, site_id, kind, target_id, created_by, token_hash, expires_at)
                                  VALUES ('rls_pl_x', 'rls_b', 'theme', 'v', 'rls_pl_user', 'rls_hash_x', now())`),
        ).rejects.toThrow(/row-level security/);
      },
      async (tx) => {
        await tx`INSERT INTO lumibase_users (id, email) VALUES ('rls_pl_user', 'preview@example.com')`;
        for (const site of ['rls_a', 'rls_b']) {
          await tx`INSERT INTO lumibase_preview_links (id, site_id, kind, target_id, created_by, token_hash, expires_at)
                   VALUES (${`rls_pl_${site.slice(-1)}`}, ${site}, 'theme', 'v', 'rls_pl_user', ${`rls_hash_${site.slice(-1)}`}, now() + interval '1 hour')`;
        }
      },
    );
  });

  it('translation groups: visible to every member site, members only to their own site (P05 design R1)', async () => {
    await asAppRole(
      async (tx) => {
        await tx`SELECT set_config('app.site_id', 'rls_b', true)`;
        // Site B has a member of A's group: it sees the group row and only its own member.
        expect((await tx`SELECT id FROM lumibase_translation_groups WHERE id LIKE 'rls_%'`).map((r) => r.id)).toEqual(['rls_g_ab']);
        expect((await tx`SELECT item_id FROM lumibase_translation_group_members WHERE group_id = 'rls_g_ab'`).map((r) => r.item_id)).toEqual(['rls_b_1']);
        // It may change the group (a member site) but cannot hand it to a site with no member.
        expect(await tx`UPDATE lumibase_translation_groups SET version = version + 1 WHERE id = 'rls_g_ab' RETURNING id`).toHaveLength(1);
        await expect(
          tx.savepoint((sp) => sp`UPDATE lumibase_translation_groups SET site_ids = ARRAY['rls_c'] WHERE id = 'rls_g_ab'`),
        ).rejects.toThrow(/row-level security/);
        // A's own group without a B member stays out of sight.
        expect(await tx`SELECT id FROM lumibase_translation_groups WHERE id = 'rls_g_a'`).toHaveLength(0);
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_translation_group_members (item_id, group_id, site_id, collection_id, locale, role)
                                  VALUES ('rls_a_1', 'rls_g_ab', 'rls_a', 'rls_a_posts', 'en', 'translation')`),
        ).rejects.toThrow(/row-level security/);
        // Forging (design R44): B cannot take over the group, list a site without members, or slip a member
        // into a group that does not list its site.
        await expect(tx.savepoint((sp) => sp`UPDATE lumibase_translation_groups SET site_id = 'rls_b' WHERE id = 'rls_g_ab'`)).rejects.toThrow(/creating site/);
        await expect(
          tx.savepoint(async (sp) => {
            await sp`UPDATE lumibase_translation_groups SET site_ids = ARRAY['rls_a', 'rls_b', 'rls_c'] WHERE id = 'rls_g_ab'`;
            await sp`SET CONSTRAINTS translation_group_sites_check IMMEDIATE`;
          }),
        ).rejects.toThrow(/without a member/);
        await tx`SET CONSTRAINTS translation_group_sites_check DEFERRED`;
        await tx`INSERT INTO lumibase_items (id, site_id, collection_id, status, data) VALUES ('rls_b_2', 'rls_b', 'rls_b_posts', 'draft', '{}'::jsonb)`;
        await tx`SELECT set_config('app.site_id', 'rls_b', true)`;
        await expect(
          tx.savepoint((sp) => sp`INSERT INTO lumibase_translation_group_members (item_id, group_id, site_id, collection_id, locale, role)
                                  VALUES ('rls_b_2', 'rls_g_a', 'rls_b', 'rls_b_posts', 'en', 'translation')`),
        ).rejects.toThrow(/does not list site/);
        // Members alone cannot leave a group inconsistent either: B's only member removed (or moved) while the
        // group still lists B fails at commit.
        await expect(
          tx.savepoint(async (sp) => {
            await sp`DELETE FROM lumibase_translation_group_members WHERE item_id = 'rls_b_1'`;
            await sp`SET CONSTRAINTS translation_member_sites_check IMMEDIATE`;
          }),
        ).rejects.toThrow(/without a member/);
        await tx`SET CONSTRAINTS translation_member_sites_check DEFERRED`;
        await tx`SELECT set_config('app.site_id', '', true)`;
        expect(await tx`SELECT id FROM lumibase_translation_groups WHERE id LIKE 'rls_%'`).toHaveLength(0);
      },
      async (tx) => {
        await tx`INSERT INTO lumibase_sites (id, name) VALUES ('rls_c', 'RLS C')`;
        await tx`INSERT INTO lumibase_translation_groups (id, site_id, site_ids) VALUES ('rls_g_ab', 'rls_a', ARRAY['rls_a', 'rls_b']), ('rls_g_a', 'rls_a', ARRAY['rls_a'])`;
        await tx`INSERT INTO lumibase_translation_group_members (item_id, group_id, site_id, collection_id, locale, role)
                 VALUES ('rls_a_1', 'rls_g_ab', 'rls_a', 'rls_a_posts', 'en', 'source'), ('rls_b_1', 'rls_g_ab', 'rls_b', 'rls_b_posts', 'zh-CN', 'translation')`;
        await tx`INSERT INTO lumibase_items (id, site_id, collection_id, status, data) VALUES ('rls_a_2', 'rls_a', 'rls_a_posts', 'draft', '{}'::jsonb)`;
        await tx`INSERT INTO lumibase_translation_group_members (item_id, group_id, site_id, collection_id, locale, role)
                 VALUES ('rls_a_2', 'rls_g_a', 'rls_a', 'rls_a_posts', 'en', 'source')`;
        // Check the groups now (they are consistent): pending checks would block applying the policies.
        await tx`SET CONSTRAINTS translation_group_sites_check, translation_member_sites_check IMMEDIATE`;
        await tx`SET CONSTRAINTS translation_group_sites_check, translation_member_sites_check DEFERRED`;
      },
    );
  });

  it('extensions: a site reads global rows but writes only its own', async () => {
    await asAppRole(async (tx) => {
      await assertRlsApplies(tx);
      await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
      const visible = await tx<{ id: string }[]>`SELECT id FROM lumibase_extensions WHERE id LIKE 'rls_ext_%' ORDER BY id`;
      expect(visible.map((r) => r.id)).toEqual(['rls_ext_a', 'rls_ext_global']);
      // Global rows: neither changed nor deleted from a site scope.
      expect(await tx`UPDATE lumibase_extensions SET enabled = true WHERE id = 'rls_ext_global' RETURNING id`).toHaveLength(0);
      expect(await tx`DELETE FROM lumibase_extensions WHERE id = 'rls_ext_global' RETURNING id`).toHaveLength(0);
      // Its own row can be changed, but not made global.
      expect(await tx`UPDATE lumibase_extensions SET enabled = true WHERE id = 'rls_ext_a' RETURNING id`).toHaveLength(1);
      await expect(
        tx.savepoint((sp) => sp`UPDATE lumibase_extensions SET site_id = NULL WHERE id = 'rls_ext_a'`),
      ).rejects.toThrow(/row-level security/);
      await expect(
        tx.savepoint((sp) => sp`INSERT INTO lumibase_extensions (id, site_id, name, version, type, bundle_url)
                                VALUES ('rls_ext_new', NULL, 'n', '1', 'hook', 'x')`),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it('extensions: without a site only global rows are visible, and only the platform scope writes them', async () => {
    await asAppRole(async (tx) => {
      await tx`SELECT set_config('app.site_id', '', true)`;
      const visible = await tx<{ id: string }[]>`SELECT id FROM lumibase_extensions WHERE id LIKE 'rls_ext_%'`;
      expect(visible.map((r) => r.id)).toEqual(['rls_ext_global']);
      expect(await tx`UPDATE lumibase_extensions SET enabled = true WHERE id = 'rls_ext_global' RETURNING id`).toHaveLength(0);
      await tx`SELECT set_config('app.platform_scope', 'on', true)`;
      expect(await tx`UPDATE lumibase_extensions SET enabled = true WHERE id = 'rls_ext_global' RETURNING id`).toHaveLength(1);
      // The platform scope does not reach into a site, and needs no active site.
      expect(await tx`UPDATE lumibase_extensions SET enabled = true WHERE id = 'rls_ext_a' RETURNING id`).toHaveLength(0);
      await tx`SELECT set_config('app.site_id', 'rls_a', true)`;
      expect(await tx`UPDATE lumibase_extensions SET enabled = false WHERE id = 'rls_ext_global' RETURNING id`).toHaveLength(0);
    });
  });
});
