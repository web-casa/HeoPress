-- HeoPress P07 task 0.1 (Codex review round 6): the records of the hold on deleted site ids and the
-- test-database exemption are written only as their owner — by the hold's SECURITY DEFINER functions
-- (migration 0044) and by role provisioning, which connects as the owner. A guard on each table refuses
-- every other writer, so a grant left from before (an existing installation's application role received
-- DML on these tables by default privileges when they were created) cannot be used to break the hold,
-- whether or not role provisioning has been run again since.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_hold_tables_owner_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  IF current_user <> (SELECT c.relowner::regrole::text FROM pg_class c WHERE c.oid = TG_RELID) THEN
    RAISE EXCEPTION 'only the owner writes %', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_LEVEL = 'ROW' AND TG_OP = 'DELETE' THEN OLD WHEN TG_LEVEL = 'ROW' THEN NEW ELSE NULL END;
END;
$function$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS heopress_owner_only_rows ON public.lumibase_deleted_site_ids;
--> statement-breakpoint
CREATE TRIGGER heopress_owner_only_rows BEFORE INSERT OR UPDATE OR DELETE ON public.lumibase_deleted_site_ids
  FOR EACH ROW EXECUTE FUNCTION public.heopress_hold_tables_owner_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS heopress_owner_only_truncate ON public.lumibase_deleted_site_ids;
--> statement-breakpoint
CREATE TRIGGER heopress_owner_only_truncate BEFORE TRUNCATE ON public.lumibase_deleted_site_ids
  FOR EACH STATEMENT EXECUTE FUNCTION public.heopress_hold_tables_owner_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS heopress_owner_only_rows ON public.lumibase_site_id_reuse_exemption;
--> statement-breakpoint
CREATE TRIGGER heopress_owner_only_rows BEFORE INSERT OR UPDATE OR DELETE ON public.lumibase_site_id_reuse_exemption
  FOR EACH ROW EXECUTE FUNCTION public.heopress_hold_tables_owner_only();
--> statement-breakpoint
DROP TRIGGER IF EXISTS heopress_owner_only_truncate ON public.lumibase_site_id_reuse_exemption;
--> statement-breakpoint
CREATE TRIGGER heopress_owner_only_truncate BEFORE TRUNCATE ON public.lumibase_site_id_reuse_exemption
  FOR EACH STATEMENT EXECUTE FUNCTION public.heopress_hold_tables_owner_only();
