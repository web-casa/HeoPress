-- HeoPress P07 task 1.4: a site's SEO / GEO settings are part of its public output — the projection gate
-- records their changes (the CMS copies their public part into lumibase_public_sites.seo and raises the
-- site's render version in the same transaction, as for the content settings).
DO $$
DECLARE
  op text;
BEGIN
  FOREACH op IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.lumibase_site_seo_settings', 'projection_' || lower(op));
    EXECUTE format(
      'CREATE TRIGGER %I AFTER %s ON public.lumibase_site_seo_settings REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION public.heopress_projection_mark(%L, %L, %L)',
      'projection_' || lower(op), op,
      CASE op WHEN 'INSERT' THEN 'NEW TABLE AS new_rows' WHEN 'DELETE' THEN 'OLD TABLE AS old_rows' ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows' END,
      'site_id', 'site_id', 'settings');
  END LOOP;
END $$;
