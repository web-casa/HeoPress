-- HeoPress P07 (Codex review of batch 4b): an item update that moves rows between sites (an owner's or system's write;
-- the application's row-level security never lets one) holds the settings rows of the sites it leaves as well as
-- those it enters. Migration 0061's update trigger saw only the new rows.
CREATE OR REPLACE FUNCTION public.heopress_items_settings_share() RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM 1 FROM public.lumibase_site_content_settings s
    WHERE s.site_id IN (SELECT o.site_id FROM old_rows o)
    ORDER BY s.site_id FOR SHARE OF s;
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM 1 FROM public.lumibase_site_content_settings s
    WHERE s.site_id IN (SELECT o.site_id FROM old_rows o UNION SELECT n.site_id FROM new_rows n)
    ORDER BY s.site_id FOR SHARE OF s;
  ELSE
    PERFORM 1 FROM public.lumibase_site_content_settings s
    WHERE s.site_id IN (SELECT n.site_id FROM new_rows n)
    ORDER BY s.site_id FOR SHARE OF s;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS settings_share_update ON public.lumibase_items;
--> statement-breakpoint
CREATE TRIGGER settings_share_update AFTER UPDATE ON public.lumibase_items
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.heopress_items_settings_share();
