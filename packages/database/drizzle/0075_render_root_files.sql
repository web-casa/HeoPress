-- HeoPress P07 task 3.8: the rendering role reads a site's root files through this view only — the current site's
-- (`app.site_id`), and only what it serves: the name, the type, the text and its hash. A change of a root file passes
-- the projection gate: the CMS raises the site's render version in the same transaction (a cached answer is never
-- served for a file that changed or went).
CREATE OR REPLACE VIEW lumibase_render_root_files WITH (security_barrier) AS
  SELECT f.site_id, f.filename, f.content_type, f.content, f.sha256
  FROM lumibase_site_root_files f
  WHERE f.site_id = NULLIF(current_setting('app.site_id', true), '');
--> statement-breakpoint
DO $$
DECLARE
  op text;
BEGIN
  FOREACH op IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.lumibase_site_root_files', 'projection_' || lower(op));
    EXECUTE format(
      'CREATE TRIGGER %I AFTER %s ON public.lumibase_site_root_files REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION public.heopress_projection_mark(%L, %L, %L, %L, %L)',
      'projection_' || lower(op), op,
      CASE op WHEN 'INSERT' THEN 'NEW TABLE AS new_rows' WHEN 'DELETE' THEN 'OLD TABLE AS old_rows' ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows' END,
      'site_id', 'id', 'filename', 'content_type', 'sha256');
  END LOOP;
END $$;
