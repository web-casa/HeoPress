import { RLS_REGISTRY, type RlsEntry } from './registry';

/**
 * The row-level security policies, as SQL, from the registry (HeoPress P14, ADR-0023, design D1.1). Repeatable: every
 * policy on a registered table is dropped first (P13's manually applied file included), then the registry's policies
 * are created; tables are `ENABLE` and `NO FORCE` (the owner — migrations, backups, maintenance — is not bound, design
 * D1.2); exceptions have row-level security disabled. The policy migration is this text; `rls-catalog.db.test.ts`
 * compares the database with the same registry.
 */

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/** The policies each kind of entry creates: name, command, USING and WITH CHECK. */
export interface PolicySpec {
  name: string;
  command: 'ALL' | 'SELECT' | 'INSERT' | 'DELETE';
  using: string | null;
  check: string | null;
}

const SITE = 'site_id = app_site_id()';
/** The non-raising scope, for policies that must also read rows outside any site (the global extension rows). */
const SITE_OPTIONAL = 'site_id = app_site_id_or_null()';
const AGENT_ACCESS = "current_setting('app.agent_access', true) = 'on'";

export function policiesFor(entry: RlsEntry): PolicySpec[] {
  switch (entry.policy) {
    case 'site':
      return [{ name: 'site_isolation', command: 'ALL', using: SITE, check: SITE }];
    case 'site-or-instance': {
      // CASE, not OR: an instance row never evaluates app_site_id(), which has no value outside a site scope.
      const own = `CASE WHEN site_id IS NULL THEN app_platform_scope() ELSE ${SITE} END`;
      return [
        { name: 'site_isolation', command: 'ALL', using: own, check: own },
        { name: 'instance_insert', command: 'INSERT', using: null, check: 'site_id IS NULL' },
      ];
    }
    case 'site-or-global-read':
      // Every scope reads the global rows; writes stay in the active site; global rows only in the platform scope.
      // CASE, not OR/AND: a global row never evaluates app_site_id(), which has no value outside a site scope.
      return [
        { name: 'extensions_read', command: 'SELECT', using: `CASE WHEN site_id IS NULL THEN true ELSE ${SITE_OPTIONAL} END`, check: null },
        { name: 'extensions_write', command: 'ALL', using: `CASE WHEN site_id IS NULL THEN false ELSE ${SITE_OPTIONAL} END`, check: `CASE WHEN site_id IS NULL THEN false ELSE ${SITE_OPTIONAL} END` },
        { name: 'extensions_platform', command: 'ALL', using: 'site_id IS NULL AND app_platform_scope()', check: 'site_id IS NULL AND app_platform_scope()' },
      ];
    case 'translation-group': {
      const member = 'site_id = app_site_id() OR app_site_id() = ANY (site_ids)';
      return [{ name: 'translation_group_sites', command: 'ALL', using: member, check: member }];
    }
    case 'system-events':
      return [
        { name: 'system_events_insert', command: 'INSERT', using: null, check: 'true' },
        {
          name: 'system_events_read',
          command: 'SELECT',
          using: "current_setting('app.platform_reader', true) = 'on' OR current_setting('app.retention', true) = 'on'",
          check: null,
        },
        { name: 'system_events_delete', command: 'DELETE', using: "current_setting('app.retention', true) = 'on'", check: null },
      ];
    case 'agent-access':
      return [{ name: 'agent_access', command: 'ALL', using: AGENT_ACCESS, check: AGENT_ACCESS }];
    case 'exempt':
      return [];
  }
}

function dropAllPolicies(table: string): string {
  return `DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = '${table}' LOOP
    EXECUTE format('DROP POLICY %I ON public.${table}', p);
  END LOOP;
END $$;`;
}

/** The SQL that makes the database's row-level security match `registry`, one statement per element. */
export function rlsPolicyStatements(registry: readonly RlsEntry[] = RLS_REGISTRY): string[] {
  const out: string[] = [];
  for (const entry of registry) {
    if (!IDENT.test(entry.table)) throw new Error(`invalid table name ${JSON.stringify(entry.table)}`);
    const t = entry.table;
    out.push(dropAllPolicies(t));
    if (entry.policy === 'exempt') {
      out.push(`ALTER TABLE public.${t} DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;`);
      continue;
    }
    out.push(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;`);
    for (const p of policiesFor(entry)) {
      const using = p.using === null ? '' : ` USING (${p.using})`;
      const check = p.check === null ? '' : ` WITH CHECK (${p.check})`;
      out.push(`CREATE POLICY ${p.name} ON public.${t} FOR ${p.command}${using}${check};`);
    }
  }
  return out;
}

/**
 * The non-raising scope helper the global-read policies use. The strict `app_site_id()` (migration 0122) raises when
 * there is no scope; a policy's CASE can still be folded to a parameter by the planner, so a global row must not
 * depend on the strict function being called lazily. This returns NULL outside a scope, and a site row is then
 * invisible — never visible to the wrong site.
 */
const RLS_HELPERS_SQL = `CREATE OR REPLACE FUNCTION public.app_site_id_or_null() RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
    SELECT nullif(current_setting('app.site_id', true), '')
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_lockout_policy() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT value FROM public.lumibase_settings
    WHERE key = 'login_security_policy'
    ORDER BY (site_id = '__default__') DESC, site_id ASC
    LIMIT 1
  $$;`;

/** `rlsPolicyStatements` as one script (statement breakpoints for a Drizzle migration when `breakpoints`). */
export function rlsPolicySql(registry: readonly RlsEntry[] = RLS_REGISTRY, opts: { breakpoints?: boolean } = {}): string {
  const separator = opts.breakpoints ? '--> statement-breakpoint\n' : '\n';
  return [RLS_HELPERS_SQL, ...rlsPolicyStatements(registry)].join(separator) + '\n';
}
