-- HeoPress P14 task 1.2 (ADR-0023, spec platform/tenant-isolation): the strict site scope. `app_site_id()` was defined by
-- the optional `migrations/rls-policies.sql` and returned NULL without a scope, so a path that forgot its scope read
-- nothing instead of failing. Now, with the signature unchanged (the rendering role keeps its EXECUTE grant):
--   - `app.site_id` set in the transaction: that site;
--   - the platform scope (`app.platform_scope = 'on'`, no site): NULL, so no site's row matches;
--   - neither: SQLSTATE 42501, "heopress: no site scope".
-- STABLE: a policy's `site_id = app_site_id()` is an index condition computed once per scan. Not SECURITY DEFINER: it
-- reads the caller's own settings. This migration only defines the functions; the policies that call them are installed
-- by a later P14 migration.
CREATE OR REPLACE FUNCTION public.app_site_id() RETURNS text
  LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  site text := NULLIF(current_setting('app.site_id', true), '');
BEGIN
  IF site IS NOT NULL THEN
    RETURN site;
  END IF;
  IF coalesce(current_setting('app.platform_scope', true), '') = 'on' THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION USING
    ERRCODE = '42501',
    MESSAGE = 'heopress: no site scope',
    HINT = 'Run the statement through a scoped database handle (scopedDatabase) or set app.site_id in its transaction.';
END $$;--> statement-breakpoint
COMMENT ON FUNCTION public.app_site_id() IS
  'The site scope of the current transaction (app.site_id, set with set_config(..., true)); NULL in the platform scope; '
  'raises 42501 "heopress: no site scope" without either. Called by the row-level security policies (HeoPress P14, ADR-0023).';--> statement-breakpoint
-- The platform scope: global rows (extensions) are written only with `app.platform_scope = 'on'` and no site.
CREATE OR REPLACE FUNCTION public.app_platform_scope() RETURNS boolean
  LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
    SELECT coalesce(current_setting('app.platform_scope', true), '') = 'on'
           AND NULLIF(current_setting('app.site_id', true), '') IS NULL;
  $$;--> statement-breakpoint
COMMENT ON FUNCTION public.app_platform_scope() IS
  'Whether the current transaction is in the platform scope (app.platform_scope = on, no site) (HeoPress P14, ADR-0023).';
