-- HeoPress P07 task 2.2: the language switch now lists published, indexable members only (and the group's
-- x-default). Sites with translation-group members get a background refresh mark: the worker rebuilds their
-- projection — every group of the site, its members on other sites included — while the rendering service keeps
-- serving them (`refresh:` marks are not maintenance). Members are read site by site in that site's scope (with
-- the row-level security policies in force, a statement without `app.site_id` sees no rows).
DO $$
DECLARE
  s text;
BEGIN
  FOR s IN SELECT id FROM public.lumibase_sites ORDER BY id LOOP
    PERFORM set_config('app.site_id', s, true);
    IF EXISTS (SELECT 1 FROM public.lumibase_translation_group_members WHERE site_id = s)
       AND NOT EXISTS (SELECT 1 FROM public.lumibase_projection_rebuilds WHERE site_id = s AND reason = 'refresh: language switch indexing') THEN
      INSERT INTO public.lumibase_projection_rebuilds (site_id, reason) VALUES (s, 'refresh: language switch indexing');
    END IF;
  END LOOP;
  PERFORM set_config('app.site_id', '', true);
END $$;
