-- HeoPress P07 task 2.4 (Codex review of batch 5b-1): the theme checker's version 3 finds JSON-LD scripts on each composed
-- page as a browser reads it — Liquid's whitespace control applied, `<noscript>` content read as markup — where version 2
-- missed some (and refused scripts inside comments it should have let pass). The rendering role's view of the active
-- theme now returns a version only while its stored checks are checker 3's or later and passed; as with migration 0066,
-- a version checked by an older checker reads as no row (the built-in theme) until the CMS's worker checks it again at
-- its start. The render versions of the sites whose active version stops being served here rise; those the former view
-- did not serve either are left as they are.
DO $$
DECLARE
  s text;
BEGIN
  FOR s IN SELECT id FROM public.lumibase_sites ORDER BY id LOOP
    PERFORM set_config('app.site_id', s, true);
    -- Served by the former view (checker 2 passed) and not by the new one (below checker 3).
    IF EXISTS (
      SELECT 1 FROM public.lumibase_site_themes st JOIN public.lumibase_theme_versions v ON v.id = st.theme_version_id AND v.site_id = st.site_id
      WHERE st.site_id = s AND v.checks -> 'ok' = 'true'::jsonb
        AND CASE WHEN jsonb_typeof(v.checks -> 'validator') = 'number' THEN (v.checks ->> 'validator')::numeric = 2 ELSE false END
    ) THEN
      UPDATE public.lumibase_site_render_versions SET version = nextval('heopress_render_version_seq') WHERE site_id = s;
    END IF;
  END LOOP;
  PERFORM set_config('app.site_id', '', true);
END $$;
--> statement-breakpoint
CREATE OR REPLACE VIEW lumibase_render_themes WITH (security_barrier) AS
  SELECT st.site_id, v.id AS version_id, v.templates, v.assets
  FROM lumibase_site_themes st JOIN lumibase_theme_versions v ON v.id = st.theme_version_id AND v.site_id = st.site_id
  WHERE st.site_id = NULLIF(current_setting('app.site_id', true), '') AND v.sealed_at IS NOT NULL AND v.published_at IS NOT NULL
    AND CASE WHEN jsonb_typeof(v.checks -> 'validator') = 'number' THEN (v.checks ->> 'validator')::numeric >= 3 ELSE false END
    AND v.checks -> 'ok' = 'true'::jsonb;
