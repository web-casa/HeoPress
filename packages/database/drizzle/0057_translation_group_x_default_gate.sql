-- HeoPress P07 task 2.2: a translation group's x-default is part of every member site's public output (the
-- language switch). The projection gate's triggers on the groups table record a change of it, as of the
-- group's sites and source (P06 migration 0030), so the CMS refreshes the switch in the same transaction.
DO $$
DECLARE
  op text;
BEGIN
  FOREACH op IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.lumibase_translation_groups', 'projection_' || lower(op));
    EXECUTE format(
      'CREATE TRIGGER %I AFTER %s ON public.lumibase_translation_groups REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION public.heopress_projection_mark(%L, %L, %L, %L, %L)',
      'projection_' || lower(op), op,
      CASE op WHEN 'INSERT' THEN 'NEW TABLE AS new_rows' WHEN 'DELETE' THEN 'OLD TABLE AS old_rows' ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows' END,
      'site_id', 'id', 'site_ids', 'source_item_id', 'x_default_item_id');
  END LOOP;
END $$;
