-- HeoPress P06 batch 4 review round 3 (Codex): every function of ours — trigger functions included —
-- resolves names through a trusted search path ending in pg_temp. A trigger fired inside a SECURITY
-- DEFINER function runs with its owner's privileges, so an unlisted temporary schema (searched before
-- pg_catalog) would let a caller's temporary object stand in for pg_class or one of our tables.
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN
    SELECT p.oid::regprocedure FROM pg_catalog.pg_proc p
    WHERE p.pronamespace = 'public'::regnamespace AND (p.proname LIKE 'heopress\_%' OR p.proname = 'app_site_id' OR p.proname = 'app_platform_scope')
  LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', f);
  END LOOP;
END $$;
