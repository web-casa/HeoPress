-- HeoPress P07 task 2.4 (Codex review of batch 5b-2): the public projection now carries each item's structured-data
-- inputs taken from the preset's own fields (lumibase_public_items.structured: the explicit questions and answers).
-- Existing rows have `{}` until refreshed: sites with public items get a background refresh mark, which the worker
-- rebuilds while the rendering service keeps serving them (not maintenance). Site by site, in that site's scope.
DO $$
DECLARE
  s text;
BEGIN
  FOR s IN SELECT id FROM public.lumibase_sites ORDER BY id LOOP
    PERFORM set_config('app.site_id', s, true);
    IF EXISTS (SELECT 1 FROM public.lumibase_public_items WHERE site_id = s)
       AND NOT EXISTS (SELECT 1 FROM public.lumibase_projection_rebuilds WHERE site_id = s AND reason = 'refresh: structured data') THEN
      INSERT INTO public.lumibase_projection_rebuilds (site_id, reason) VALUES (s, 'refresh: structured data');
    END IF;
  END LOOP;
  PERFORM set_config('app.site_id', '', true);
END $$;
