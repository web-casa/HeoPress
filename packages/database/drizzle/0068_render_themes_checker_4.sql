-- HeoPress P07 task 2.4 (Codex review of batch 5b-1): the theme checker's version 4 keeps an include's or render's
-- whitespace control when it inlines the partial (version 3 lost it, so `{%- include … -%}` inside a type could join
-- `application/` and `ld+json` unseen). The rendering role's view of the active theme now returns a version only while
-- its stored checks are checker 4's or later and passed. The render versions of the sites the former view served and
-- this one does not (passed, checker 3 or later and below 4, sealed and published) rise; a version checked by an older
-- checker is served again once the CMS's worker checks it again at its start.
DO $$
DECLARE
  s text;
BEGIN
  FOR s IN SELECT id FROM public.lumibase_sites ORDER BY id LOOP
    PERFORM set_config('app.site_id', s, true);
    IF EXISTS (
      SELECT 1 FROM public.lumibase_site_themes st JOIN public.lumibase_theme_versions v ON v.id = st.theme_version_id AND v.site_id = st.site_id
      WHERE st.site_id = s AND v.sealed_at IS NOT NULL AND v.published_at IS NOT NULL AND v.checks -> 'ok' = 'true'::jsonb
        AND CASE WHEN jsonb_typeof(v.checks -> 'validator') = 'number'
                 THEN (v.checks ->> 'validator')::numeric >= 3 AND (v.checks ->> 'validator')::numeric < 4 ELSE false END
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
    AND CASE WHEN jsonb_typeof(v.checks -> 'validator') = 'number' THEN (v.checks ->> 'validator')::numeric >= 4 ELSE false END
    AND v.checks -> 'ok' = 'true'::jsonb;
