import { spawnSync } from 'node:child_process';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppRoleOwnsObjectsError, assertRlsApplies, ensureAppRole, probeRls, rlsBypassReason } from '../app-role';

/**
 * Provisioning of the application role (HeoPress P03 task 7.1, Codex review
 * round 5): the privileges it gets, the ones it must not get, and the
 * escalation paths an existing role is refused for. Every case runs in an
 * owner transaction with a throwaway role and is rolled back.
 *
 * Needs DATABASE_OWNER_URL (see rls.db.test.ts).
 */

const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const PROBE = 'heopress_role_probe';

class Rollback extends Error {}

describe.skipIf(!OWNER_URL)('application role provisioning', () => {
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

  async function privileges(tx: postgres.TransactionSql, table: string) {
    const [p] = await tx<{ sel: boolean; trunc: boolean; trig: boolean }[]>`
      SELECT has_table_privilege(${PROBE}, ${table}, 'SELECT') AS sel,
             has_table_privilege(${PROBE}, ${table}, 'TRUNCATE') AS trunc,
             has_table_privilege(${PROBE}, ${table}, 'TRIGGER') AS trig`;
    return p!;
  }

  it('grants row access, but neither TRUNCATE nor TRIGGER — also on tables later migrations create', async () => {
    await inRollback(async (tx) => {
      await ensureAppRole(tx, { role: PROBE, password: 'probe' });
      expect(await privileges(tx, 'lumibase_items')).toEqual({ sel: true, trunc: false, trig: false });
      // Default privileges: a table the owner creates afterwards.
      await tx`CREATE TABLE heopress_role_probe_later (id int)`;
      expect(await privileges(tx, 'heopress_role_probe_later')).toEqual({ sel: true, trunc: false, trig: false });
    });
  });

  it('testDatabase adds TRUNCATE (and the site-id exemption); a later run without it takes them back', async () => {
    await inRollback(async (tx) => {
      await ensureAppRole(tx, { role: PROBE, password: 'probe', testDatabase: true });
      expect(await privileges(tx, 'lumibase_items')).toEqual({ sel: true, trunc: true, trig: false });
      // What an earlier version of ensureAppRole granted.
      await tx.unsafe(`GRANT TRIGGER ON lumibase_items TO ${PROBE}`);
      await ensureAppRole(tx, { role: PROBE, password: 'probe' });
      expect(await privileges(tx, 'lumibase_items')).toEqual({ sel: true, trunc: false, trig: false });
      await tx`CREATE TABLE heopress_role_probe_later (id int)`;
      expect(await privileges(tx, 'heopress_role_probe_later')).toEqual({ sel: true, trunc: false, trig: false });
    });
  });

  it('HeoPress P07: only a test-database run writes the site-id exemption, any other run removes it; the hold tables are never the role\'s to write', async () => {
    await inRollback(async (tx) => {
      const exemption = async () => (await tx`SELECT except_prefix FROM lumibase_site_id_reuse_exemption`).map((r) => r.except_prefix);
      const writes = async (table: string) => {
        const [p] = await tx<{ ins: boolean; del: boolean; upd: boolean; trunc: boolean; cols: boolean }[]>`
          SELECT has_table_privilege(${PROBE}, ${table}, 'INSERT') AS ins,
                 has_table_privilege(${PROBE}, ${table}, 'DELETE') AS del,
                 has_table_privilege(${PROBE}, ${table}, 'UPDATE') AS upd,
                 has_table_privilege(${PROBE}, ${table}, 'TRUNCATE') AS trunc,
                 has_any_column_privilege(${PROBE}, ${table}, 'INSERT, UPDATE') AS cols`;
        return p!;
      };
      await ensureAppRole(tx, { role: PROBE, password: 'probe', testDatabase: true });
      expect(await exemption()).toEqual(['held-']);
      for (const t of ['lumibase_deleted_site_ids', 'lumibase_site_id_reuse_exemption']) {
        expect(await writes(t), t).toEqual({ ins: false, del: false, upd: false, trunc: false, cols: false });
      }
      // Grants an earlier installation may hold, column-level ones included: provisioning takes them back.
      await tx.unsafe(`GRANT INSERT (site_id), UPDATE (deleted_at) ON lumibase_deleted_site_ids TO ${PROBE}`);
      await tx.unsafe(`GRANT UPDATE (except_prefix) ON lumibase_site_id_reuse_exemption TO ${PROBE}`);
      await tx.unsafe(`GRANT REFERENCES (site_id) ON lumibase_deleted_site_ids TO ${PROBE}`);
      await ensureAppRole(tx, { role: PROBE, password: 'probe' });
      // No column-level entry of the probe is left on either table (REFERENCES included).
      const columnAcl = await tx`
        SELECT a.attrelid::regclass::text AS t, a.attname
          FROM pg_attribute a, aclexplode(a.attacl) x
         WHERE a.attrelid IN ('lumibase_deleted_site_ids'::regclass, 'lumibase_site_id_reuse_exemption'::regclass)
           AND x.grantee = ${PROBE}::regrole`;
      expect(columnAcl).toEqual([]);
      expect(await exemption()).toEqual([]);
      expect(await writes('lumibase_site_id_reuse_exemption')).toEqual({ ins: false, del: false, upd: false, trunc: false, cols: false });
      expect(await writes('lumibase_deleted_site_ids')).toEqual({ ins: false, del: false, upd: false, trunc: false, cols: false });
    });
  });

  it('HeoPress P07: the hold tables\' write guard recognises an owner whose name needs quoting', async () => {
    await inRollback(async (tx) => {
      await tx.unsafe(`CREATE ROLE "Hold Owner Probe"`);
      await tx.unsafe(`GRANT "Hold Owner Probe" TO CURRENT_USER`);
      await tx.unsafe(`CREATE TABLE heopress_hold_guard_probe (id int)`);
      await tx.unsafe(`ALTER TABLE heopress_hold_guard_probe OWNER TO "Hold Owner Probe"`);
      await tx.unsafe(`CREATE TRIGGER guard BEFORE INSERT ON heopress_hold_guard_probe FOR EACH ROW EXECUTE FUNCTION public.heopress_hold_tables_owner_only()`);
      // Not its owner: refused.
      await expect(tx`INSERT INTO heopress_hold_guard_probe VALUES (1)`).rejects.toMatchObject({ code: '42501' });
    });
    await inRollback(async (tx) => {
      await tx.unsafe(`CREATE ROLE "Hold Owner Probe"`);
      await tx.unsafe(`GRANT "Hold Owner Probe" TO CURRENT_USER`);
      await tx.unsafe(`CREATE TABLE heopress_hold_guard_probe (id int)`);
      await tx.unsafe(`ALTER TABLE heopress_hold_guard_probe OWNER TO "Hold Owner Probe"`);
      await tx.unsafe(`CREATE TRIGGER guard BEFORE INSERT ON heopress_hold_guard_probe FOR EACH ROW EXECUTE FUNCTION public.heopress_hold_tables_owner_only()`);
      // Its owner: allowed.
      await tx.unsafe(`SET LOCAL ROLE "Hold Owner Probe"`);
      await tx`INSERT INTO heopress_hold_guard_probe VALUES (1)`;
      expect(await tx`SELECT id FROM heopress_hold_guard_probe`).toHaveLength(1);
    });
  });

  /** A statement that must fail, inside the transaction: a savepoint keeps the transaction usable. */
  async function refused(tx: postgres.TransactionSql, statement: string): Promise<string | undefined> {
    try {
      await tx.savepoint((sp) => sp.unsafe(statement));
    } catch (err) {
      return (err as { code?: string }).code;
    }
    return undefined;
  }

  it('HeoPress P14 (ADR-0024): CREATE nowhere — after provisioning takes back an earlier grant, a function in public and a table in the queue schema are refused', async () => {
    await inRollback(async (tx) => {
      await ensureAppRole(tx, { role: PROBE, password: 'probe' });
      // What an earlier version granted.
      await tx.unsafe(`GRANT CREATE ON SCHEMA public, pgboss TO ${PROBE}`);
      await tx.unsafe(`DO $$ BEGIN EXECUTE format('GRANT CREATE ON DATABASE %I TO ${PROBE}', current_database()); END $$`);
      await ensureAppRole(tx, { role: PROBE, password: 'probe' });
      const [p] = await tx<{ pub: boolean; boss: boolean; usage: boolean; db: boolean }[]>`
        SELECT has_schema_privilege(${PROBE}, 'public', 'CREATE') AS pub, has_schema_privilege(${PROBE}, 'pgboss', 'CREATE') AS boss,
               has_schema_privilege(${PROBE}, 'pgboss', 'USAGE') AS usage, has_database_privilege(${PROBE}, current_database(), 'CREATE') AS db`;
      expect(p).toEqual({ pub: false, boss: false, usage: true, db: false });
      await tx.unsafe(`SET LOCAL ROLE ${PROBE}`);
      expect(await refused(tx, `CREATE FUNCTION public.heopress_role_probe_f() RETURNS int LANGUAGE sql AS 'SELECT 1'`)).toBe('42501');
      expect(await refused(tx, `CREATE TABLE pgboss.heopress_role_probe_t (id int)`)).toBe('42501');
      expect(await refused(tx, `CREATE SCHEMA heopress_role_probe_s`)).toBe('42501');
      // Rows, as before.
      expect(await tx`SELECT count(*)::int AS n FROM pgboss.queue`).toHaveLength(1);
    });
  });

  it('HeoPress P14 (ADR-0024): takes back the runtime tables the role created — data and indexes unchanged, the owner\'s, one site per scope; the role still reads and writes its rows', async () => {
    const [me] = await owner<{ u: string }[]>`SELECT current_user AS u`;
    await inRollback(async (tx) => {
      await ensureAppRole(tx, { role: PROBE, password: 'probe' });
      await tx`INSERT INTO lumibase_sites (id, name) VALUES ('p14-reclaim-a', 'A'), ('p14-reclaim-b', 'B')`;
      await tx`INSERT INTO lumibase_vector_spaces (id, model, dimension, column_type, table_name) VALUES ('probe_p14', 'probe-model', 3, 'vector', 'lumibase_vectors_probe_p14')`;
      await tx`INSERT INTO lumibase_materialized_collections (id, site_id, collection, target) VALUES ('Probe_P14', 'p14-reclaim-a', 'articles', 'probe_p14')`;
      // What a runtime before P14 did: create them as the role (an earlier version granted CREATE), with a policy of its own.
      await tx.unsafe(`GRANT CREATE ON SCHEMA public TO ${PROBE}`);
      await tx.unsafe(`SET LOCAL ROLE ${PROBE}`);
      await tx`CREATE TABLE lumibase_vectors_probe_p14 (site_id text NOT NULL, source_id text NOT NULL, note text, PRIMARY KEY (site_id, source_id))`;
      await tx`CREATE INDEX lumibase_vectors_probe_p14_note ON lumibase_vectors_probe_p14 (note)`;
      await tx`INSERT INTO lumibase_vectors_probe_p14 VALUES ('p14-reclaim-a', 'x', 'a'), ('p14-reclaim-b', 'y', 'b')`;
      await tx`CREATE TABLE mat_probe_p14 (id text PRIMARY KEY, site_id text NOT NULL, data jsonb)`;
      await tx`INSERT INTO mat_probe_p14 VALUES ('i1', 'p14-reclaim-a', '{}')`;
      await tx`ALTER TABLE mat_probe_p14 ENABLE ROW LEVEL SECURITY`;
      await tx`CREATE POLICY see_all ON mat_probe_p14 USING (true)`;
      await tx`RESET ROLE`;
      const state = async () => ({
        indexes: await tx`SELECT indexname, indexdef FROM pg_indexes WHERE tablename IN ('lumibase_vectors_probe_p14', 'mat_probe_p14') ORDER BY 1`,
        vectors: await tx`SELECT * FROM lumibase_vectors_probe_p14 ORDER BY site_id`,
        mat: await tx`SELECT * FROM mat_probe_p14 ORDER BY id`,
      });
      const before = await state();

      const { reclaimed } = await ensureAppRole(tx, { role: PROBE, password: 'probe' });
      expect(reclaimed).toEqual(['lumibase_vectors_probe_p14', 'mat_probe_p14']);
      expect(await state()).toEqual(before);
      const tables = await tx<{ relname: string; owner: string; rls: boolean; force: boolean; policies: string[] }[]>`
        SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
               ARRAY(SELECT policyname::text FROM pg_policies p WHERE p.tablename = c.relname ORDER BY 1) AS policies
          FROM pg_class c WHERE c.relname IN ('lumibase_vectors_probe_p14', 'lumibase_vectors_probe_p14_note', 'mat_probe_p14') ORDER BY 1`;
      expect(tables).toEqual([
        { relname: 'lumibase_vectors_probe_p14', owner: me!.u, rls: true, force: false, policies: ['site_isolation'] },
        { relname: 'lumibase_vectors_probe_p14_note', owner: me!.u, rls: false, force: false, policies: [] },
        { relname: 'mat_probe_p14', owner: me!.u, rls: true, force: false, policies: ['site_isolation'] },
      ]);
      // The role: its site's rows, read and written; no other site's; nothing without a scope.
      await tx.unsafe(`SET LOCAL ROLE ${PROBE}`);
      await tx`SELECT set_config('app.site_id', 'p14-reclaim-a', true)`;
      expect(await tx`SELECT source_id FROM lumibase_vectors_probe_p14`).toEqual([{ source_id: 'x' }]);
      await tx`INSERT INTO lumibase_vectors_probe_p14 VALUES ('p14-reclaim-a', 'z', 'a2')`;
      expect(await refused(tx, `INSERT INTO lumibase_vectors_probe_p14 VALUES ('p14-reclaim-b', 'w', 'b2')`)).toBe('42501');
      expect(await tx`SELECT id FROM mat_probe_p14`).toEqual([{ id: 'i1' }]);
      expect(await refused(tx, `TRUNCATE mat_probe_p14`)).toBe('42501');
      expect(await refused(tx, `DROP TABLE mat_probe_p14`)).toBe('42501');
      await tx`SELECT set_config('app.site_id', '', true)`;
      expect(await refused(tx, `SELECT count(*) FROM lumibase_vectors_probe_p14`)).toBe('42501');
      await tx`RESET ROLE`;
      // A second run has nothing left to take back, and changes nothing.
      expect((await ensureAppRole(tx, { role: PROBE, password: 'probe' })).reclaimed).toEqual([]);
    });
  });

  it('HeoPress P14 (ADR-0024): any other object the role owns stops provisioning and is listed — a function, an unregistered table, a trigger', async () => {
    await inRollback(async (tx) => {
      await ensureAppRole(tx, { role: PROBE, password: 'probe' });
      await tx`INSERT INTO lumibase_vector_spaces (id, model, dimension, column_type, table_name) VALUES ('probe_p14t', 'probe-model', 4, 'vector', 'lumibase_vectors_probe_p14t')`;
      await tx.unsafe(`GRANT CREATE ON SCHEMA public TO ${PROBE}`);
      await tx.unsafe(`SET LOCAL ROLE ${PROBE}`);
      await tx`CREATE FUNCTION public.heopress_role_probe_f() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RETURN NEW; END'`;
      await tx`CREATE TABLE heopress_role_probe_unnamed (site_id text)`;
      // A registered vector table, but with a trigger: not taken back.
      await tx`CREATE TABLE lumibase_vectors_probe_p14t (site_id text NOT NULL)`;
      await tx`CREATE TRIGGER probe_trg BEFORE INSERT ON lumibase_vectors_probe_p14t FOR EACH ROW EXECUTE FUNCTION public.heopress_role_probe_f()`;
      await tx`RESET ROLE`;
      const err = await ensureAppRole(tx, { role: PROBE, password: 'probe' }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(AppRoleOwnsObjectsError);
      expect((err as AppRoleOwnsObjectsError).objects).toEqual([
        'function heopress_role_probe_f()',
        'table heopress_role_probe_unnamed',
        'table lumibase_vectors_probe_p14t',
        'trigger probe_trg on lumibase_vectors_probe_p14t',
      ]);
      // Refused before any privilege was granted again: CREATE stays revoked.
      const [p] = await tx<{ pub: boolean }[]>`SELECT has_schema_privilege(${PROBE}, 'public', 'CREATE') AS pub`;
      expect(p!.pub).toBe(false);
    });
  });

  it('HeoPress P14 (ADR-0024): the app-role command exits non-zero and lists a function the role owns', async () => {
    const role = 'heopress_role_probe_cli';
    const cleanup = async () => {
      await owner.unsafe(`DROP FUNCTION IF EXISTS public.heopress_role_probe_cli_f()`);
      const [r] = await owner`SELECT 1 FROM pg_roles WHERE rolname = ${role}`;
      if (r) {
        await owner.unsafe(`DROP OWNED BY ${role}`);
        await owner.unsafe(`DROP ROLE ${role}`);
      }
    };
    await cleanup();
    try {
      await owner.unsafe(`CREATE ROLE ${role} NOLOGIN`);
      await owner.unsafe(`GRANT ${role} TO CURRENT_USER`);
      await owner.unsafe(`GRANT CREATE ON SCHEMA public TO ${role}`);
      await owner.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await tx.unsafe(`CREATE FUNCTION public.heopress_role_probe_cli_f() RETURNS int LANGUAGE sql AS 'SELECT 1'`);
      });
      const pkg = path.resolve(__dirname, '../..');
      const run = spawnSync(path.join(pkg, 'node_modules/.bin/tsx'), ['scripts/app-role.ts', '--test-database'], {
        cwd: pkg,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: OWNER_URL, HEOPRESS_APP_ROLE: role, HEOPRESS_APP_PASSWORD: 'probe' },
        timeout: 60_000,
      });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain(`${role} owns objects the runtime never creates`);
      expect(run.stderr).toContain('function heopress_role_probe_cli_f()');
      expect(run.stdout).not.toContain('ready');
    } finally {
      await cleanup();
    }
  });

  it('HeoPress P14: a second run gives the same privileges as the first', async () => {
    await inRollback(async (tx) => {
      const snapshot = async () => ({
        schemas: await tx`SELECT nspname, nspacl::text FROM pg_namespace WHERE nspname IN ('public', 'pgboss', 'drizzle') ORDER BY 1`,
        tables: await tx`SELECT relname, relacl::text FROM pg_class WHERE relname IN ('lumibase_items', 'lumibase_sites', 'lumibase_deleted_site_ids') ORDER BY 1`,
        defaults: await tx`SELECT defaclobjtype, defaclacl::text FROM pg_default_acl ORDER BY 1, 2`,
        role: await tx`SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = ${PROBE}`,
      });
      await ensureAppRole(tx, { role: PROBE, password: 'probe' });
      const once = await snapshot();
      expect((await ensureAppRole(tx, { role: PROBE, password: 'probe' })).reclaimed).toEqual([]);
      expect(await snapshot()).toEqual(once);
    });
  });

  it('HeoPress P13 (S-5): the live probe sees one site of two as the role; the bypass reason names a superuser', async () => {
    const [me] = await owner<{ superuser: boolean }[]>`SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`;
    await inRollback(async (tx) => {
      expect(await rlsBypassReason(tx)).toMatchObject({ reason: me!.superuser ? 'superuser' : 'owns the application tables' });
      // The owner's own probe table: a superuser sees both rows; a non-superuser owner is held by FORCE.
      expect(await probeRls(tx)).toBe(me!.superuser ? 2 : 1);
      await ensureAppRole(tx, { role: PROBE, password: 'probe' });
      await tx.unsafe(`SET LOCAL ROLE ${PROBE}`);
      expect(await rlsBypassReason(tx)).toEqual({ role: PROBE, reason: null });
      expect(await probeRls(tx)).toBe(1);
    });
  });

  it('refuses an existing role that is a member of another role', async () => {
    await inRollback(async (tx) => {
      await tx.unsafe(`CREATE ROLE ${PROBE} LOGIN`);
      await tx.unsafe(`GRANT pg_read_all_data TO ${PROBE}`);
      await expect(ensureAppRole(tx, { role: PROBE, password: 'probe' })).rejects.toThrow(/is a member of pg_read_all_data/);
    });
  });

  it('refuses an existing role that owns a row-level-secured table (P14: any object it owns)', async () => {
    await inRollback(async (tx) => {
      await tx.unsafe(`CREATE ROLE ${PROBE} LOGIN`);
      await tx`CREATE TABLE heopress_role_probe_rls (id int)`;
      await tx`ALTER TABLE heopress_role_probe_rls ENABLE ROW LEVEL SECURITY`;
      await tx.unsafe(`ALTER TABLE heopress_role_probe_rls OWNER TO ${PROBE}`);
      await expect(ensureAppRole(tx, { role: PROBE, password: 'probe' })).rejects.toThrow(/owns 1 object\(s\).*table heopress_role_probe_rls/);
    });
  });

  it('the RLS guard refuses a role that can SET ROLE to one that bypasses RLS', async () => {
    const [me] = await owner<{ superuser: boolean }[]>`SELECT rolsuper AS superuser FROM pg_roles WHERE rolname = current_user`;
    await inRollback(async (tx) => {
      await ensureAppRole(tx, { role: PROBE, password: 'probe' });
      await tx.unsafe(`SET LOCAL ROLE ${PROBE}`);
      await expect(assertRlsApplies(tx)).resolves.toBeUndefined();
      await tx`RESET ROLE`;
      if (!me!.superuser) return; // creating a BYPASSRLS role needs a superuser
      await tx.unsafe(`CREATE ROLE ${PROBE}_bypass NOLOGIN BYPASSRLS`);
      await tx.unsafe(`GRANT ${PROBE}_bypass TO ${PROBE}`);
      await tx.unsafe(`SET LOCAL ROLE ${PROBE}`);
      await expect(assertRlsApplies(tx)).rejects.toThrow(/can SET ROLE to heopress_role_probe_bypass/);
    });
  });
});
