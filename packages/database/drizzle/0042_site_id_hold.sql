-- HeoPress P07 task 0.1 (Codex review round 4): the hold on deleted site ids is a database invariant, not
-- only an application check, so every way of deleting or creating a site — an older application instance
-- during a rolling deployment, first-run setup, direct maintenance SQL — observes it. A deleted site's id
-- is not given to a new site for 25 hours: longer than any cache that may remember the site (host mappings,
-- 24 hours), so no cached permission bundle, host mapping or negative verdict of it can reach a successor.
--
-- The test databases' roles carry `heopress.site_id_reuse = 'allowed'` (set only by
-- `app-role --test-database`): their fixtures delete and recreate the same ids between tests.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_site_id_held(site text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
  SELECT current_setting('heopress.site_id_reuse', true) IS DISTINCT FROM 'allowed' AND EXISTS (
    SELECT 1 FROM public.lumibase_deleted_site_ids d
     WHERE d.site_id = site AND d.deleted_at > clock_timestamp() - interval '25 hours'
  )
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_remember_deleted_site()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  INSERT INTO public.lumibase_deleted_site_ids AS d (site_id, deleted_at)
  VALUES (OLD.id, clock_timestamp())
  ON CONFLICT (site_id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at;
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
  IF public.heopress_site_id_held(NEW.id) THEN
    RAISE EXCEPTION 'site id "%" belonged to a site deleted less than 25 hours ago', NEW.id USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS heopress_remember_deleted_site ON public.lumibase_sites;
--> statement-breakpoint
CREATE TRIGGER heopress_remember_deleted_site AFTER DELETE ON public.lumibase_sites
  FOR EACH ROW EXECUTE FUNCTION public.heopress_remember_deleted_site();
--> statement-breakpoint
DROP TRIGGER IF EXISTS heopress_refuse_held_site_id ON public.lumibase_sites;
--> statement-breakpoint
CREATE TRIGGER heopress_refuse_held_site_id BEFORE INSERT ON public.lumibase_sites
  FOR EACH ROW EXECUTE FUNCTION public.heopress_refuse_held_site_id();
