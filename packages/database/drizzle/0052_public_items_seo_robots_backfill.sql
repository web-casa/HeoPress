-- HeoPress P07 task 2.8: the public projection carries each item's own indexing setting (`seo_robots`, as
-- written). Existing rows get it here, site by site in that site's scope: with the row-level security
-- policies in force (FORCE, owner included) a statement without `app.site_id` would see no rows and
-- silently do nothing. The site's render version is not raised: the output version of the rendering
-- service (P07) already makes every cached answer of the former format a miss.
DO $$
DECLARE
  s text;
BEGIN
  FOR s IN SELECT id FROM public.lumibase_sites ORDER BY id LOOP
    PERFORM set_config('app.site_id', s, true);
    UPDATE public.lumibase_public_items p
    SET seo_robots = i.data->>'seo_robots'
    FROM public.lumibase_items i
    WHERE p.site_id = s AND i.site_id = s AND i.id = p.item_id
      AND p.seo_robots IS DISTINCT FROM i.data->>'seo_robots';
  END LOOP;
  PERFORM set_config('app.site_id', '', true);
END $$;
