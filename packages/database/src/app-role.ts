import { scramVerifier } from './scram';
import { policiesFor } from './rls/policies';
import { RLS_REGISTRY } from './rls/registry';
/**
 * The application database role (HeoPress P03 task 7.1; docs/known-issues.md
 * "数据库测试以超级用户运行").
 *
 * Migrations run as the role that owns the tables. The application — and the
 * database test suites — connect as a separate role that is neither a
 * superuser nor `BYPASSRLS`, so row-level security applies to it exactly as
 * it would in production. The role gets:
 *
 *   - row access (SELECT/INSERT/UPDATE/DELETE, REFERENCES) on every table and
 *     sequence in `public` and the queue schema, now and — through default
 *     privileges of the owner — for tables later migrations create. Not
 *     TRUNCATE: row-level security does not apply to it, so it would empty
 *     every site's rows at once. Not TRIGGER: a trigger the role attached to
 *     an owner table would run with the owner's privileges the next time
 *     maintenance writes to that table;
 *   - USAGE on those schemas and nothing more (HeoPress P14, ADR-0024): the
 *     runtime creates no database object. The tables it needs at run time — a
 *     vector space per embedding model, a materialized collection's physical
 *     table — are created by the owner's `SECURITY DEFINER` entries (migration
 *     0123), on which it gets EXECUTE with every other function of `public`;
 *   - read-only access to the migration history (`drizzle` schema), which
 *     readiness checks;
 *   - nothing else: no superuser, no BYPASSRLS, no CREATEDB / CREATEROLE, and
 *     membership in no other role. An existing role that is a member of
 *     another role is refused: it could `SET ROLE` around the policies.
 *
 * `testDatabase` adds TRUNCATE for the database test suites, which reset
 * tables between files, and lifts the hold on deleted site ids in this
 * database (their fixtures reuse ids). Never use it for a deployment.
 *
 * The owner is made a member of the role so that maintenance (and the RLS
 * test) can `SET ROLE` to it, and so that it can take back what the role owns.
 * Idempotent.
 *
 * A deployment from before P14 let the role create the runtime's tables, so
 * it owns them: those named by the registries (vector spaces, materialized
 * collections) are handed to the owner, with row-level security
 * (`reclaimed`). Any other object the role owns — a function, an operator, a
 * type, a table nothing names, a trigger on a reclaimed table — is not
 * something the runtime makes: provisioning stops and lists it
 * (`AppRoleOwnsObjectsError`) for an operator to review. A role that owns
 * objects is never left with privileges a fresh role would not get.
 */
export interface AppRoleSql {
  unsafe(query: string, params?: unknown[]): PromiseLike<unknown>;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * The search path of the owner's maintenance connections (migrate, app-role; HeoPress P14 D2): `public` only.
 * `pg_catalog`, not named, is searched before it, so no object in `public` shadows a built-in function or operator,
 * and no `"$user"` schema comes first; unqualified CREATE still goes to `public`.
 */
export const MAINTENANCE_SEARCH_PATH = 'public';

/** The application role owns objects provisioning does not recognise; `objects` describes each one. */
export class AppRoleOwnsObjectsError extends Error {
  constructor(
    readonly role: string,
    readonly objects: string[],
  ) {
    super(
      `role ${role} owns ${objects.length} object(s) the runtime never creates: ${objects.join('; ')}. ` +
        'Review them, then drop them or hand them to the owner (ALTER … OWNER TO), and run app-role again.',
    );
    this.name = 'AppRoleOwnsObjectsError';
  }
}

export async function ensureAppRole(
  sql: AppRoleSql,
  opts: { role: string; password: string; schemas?: string[]; testDatabase?: boolean },
): Promise<{ reclaimed: string[] }> {
  if (!IDENT.test(opts.role)) throw new Error(`invalid role name ${JSON.stringify(opts.role)}`);
  const schemas = opts.schemas ?? ['public', 'pgboss'];
  for (const s of schemas) if (!IDENT.test(s)) throw new Error(`invalid schema name ${JSON.stringify(s)}`);
  const role = `"${opts.role}"`;
  // A verifier, not the password: the plaintext never reaches the server or its logs.
  const password = `'${scramVerifier(opts.password)}'`;

  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${opts.role}') THEN
        CREATE ROLE ${role} LOGIN;
      END IF;
    END $$`);
  await refuseMembership(sql, opts.role);
  await sql.unsafe(`ALTER ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${password}`);
  await sql.unsafe(`DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${role}', current_database()); END $$`);
  await sql.unsafe(`GRANT ${role} TO CURRENT_USER`);
  const present: string[] = [];
  for (const schema of schemas) {
    const exists = (await sql.unsafe(`SELECT 1 FROM pg_namespace WHERE nspname = '${schema}'`)) as unknown[];
    if (exists.length === 0) continue;
    present.push(schema);
    // First of all: an earlier version granted CREATE (ADR-0024).
    await sql.unsafe(`REVOKE CREATE ON SCHEMA ${schema} FROM ${role}`);
    await sql.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  }
  // CREATE on the database would let it create a schema; on `public`, a database created before PostgreSQL 15 grants
  // it to PUBLIC (the rendering role revokes that too).
  await sql.unsafe(`DO $$ BEGIN EXECUTE format('REVOKE CREATE ON DATABASE %I FROM ${role}', current_database()); END $$`);
  if (present.includes('public')) await sql.unsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  await refuseCreate(sql, opts.role);
  const reclaimed = await reclaimRuntimeObjects(sql, opts.role);
  await refuseOwnership(sql, opts.role);

  const tablePrivileges = `SELECT, INSERT, UPDATE, DELETE, REFERENCES${opts.testDatabase ? ', TRUNCATE' : ''}`;
  for (const schema of present) {
    // Revoke first: an earlier version of this function granted more.
    await sql.unsafe(`
      DO $$ DECLARE t text; BEGIN
        FOR t IN SELECT format('%I.%I', n.nspname, c.relname) FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = '${schema}' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') LOOP
          EXECUTE format('REVOKE TRUNCATE, TRIGGER ON %s FROM ${role}', t);
        END LOOP;
      END $$`);
    await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} REVOKE TRUNCATE, TRIGGER ON TABLES FROM ${role}`);
    await sql.unsafe(`GRANT ${tablePrivileges} ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
    await sql.unsafe(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
    await sql.unsafe(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${role}`);
    await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ${tablePrivileges} ON TABLES TO ${role}`);
    await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${role}`);
    await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT EXECUTE ON FUNCTIONS TO ${role}`);
  }
  const history = (await sql.unsafe(`SELECT 1 FROM pg_namespace WHERE nspname = 'drizzle'`)) as unknown[];
  if (history.length > 0) {
    await sql.unsafe(`GRANT USAGE ON SCHEMA drizzle TO ${role}`);
    await sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA drizzle TO ${role}`);
  }
  // The hold on deleted site ids (migrations 0042, 0044): its records and its exemption are the owner's, written
  // only by owner-run triggers and by this function — never by the application role, whatever the grants above.
  // Likewise the maintenance switch (migration 0120, P13 upgrade): only the upgrade command, as the owner, sets it.
  const holdTables = (await sql.unsafe(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN ('lumibase_deleted_site_ids', 'lumibase_site_id_reuse_exemption', 'lumibase_maintenance')`,
  )) as unknown as Array<{ relname: string }>;
  for (const t of holdTables) {
    await sql.unsafe(`REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.${t.relname} FROM ${role}`);
    // A table-level REVOKE leaves column grants in place: those too.
    await sql.unsafe(`
      DO $$ DECLARE cols text; BEGIN
        SELECT string_agg(quote_ident(attname), ', ') INTO cols FROM pg_attribute
         WHERE attrelid = 'public.${t.relname}'::regclass AND attnum > 0 AND NOT attisdropped;
        EXECUTE format('REVOKE INSERT (%s), UPDATE (%s), REFERENCES (%s) ON public.${t.relname} FROM ${role}', cols, cols, cols);
      END $$`);
  }
  // An earlier version exempted test databases through a role setting: gone.
  for (const who of [role, 'CURRENT_USER']) {
    await sql.unsafe(`DO $$ BEGIN EXECUTE format('ALTER ROLE ${who} IN DATABASE %I RESET heopress.site_id_reuse', current_database()); END $$`);
  }
  if (holdTables.some((t) => t.relname === 'lumibase_site_id_reuse_exemption')) {
    // The test suites' fixtures delete and recreate the same site ids: in a test database the hold does not
    // apply, except to ids starting with "held-" (the tests of the hold). Any other run removes the exemption.
    await sql.unsafe(
      opts.testDatabase
        ? `INSERT INTO public.lumibase_site_id_reuse_exemption (singleton, except_prefix) VALUES (true, 'held-') ON CONFLICT (singleton) DO UPDATE SET except_prefix = EXCLUDED.except_prefix`
        : `DELETE FROM public.lumibase_site_id_reuse_exemption`,
    );
  }
  return { reclaimed };
}

/**
 * The runtime's tables that the role created before P14: the vector spaces (`lumibase_vector_spaces.table_name`) and
 * the materialized collections' physical tables (`mat_<id>`, `materialize-service.ts` `sanitizeTableName`). Each is
 * handed to the owner running this — its indexes and owned sequences with it, its rows untouched — and gets the
 * policies every table of the entries gets: row-level security, one site policy, nothing else (a policy the role
 * wrote is dropped). Only plain tables in `public`, named by those registries, with a `site_id` column and no
 * trigger or rule; anything else the role owns is left for `refuseOwnership` to list.
 */
async function reclaimRuntimeObjects(sql: AppRoleSql, roleName: string): Promise<string[]> {
  const registries = (await sql.unsafe(
    `SELECT to_regclass('public.lumibase_vector_spaces') IS NOT NULL AS vectors,
            to_regclass('public.lumibase_materialized_collections') IS NOT NULL AS materialized`,
  )) as Array<{ vectors: boolean; materialized: boolean }>;
  const names: string[] = [];
  if (registries[0]?.vectors) {
    const rows = (await sql.unsafe(`SELECT table_name AS name FROM public.lumibase_vector_spaces`)) as Array<{ name: string }>;
    names.push(...rows.map((r) => r.name));
  }
  if (registries[0]?.materialized) {
    const rows = (await sql.unsafe(
      `SELECT 'mat_' || left(regexp_replace(lower(id), '[^a-z0-9_]', '', 'g'), 59) AS name FROM public.lumibase_materialized_collections`,
    )) as Array<{ name: string }>;
    names.push(...rows.map((r) => r.name));
  }
  const candidates = [...new Set(names.filter((n) => IDENT.test(n)))];
  if (candidates.length === 0) return [];
  const owned = (await sql.unsafe(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $2)
        AND c.relname = ANY($1::text[])
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'site_id' AND NOT a.attisdropped)
        AND NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND NOT t.tgisinternal)
        AND NOT EXISTS (SELECT 1 FROM pg_rewrite w WHERE w.ev_class = c.oid)
      ORDER BY 1`,
    [candidates, roleName],
  )) as Array<{ relname: string }>;
  for (const { relname } of owned) {
    const t = `public."${relname}"`;
    await sql.unsafe(`ALTER TABLE ${t} OWNER TO CURRENT_USER`);
    await sql.unsafe(`
      DO $$ DECLARE p text; BEGIN
        FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = '${relname}' LOOP
          EXECUTE format('DROP POLICY %I ON ${t}', p);
        END LOOP;
      END $$`);
    await sql.unsafe(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY`);
    await sql.unsafe(
      `CREATE POLICY site_isolation ON ${t} FOR ALL USING (site_id = public.app_site_id()) WITH CHECK (site_id = public.app_site_id())`,
    );
  }
  return owned.map((t) => t.relname);
}

/**
 * An existing role must not be a way around row-level security: no membership in another role (it could `SET ROLE`
 * to an owner or a BYPASSRLS role).
 */
async function refuseMembership(sql: AppRoleSql, roleName: string): Promise<void> {
  const memberOf = (await sql.unsafe(
    `SELECT g.rolname FROM pg_auth_members m
       JOIN pg_roles r ON r.oid = m.member JOIN pg_roles g ON g.oid = m.roleid
      WHERE r.rolname = $1 ORDER BY 1`,
    [roleName],
  )) as Array<{ rolname: string }>;
  if (memberOf.length > 0) {
    throw new Error(
      `role ${roleName} is a member of ${memberOf.map((r) => r.rolname).join(', ')}; ` +
        'the application role must not be able to SET ROLE to another role. Revoke the membership or use a new role.',
    );
  }
}

/**
 * CREATE nowhere in this database, whoever granted it: on no schema, and not on the database (a new schema). A grant
 * that remains (to PUBLIC, by a schema owner other than the one running this) is refused with the statement to run.
 */
async function refuseCreate(sql: AppRoleSql, roleName: string): Promise<void> {
  const rows = (await sql.unsafe(
    `SELECT 'schema ' || quote_ident(nspname) AS what FROM pg_namespace
      WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
        AND has_schema_privilege($1, oid, 'CREATE')
      UNION ALL
     SELECT 'database ' || quote_ident(current_database()) WHERE has_database_privilege($1, current_database(), 'CREATE')
      ORDER BY 1`,
    [roleName],
  )) as Array<{ what: string }>;
  if (rows.length > 0) {
    const list = rows.map((r) => r.what).join(', ');
    throw new Error(
      `role ${roleName} can create objects in ${list} (through PUBLIC or another grant); the runtime creates none. ` +
        `As the owner of each, REVOKE CREATE ON ${list} FROM PUBLIC (and from ${roleName}), then run app-role again.`,
    );
  }
}

/**
 * The role owns nothing (ADR-0024; the rendering role is held to the same): an owner bypasses row-level security on
 * its tables, and maintenance resolving a name to the role's function or operator would run the role's code with the
 * owner's privileges. Everything the role owns in this database or among the shared objects, after
 * `reclaimRuntimeObjects`, is listed and refused.
 */
async function refuseOwnership(sql: AppRoleSql, roleName: string): Promise<void> {
  const rows = (await sql.unsafe(
    `SELECT CASE WHEN d.dbid = 0 THEN 'shared ' ELSE '' END || pg_describe_object(d.classid, d.objid, d.objsubid) AS what
       FROM pg_shdepend d
      WHERE d.refclassid = 'pg_authid'::regclass AND d.refobjid = (SELECT oid FROM pg_roles WHERE rolname = $1)
        AND d.deptype = 'o' AND d.dbid IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
      UNION ALL
     SELECT format('trigger %I on %s', t.tgname, t.tgrelid::regclass)
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)
      ORDER BY 1`,
    [roleName],
  )) as Array<{ what: string }>;
  if (rows.length > 0) throw new AppRoleOwnsObjectsError(roleName, rows.map((r) => r.what));
}

/**
 * Why row-level security does not apply to the current role, or null when it does: a superuser or `BYPASSRLS` role
 * sees every row, so does a role that owns the tables (or inherits from their owner); a role that can `SET ROLE` to
 * one of those is no better.
 */
export async function rlsBypassReason(sql: { unsafe(q: string): PromiseLike<unknown> }): Promise<{ role: string; reason: string | null }> {
  const rows = (await sql.unsafe(
    `SELECT current_user AS role, r.rolsuper, r.rolbypassrls,
            (SELECT string_agg(o.rolname, ', ' ORDER BY o.rolname) FROM pg_roles o
              WHERE o.oid <> r.oid AND (o.rolsuper OR o.rolbypassrls)
                AND pg_has_role(current_user, o.oid, 'MEMBER')) AS escalates_to,
            (SELECT pg_has_role(current_user, c.relowner, 'USAGE') FROM pg_class c
              WHERE c.oid = to_regclass('lumibase_items')) AS owns_tables
       FROM pg_roles r WHERE r.rolname = current_user`,
  )) as Array<{ role: string; rolsuper: boolean; rolbypassrls: boolean; escalates_to: string | null; owns_tables: boolean | null }>;
  const r = rows[0];
  const reason = !r
    ? 'unknown role'
    : r.rolsuper
      ? 'superuser'
      : r.rolbypassrls
        ? 'BYPASSRLS'
        : r.escalates_to
          ? `can SET ROLE to ${r.escalates_to}`
          : r.owns_tables
            ? 'owns the application tables'
            : null;
  return { role: r?.role ?? 'an unknown role', reason };
}

/**
 * Refuse to run a row-level security test on a role that bypasses RLS (`rlsBypassReason`): the test would pass
 * whatever the policies say.
 */
export async function assertRlsApplies(sql: { unsafe(q: string): PromiseLike<unknown> }): Promise<void> {
  const { role, reason } = await rlsBypassReason(sql);
  if (reason) {
    throw new Error(
      `row-level security tests must not run as ${role} (${reason}): RLS does not apply to it. ` +
        'Use the application role (pnpm --filter @heopress/database app-role).',
    );
  }
}

/**
 * Row-level security, observed on this connection (HeoPress P13, security review S-5): a temporary table with
 * forced RLS and a per-site read policy, two rows of two sites, read under one site. Returns how many rows the
 * connection sees: 1 when RLS applies to it, 2 when it bypasses RLS (a superuser or `BYPASSRLS` role). Run inside a
 * transaction (the table is dropped on commit); needs the TEMP privilege on the database.
 */
export async function probeRls(tx: { unsafe(q: string): PromiseLike<unknown> }): Promise<number> {
  await tx.unsafe(`CREATE TEMP TABLE heopress_rls_probe (site_id text NOT NULL) ON COMMIT DROP`);
  await tx.unsafe(`ALTER TABLE heopress_rls_probe ENABLE ROW LEVEL SECURITY`);
  await tx.unsafe(`ALTER TABLE heopress_rls_probe FORCE ROW LEVEL SECURITY`);
  await tx.unsafe(`CREATE POLICY heopress_rls_probe_read ON heopress_rls_probe FOR SELECT USING (site_id = current_setting('app.site_id', true))`);
  await tx.unsafe(`CREATE POLICY heopress_rls_probe_write ON heopress_rls_probe FOR INSERT WITH CHECK (true)`);
  await tx.unsafe(`INSERT INTO heopress_rls_probe (site_id) VALUES ('probe-a'), ('probe-b')`);
  await tx.unsafe(`SELECT set_config('app.site_id', 'probe-a', true)`);
  const rows = (await tx.unsafe(`SELECT count(*)::int AS n FROM heopress_rls_probe`)) as Array<{ n: number }>;
  await tx.unsafe(`DROP TABLE heopress_rls_probe`);
  return rows[0]?.n ?? 0;
}

/**
 * What `app-role --check` verifies about the policies themselves (HeoPress P14 task 1.7): the migrated database has
 * the registry's policies, a read outside any site scope is an error rather than an empty result, and the application
 * role can create nothing and owns nothing. The role and the live probe are checked by the caller.
 */
export interface RlsInstallationReport {
  role: string;
  problems: string[];
}

interface CheckSql {
  unsafe(q: string, params?: unknown[]): PromiseLike<unknown>;
}

export async function checkRlsInstallation(sql: CheckSql): Promise<RlsInstallationReport> {
  const problems: string[] = [];
  const [me] = (await sql.unsafe(`SELECT current_user AS role`)) as Array<{ role: string }>;
  const role = me?.role ?? 'unknown';

  const flags = (await sql.unsafe(
    `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  )) as Array<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>;
  const byName = new Map(flags.map((f) => [f.relname, f]));
  const policyRows = (await sql.unsafe(
    `SELECT tablename, policyname, cmd FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`,
  )) as Array<{ tablename: string; policyname: string; cmd: string }>;
  const policiesByTable = new Map<string, Array<{ policyname: string; cmd: string }>>();
  for (const p of policyRows) {
    const list = policiesByTable.get(p.tablename) ?? [];
    list.push({ policyname: p.policyname, cmd: p.cmd });
    policiesByTable.set(p.tablename, list);
  }
  for (const entry of RLS_REGISTRY) {
    const row = byName.get(entry.table);
    const enabled = entry.policy !== 'exempt';
    if (!row) {
      problems.push(`${entry.table}: missing from the database (run the migrations)`);
      continue;
    }
    if (row.relrowsecurity !== enabled) problems.push(`${entry.table}: row-level security is ${row.relrowsecurity ? 'on' : 'off'}, expected ${enabled ? 'on' : 'off'}`);
    if (row.relforcerowsecurity) problems.push(`${entry.table}: FORCE row-level security is set (the owner would be bound)`);
    const actual = (policiesByTable.get(entry.table) ?? []).map((p) => `${p.policyname}:${p.cmd}`).sort();
    const expected = policiesFor(entry).map((p) => `${p.name}:${p.command}`).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${entry.table}: policies ${actual.join(', ') || 'none'}, expected ${expected.join(', ') || 'none'}`);
    }
  }

  // A read with no site scope must be an error, not an empty result (the strict app_site_id()). The probe runs in a
  // subtransaction (a temp PL/pgSQL function) so a caller inside a transaction is not left aborted.
  let noScopeError = false;
  try {
    await sql.unsafe(`CREATE OR REPLACE FUNCTION pg_temp.heopress_no_scope_probe() RETURNS boolean
      LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM public.app_site_id();
        RETURN false;
      EXCEPTION WHEN insufficient_privilege THEN
        RETURN true;
      END $$`);
    const [row] = (await sql.unsafe(`SELECT pg_temp.heopress_no_scope_probe() AS raised`)) as Array<{ raised: boolean }>;
    noScopeError = row?.raised === true;
  } catch {
    noScopeError = false;
  }
  if (!noScopeError) problems.push('a read outside a site scope did not raise "no site scope"');

  const create = (await sql.unsafe(
    `SELECT n.nspname FROM pg_namespace n
      WHERE n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
        AND has_schema_privilege(current_user, n.oid, 'CREATE')`,
  )) as Array<{ nspname: string }>;
  if (create.length > 0) problems.push(`can CREATE in ${create.map((c) => c.nspname).join(', ')}`);

  const owned = (await sql.unsafe(
    `SELECT 'relation ' || c.relname AS what FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND n.nspname NOT LIKE 'pg\\_%'
     UNION ALL
     SELECT 'function ' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND n.nspname NOT LIKE 'pg\\_%'
     UNION ALL
     SELECT 'type ' || t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE t.typowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) AND n.nspname NOT LIKE 'pg\\_%'
        AND t.typtype IN ('b', 'c', 'd', 'e', 'r', 'm') AND t.typelem = 0`,
  )) as Array<{ what: string }>;
  if (owned.length > 0) problems.push(`owns ${owned.map((o) => o.what).join(', ')}`);

  return { role, problems };
}
