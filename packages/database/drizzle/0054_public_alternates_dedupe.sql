-- HeoPress P07 task 2.2: the language switch is keyed by language — (site, item, locale) — so that a group's
-- `x-default` entry can name a member that also has its own language entry. A group has at most one published
-- member per language (P05), so no row should share a key; any that would (derived rows, rebuilt by the
-- projection) are removed first, site by site in that site's scope (with the row-level security policies in
-- force, a statement without `app.site_id` sees no rows).
DO $$
DECLARE
  s text;
BEGIN
  FOR s IN SELECT id FROM public.lumibase_sites ORDER BY id LOOP
    PERFORM set_config('app.site_id', s, true);
    DELETE FROM public.lumibase_public_alternates a
    USING public.lumibase_public_alternates b
    WHERE a.site_id = s AND b.site_id = s AND a.item_id = b.item_id AND a.locale = b.locale
      AND a.target_item_id > b.target_item_id;
  END LOOP;
  PERFORM set_config('app.site_id', '', true);
END $$;
