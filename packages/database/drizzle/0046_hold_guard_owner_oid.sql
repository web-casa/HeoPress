-- HeoPress P07 task 0.1 (Codex review round 7): the write guard of migration 0045 compares the table owner
-- by role oid, not by its rendered name (`regrole::text` quotes names that need quoting, which never equal
-- `current_user`): an owner role such as "HeoPress" is recognised.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_hold_tables_owner_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles r ON r.oid = c.relowner
     WHERE c.oid = TG_RELID AND r.rolname = current_user
  ) THEN
    RAISE EXCEPTION 'only the owner writes %', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_LEVEL = 'ROW' AND TG_OP = 'DELETE' THEN OLD WHEN TG_LEVEL = 'ROW' THEN NEW ELSE NULL END;
END;
$function$;
