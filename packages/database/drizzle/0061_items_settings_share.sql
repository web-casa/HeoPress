-- HeoPress P07 (Codex review of batch 4b): every write of items holds its sites' content settings rows shared until it
-- commits. A site-wide projection refresh (SEO settings, domains, collections, fields, the site row, rebuilds) holds the
-- site's row exclusively while it reads and rewrites every item row of the site; with this, no item write of the site
-- runs beside it, so it never writes back what it read before such a write committed — whichever service (or none)
-- made the write. The item service already takes the lock before its first statement; for it this is a no-op.
-- Statement triggers after each operation, so a bulk write locks each site once, in site order.
CREATE OR REPLACE FUNCTION public.heopress_items_settings_share() RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM 1 FROM public.lumibase_site_content_settings s
    WHERE s.site_id IN (SELECT DISTINCT o.site_id FROM old_rows o)
    ORDER BY s.site_id FOR SHARE OF s;
  ELSE
    PERFORM 1 FROM public.lumibase_site_content_settings s
    WHERE s.site_id IN (SELECT DISTINCT n.site_id FROM new_rows n)
    ORDER BY s.site_id FOR SHARE OF s;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DO $$
DECLARE
  op text;
BEGIN
  FOREACH op IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.lumibase_items', 'settings_share_' || lower(op));
    EXECUTE format(
      'CREATE TRIGGER %I AFTER %s ON public.lumibase_items REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION public.heopress_items_settings_share()',
      'settings_share_' || lower(op), op,
      CASE op WHEN 'DELETE' THEN 'OLD TABLE AS old_rows' ELSE 'NEW TABLE AS new_rows' END);
  END LOOP;
END $$;
