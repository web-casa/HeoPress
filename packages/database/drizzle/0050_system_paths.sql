-- HeoPress P07 task 1.5: the top-level paths a public site keeps for itself (discovery files, `.well-known`,
-- site root files and the IndexNow key file) — the mirror of `isSystemPathSegment` in
-- packages/public-site/src/system-paths.ts (a test keeps the two equal). From this release the CMS refuses
-- content paths that start with one of them; content that already does is reported here, and the upgrade
-- stops until it is moved: answering it would now be the system's, and the content would silently vanish.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_is_system_path(segment text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
  SELECT lower(segment) ~ '^(feed|rss|atom)([-_.][a-z0-9-]+)*$'
      OR lower(segment) ~ '^\.?well-known$'
      OR lower(segment) ~ '^[^/]+\.(txt|xml|html|htm|json|webmanifest|ico)$'
$function$;
--> statement-breakpoint
DO $$
DECLARE
  report text;
BEGIN
  SELECT string_agg(format('%s %s', site_id, path), E'\n' ORDER BY site_id, path)
    INTO report
    FROM (
      SELECT site_id, path FROM public.lumibase_content_routes
       WHERE public.heopress_is_system_path(split_part(path, '/', 2))
       ORDER BY site_id, path LIMIT 50
    ) conflicts;
  IF report IS NOT NULL THEN
    RAISE EXCEPTION 'content paths now reserved for the public site''s own files (move them, e.g. with a new slug and a redirect, then upgrade again):%', E'\n' || report
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
