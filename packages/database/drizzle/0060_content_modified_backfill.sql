-- HeoPress P07 task 2.5: the real content modification time. Existing projection rows take their publication time;
-- a row without one takes the time of this migration (when it is first known to the projection: the projection
-- never recorded when a row entered it, and `updated_at` moves with edits that are not content). Their content hash
-- stays null: the next refresh of the row records it without moving the time. The remembered last public path of an
-- item takes the same time, so a republish keeps it. Sites with public items get a background refresh mark: the
-- worker records the hashes soon after the upgrade while the rendering service keeps serving them. Site by site in
-- that site's scope (with the row-level security policies in force, a statement without `app.site_id` sees no rows).
DO $$
DECLARE
  s text;
BEGIN
  FOR s IN SELECT id FROM public.lumibase_sites ORDER BY id LOOP
    PERFORM set_config('app.site_id', s, true);
    UPDATE public.lumibase_public_items
    SET content_modified_at = COALESCE(published_at, now())
    WHERE site_id = s AND content_modified_at IS NULL;
    UPDATE public.lumibase_public_path_memory m
    SET content_modified_at = p.content_modified_at
    FROM public.lumibase_public_items p
    WHERE m.site_id = s AND p.site_id = s AND p.item_id = m.item_id AND m.content_modified_at IS NULL;
    IF EXISTS (SELECT 1 FROM public.lumibase_public_items WHERE site_id = s)
       AND NOT EXISTS (SELECT 1 FROM public.lumibase_projection_rebuilds WHERE site_id = s AND reason = 'refresh: content modified time') THEN
      INSERT INTO public.lumibase_projection_rebuilds (site_id, reason) VALUES (s, 'refresh: content modified time');
    END IF;
  END LOOP;
  PERFORM set_config('app.site_id', '', true);
END $$;
