-- HeoPress P07 task 2.12: a site's identity is part of its public output (the structured data names it) — the
-- projection gate records its changes (the CMS copies it into lumibase_public_sites.identity and raises the site's
-- render version in the same transaction, as for the SEO settings).
DO $$
DECLARE
  op text;
BEGIN
  FOREACH op IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.lumibase_site_identity', 'projection_' || lower(op));
    EXECUTE format(
      'CREATE TRIGGER %I AFTER %s ON public.lumibase_site_identity REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION public.heopress_projection_mark(%L, %L, %L)',
      'projection_' || lower(op), op,
      CASE op WHEN 'INSERT' THEN 'NEW TABLE AS new_rows' WHEN 'DELETE' THEN 'OLD TABLE AS old_rows' ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows' END,
      'site_id', 'site_id', 'identity');
  END LOOP;
END $$;
