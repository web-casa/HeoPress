import { scramVerifier } from './scram';
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
 *   - CREATE on those schemas, because the runtime creates tables of its own:
 *     a vector space per embedding model (`lumibase_vectors_*`) and the
 *     queue's per-queue tables. The role owns those tables; maintenance that
 *     writes to them should `SET ROLE` to the role first;
 *   - read-only access to the migration history (`drizzle` schema), which
 *     readiness checks;
 *   - nothing else: no superuser, no BYPASSRLS, no CREATEDB / CREATEROLE, and
 *     membership in no other role. An existing role that is a member of
 *     another role, or that owns a row-level-secured table, is refused: it
 *     could `SET ROLE` around the policies or bypass them as the owner.
 *
 * `testDatabase` adds TRUNCATE for the database test suites, which reset
 * tables between files, and lifts the hold on deleted site ids in this
 * database (their fixtures reuse ids). Never use it for a deployment.
 *
 * The owner is made a member of the role so that maintenance (and the RLS
 * test) can `SET ROLE` to it. Idempotent.
 */
export interface AppRoleSql {
  unsafe(query: string, params?: unknown[]): PromiseLike<unknown>;
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export async function ensureAppRole(
  sql: AppRoleSql,
  opts: { role: string; password: string; schemas?: string[]; testDatabase?: boolean },
): Promise<void> {
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
  await refuseEscalation(sql, opts.role);
  await sql.unsafe(`ALTER ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD ${password}`);
  await sql.unsafe(`DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${role}', current_database()); END $$`);
  await sql.unsafe(`GRANT ${role} TO CURRENT_USER`);
  const tablePrivileges = `SELECT, INSERT, UPDATE, DELETE, REFERENCES${opts.testDatabase ? ', TRUNCATE' : ''}`;
  for (const schema of schemas) {
    const exists = (await sql.unsafe(`SELECT 1 FROM pg_namespace WHERE nspname = '${schema}'`)) as unknown[];
    if (exists.length === 0) continue;
    await sql.unsafe(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${role}`);
    // Revoke first: an earlier version of this function granted more. Only on
    // tables the role does not own — its own (vector spaces, materialized
    // views) keep the owner's privileges.
    await sql.unsafe(`
      DO $$ DECLARE t text; BEGIN
        FOR t IN SELECT format('%I.%I', n.nspname, c.relname) FROM pg_class c
                   JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE n.nspname = '${schema}' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
                    AND c.relowner <> '${opts.role}'::regrole LOOP
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
}

/**
 * An existing role must not be a way around row-level security: no
 * membership in another role (it could `SET ROLE` to an owner or a BYPASSRLS
 * role) and no ownership of a table with row-level security (owners bypass
 * the policies).
 */
async function refuseEscalation(sql: AppRoleSql, roleName: string): Promise<void> {
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
  const owned = (await sql.unsafe(
    `SELECT c.relname FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
      WHERE r.rolname = $1 AND c.relrowsecurity ORDER BY 1 LIMIT 5`,
    [roleName],
  )) as Array<{ relname: string }>;
  if (owned.length > 0) {
    throw new Error(
      `role ${roleName} owns ${owned.map((r) => r.relname).join(', ')}, which have row-level security; ` +
        'owners bypass the policies. Use a role that owns no application tables.',
    );
  }
}

/**
 * Refuse to run a row-level security test on a role that bypasses RLS: a
 * superuser or `BYPASSRLS` role sees every row, so does a role that owns the
 * tables (or inherits from their owner), so the test would pass whatever the
 * policies say. A role that can `SET ROLE` to one of those is refused too.
 */
export async function assertRlsApplies(sql: { unsafe(q: string): PromiseLike<unknown> }): Promise<void> {
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
  if (reason) {
    throw new Error(
      `row-level security tests must not run as ${r?.role ?? 'an unknown role'} (${reason}): RLS does not apply to it. ` +
        'Use the application role (pnpm --filter @heopress/database app-role).',
    );
  }
}
