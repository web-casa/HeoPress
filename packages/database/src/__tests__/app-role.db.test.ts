import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertRlsApplies, ensureAppRole } from '../app-role';

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

  it('keeps the role’s own tables fully usable', async () => {
    await inRollback(async (tx) => {
      await ensureAppRole(tx, { role: PROBE, password: 'probe' });
      await tx.unsafe(`SET LOCAL ROLE ${PROBE}`);
      await tx`CREATE TABLE heopress_role_probe_own (id int)`;
      await tx`RESET ROLE`;
      await ensureAppRole(tx, { role: PROBE, password: 'probe' });
      expect(await privileges(tx, 'heopress_role_probe_own')).toEqual({ sel: true, trunc: true, trig: true });
    });
  });

  it('refuses an existing role that is a member of another role', async () => {
    await inRollback(async (tx) => {
      await tx.unsafe(`CREATE ROLE ${PROBE} LOGIN`);
      await tx.unsafe(`GRANT pg_read_all_data TO ${PROBE}`);
      await expect(ensureAppRole(tx, { role: PROBE, password: 'probe' })).rejects.toThrow(/is a member of pg_read_all_data/);
    });
  });

  it('refuses an existing role that owns a row-level-secured table', async () => {
    await inRollback(async (tx) => {
      await tx.unsafe(`CREATE ROLE ${PROBE} LOGIN`);
      await tx`CREATE TABLE heopress_role_probe_rls (id int)`;
      await tx`ALTER TABLE heopress_role_probe_rls ENABLE ROW LEVEL SECURITY`;
      await tx.unsafe(`ALTER TABLE heopress_role_probe_rls OWNER TO ${PROBE}`);
      await expect(ensureAppRole(tx, { role: PROBE, password: 'probe' })).rejects.toThrow(/owns heopress_role_probe_rls/);
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
