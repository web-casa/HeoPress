-- HeoPress P07 task 0.1 (Codex review round 5): the hold on deleted site ids (migration 0042) made
-- impossible to opt out of or race past.
--
--   * The test-database exemption is the owner-written row of lumibase_site_id_reuse_exemption (migration
--     0043), no longer a setting any session can SET; ids starting with its except_prefix stay held (the
--     tests of the hold itself). The functions run as their owner (SECURITY DEFINER, fixed search_path):
--     the application role needs, and keeps, no write access to the tombstones or the exemption.
--   * Deleting and inserting the same id are serialised on a transaction lock of that id, and the check
--     is made after the lock with a fresh snapshot: a concurrent delete-then-insert cannot pass unseen.
--   * TRUNCATE remembers every id it removes; a site's id cannot be changed.
--> statement-breakpoint
REVOKE ALL ON public.lumibase_deleted_site_ids FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON public.lumibase_site_id_reuse_exemption FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_site_id_exempt(site text)
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.lumibase_site_id_reuse_exemption e
     WHERE e.singleton AND NOT starts_with(site, e.except_prefix)
  )
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_site_id_held(site text)
 RETURNS boolean
 LANGUAGE sql
 VOLATILE
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
  SELECT NOT public.heopress_site_id_exempt(site) AND EXISTS (
    SELECT 1 FROM public.lumibase_deleted_site_ids d
     WHERE d.site_id = site AND d.deleted_at > clock_timestamp() - interval '25 hours'
  )
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_lock_site_id(site text)
 RETURNS void
 LANGUAGE sql
 VOLATILE
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
  SELECT pg_advisory_xact_lock(hashtextextended('heopress.site-id:' || site, 0))
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_lock_deleted_site()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  PERFORM public.heopress_lock_site_id(OLD.id);
  RETURN OLD;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_remember_deleted_site()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  IF NOT public.heopress_site_id_exempt(OLD.id) THEN
    INSERT INTO public.lumibase_deleted_site_ids AS d (site_id, deleted_at)
    VALUES (OLD.id, clock_timestamp())
    ON CONFLICT (site_id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at;
  END IF;
  -- Nothing older than the hold is needed any more.
  DELETE FROM public.lumibase_deleted_site_ids WHERE deleted_at < clock_timestamp() - interval '25 hours';
  RETURN OLD;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_refuse_held_site_id()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  -- After the lock a deletion of the same id has committed (or rolled back): the check below sees it.
  PERFORM public.heopress_lock_site_id(NEW.id);
  IF public.heopress_site_id_held(NEW.id) THEN
    RAISE EXCEPTION 'site id "%" belonged to a site deleted less than 25 hours ago', NEW.id USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_remember_truncated_sites()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  INSERT INTO public.lumibase_deleted_site_ids AS d (site_id, deleted_at)
  SELECT s.id, clock_timestamp() FROM public.lumibase_sites s WHERE NOT public.heopress_site_id_exempt(s.id)
  ON CONFLICT (site_id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_refuse_site_id_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'a site''s id cannot be changed' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.heopress_site_id_exempt(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.heopress_remember_deleted_site() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.heopress_remember_truncated_sites() FROM PUBLIC;
--> statement-breakpoint
DROP TRIGGER IF EXISTS heopress_lock_deleted_site ON public.lumibase_sites;
--> statement-breakpoint
CREATE TRIGGER heopress_lock_deleted_site BEFORE DELETE ON public.lumibase_sites
  FOR EACH ROW EXECUTE FUNCTION public.heopress_lock_deleted_site();
--> statement-breakpoint
DROP TRIGGER IF EXISTS heopress_remember_truncated_sites ON public.lumibase_sites;
--> statement-breakpoint
CREATE TRIGGER heopress_remember_truncated_sites BEFORE TRUNCATE ON public.lumibase_sites
  FOR EACH STATEMENT EXECUTE FUNCTION public.heopress_remember_truncated_sites();
--> statement-breakpoint
DROP TRIGGER IF EXISTS heopress_refuse_site_id_change ON public.lumibase_sites;
--> statement-breakpoint
CREATE TRIGGER heopress_refuse_site_id_change BEFORE UPDATE OF id ON public.lumibase_sites
  FOR EACH ROW EXECUTE FUNCTION public.heopress_refuse_site_id_change();
