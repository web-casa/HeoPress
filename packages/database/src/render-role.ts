import type { AppRoleSql } from './app-role';
import { scramVerifier } from './scram';

/**
 * The rendering service's database role (HeoPress P06 task 1.2; design R1.5, R20, R32).
 *
 * The public rendering process reads only the public projection — never the base tables, drafts,
 * administration tables or the change feed. The role:
 *
 *   - logs in and is nothing else: no superuser, no BYPASSRLS, no CREATEDB / CREATEROLE /
 *     REPLICATION, NOINHERIT, a member of no role, the owner of nothing;
 *   - has USAGE on `public` (no CREATE anywhere) and SELECT on exactly the objects in
 *     `RENDER_READABLE`, and read / write on its page cache (`RENDER_WRITABLE`);
 *   - may execute only `app_site_id()` (the optional row-level security policies call it) and the AI traffic entry
 *     `lumibase_record_crawl_hit` among the database's own functions; EXECUTE on every function of `public` is revoked from
 *     PUBLIC (the application role keeps its explicit grant).
 *
 * Every run revokes everything first, then grants the list: rerunning tightens a role that an
 * earlier version or an operator granted more. The owner becomes a member of the role (to test it
 * with SET ROLE). Idempotent.
 */
export const RENDER_READABLE = [
  'lumibase_public_hosts',
  'lumibase_public_sites',
  'lumibase_public_items',
  'lumibase_public_alternates',
  'lumibase_route_tombstones',
  'lumibase_site_render_versions',
  'lumibase_projection_rebuilds',
  'lumibase_render_redirects',
  'lumibase_render_themes',
  'lumibase_render_theme_assets',
  'lumibase_render_root_files',
] as const;

/** What the rendering role may also write: its page cache (design R20). */
export const RENDER_WRITABLE = ['lumibase_render_cache'] as const;

/**
 * The functions the rendering role may execute: `app_site_id()`, and its one write — an AI traffic hit, through the
 * checked `SECURITY DEFINER` entry (HeoPress P07 task 6.4; the role has no grant on the analytics tables themselves).
 */
const RENDER_FUNCTIONS = [
  'app_site_id()',
  'lumibase_record_crawl_hit(text, text, text, text, text, text, text, text, integer)',
  // An item's own indexing setting as the discovery scans read it (P07, migration 0090).
  'lumibase_robots_tokens(text)',
  'lumibase_robots_noindex(text)',
  'lumibase_robots_own_index(text)',
] as const;

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

export async function ensureRenderRole(sql: AppRoleSql, opts: { role: string; password: string }): Promise<void> {
  if (!IDENT.test(opts.role)) throw new Error(`invalid role name ${JSON.stringify(opts.role)}`);
  const role = `"${opts.role}"`;
  // A verifier, not the password: the plaintext never reaches the server or its logs.
  const password = `'${scramVerifier(opts.password)}'`;
  await sql.unsafe(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${opts.role}') THEN
        CREATE ROLE ${role} LOGIN;
      END IF;
    END $$`);
  const memberOf = (await sql.unsafe(
    `SELECT g.rolname FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member JOIN pg_roles g ON g.oid = m.roleid WHERE r.rolname = $1`,
    [opts.role],
  )) as unknown[];
  if (memberOf.length > 0) throw new Error(`role ${opts.role} is a member of another role; the rendering role must not be.`);
  const owns = (await sql.unsafe(
    `SELECT 1 FROM pg_roles r WHERE r.rolname = $1 AND (
       EXISTS (SELECT 1 FROM pg_class WHERE relowner = r.oid) OR EXISTS (SELECT 1 FROM pg_proc WHERE proowner = r.oid) OR
       EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = r.oid) OR EXISTS (SELECT 1 FROM pg_type WHERE typowner = r.oid))`,
    [opts.role],
  )) as unknown[];
  if (owns.length > 0) throw new Error(`role ${opts.role} owns database objects; the rendering role must own nothing.`);

  // Default privileges naming the role can only be revoked by a member of the role that set them:
  // refuse before anything is changed rather than stop half way.
  const foreign = (await sql.unsafe(
    `SELECT DISTINCT pg_get_userbyid(d.defaclrole) AS owner FROM pg_default_acl d
      WHERE EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) x JOIN pg_roles r ON r.oid = x.grantee WHERE r.rolname = $1)
        AND NOT pg_has_role(current_user, d.defaclrole, 'MEMBER')`,
    [opts.role],
  )) as Array<{ owner: string }>;
  if (foreign.length > 0) {
    throw new Error(
      `default privileges of ${foreign.map((f) => f.owner).join(', ')} grant to ${opts.role}; run as a member of ` +
        `that role, or revoke them first (ALTER DEFAULT PRIVILEGES FOR ROLE <owner> REVOKE ALL ON TABLES FROM ${opts.role}).`,
    );
  }

  await sql.unsafe(`ALTER ROLE ${role} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD ${password}`);
  await sql.unsafe(`DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${role}', current_database()); END $$`);
  await sql.unsafe(`GRANT ${role} TO CURRENT_USER`);

  // Everything off, in every schema the database has.
  const schemas = (await sql.unsafe(
    `SELECT nspname FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'`,
  )) as Array<{ nspname: string }>;
  for (const { nspname } of schemas) {
    const s = `"${nspname.replace(/"/g, '""')}"`;
    await sql.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM ${role}`);
    await sql.unsafe(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM ${role}`);
    await sql.unsafe(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${s} FROM ${role}`);
    await sql.unsafe(`REVOKE ALL ON SCHEMA ${s} FROM ${role}`);
  }
  // Column grants survive a table-level REVOKE ALL: take each one back.
  const columns = (await sql.unsafe(
    `SELECT c.oid::regclass::text AS rel, a.attname AS col
       FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
      WHERE a.attacl IS NOT NULL AND EXISTS (SELECT 1 FROM aclexplode(a.attacl) x JOIN pg_roles r ON r.oid = x.grantee WHERE r.rolname = $1)`,
    [opts.role],
  )) as Array<{ rel: string; col: string }>;
  for (const { rel, col } of columns) await sql.unsafe(`REVOKE ALL ("${col.replace(/"/g, '""')}") ON ${rel} FROM ${role}`);
  // Default privileges naming the role (granted by the current user, or any role it may act for).
  const defaults = (await sql.unsafe(
    `SELECT pg_get_userbyid(d.defaclrole) AS owner, n.nspname AS schema, d.defaclobjtype AS kind
       FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
      WHERE EXISTS (SELECT 1 FROM aclexplode(d.defaclacl) x JOIN pg_roles r ON r.oid = x.grantee WHERE r.rolname = $1)`,
    [opts.role],
  )) as Array<{ owner: string; schema: string | null; kind: string }>;
  const KINDS: Record<string, string> = { r: 'TABLES', S: 'SEQUENCES', f: 'FUNCTIONS', T: 'TYPES', n: 'SCHEMAS' };
  for (const d of defaults) {
    const scope = d.schema ? ` IN SCHEMA "${d.schema.replace(/"/g, '""')}"` : '';
    await sql.unsafe(`ALTER DEFAULT PRIVILEGES FOR ROLE "${d.owner.replace(/"/g, '""')}"${scope} REVOKE ALL ON ${KINDS[d.kind] ?? 'TABLES'} FROM ${role}`);
  }
  // Functions are executable by PUBLIC by default: not here. The application role has its own grant.
  await sql.unsafe(`REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC`);
  await sql.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`);
  await sql.unsafe(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);

  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
  for (const t of RENDER_READABLE) await sql.unsafe(`GRANT SELECT ON public.${t} TO ${role}`);
  for (const t of RENDER_WRITABLE) await sql.unsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON public.${t} TO ${role}`);
  for (const f of RENDER_FUNCTIONS) {
    const exists = (await sql.unsafe(`SELECT to_regprocedure('public.${f}') IS NOT NULL AS ok`)) as Array<{ ok: boolean }>;
    if (exists[0]?.ok) await sql.unsafe(`GRANT EXECUTE ON FUNCTION public.${f} TO ${role}`);
  }
}
