-- HeoPress P07 task 2.4 (Codex review of batch 5b-1): the rendering role's view of the active theme returns a version
-- only while its stored checks are those of checker 2 or later and passed. Migration 0065 matched template text, which
-- a media type assembled by Liquid or written with character references gets past, and which hides a theme that merely
-- mentions the words; the stored check result is what the checks decided. A version checked by an older checker reads
-- as no row — every renderer, one deployed before this change included, renders the built-in theme — until the CMS's
-- worker checks it again (at its start, then every ten minutes): one that passes is served again (the CMS raises the
-- site's render version then), one that fails is switched off and the site's administrators are told. The render
-- versions of the sites whose active version stops being served rise here.
CREATE OR REPLACE VIEW lumibase_render_themes WITH (security_barrier) AS
  SELECT st.site_id, v.id AS version_id, v.templates, v.assets
  FROM lumibase_site_themes st JOIN lumibase_theme_versions v ON v.id = st.theme_version_id AND v.site_id = st.site_id
  WHERE st.site_id = NULLIF(current_setting('app.site_id', true), '') AND v.sealed_at IS NOT NULL AND v.published_at IS NOT NULL
    AND CASE WHEN jsonb_typeof(v.checks -> 'validator') = 'number' THEN (v.checks ->> 'validator')::numeric >= 2 ELSE false END
    AND v.checks -> 'ok' = 'true'::jsonb;
--> statement-breakpoint
DO $$
DECLARE
  s text;
BEGIN
  FOR s IN SELECT id FROM public.lumibase_sites ORDER BY id LOOP
    PERFORM set_config('app.site_id', s, true);
    IF EXISTS (
      SELECT 1 FROM public.lumibase_site_themes st JOIN public.lumibase_theme_versions v ON v.id = st.theme_version_id AND v.site_id = st.site_id
      WHERE st.site_id = s
        AND NOT (CASE WHEN jsonb_typeof(v.checks -> 'validator') = 'number' THEN (v.checks ->> 'validator')::numeric >= 2 ELSE false END
                 AND v.checks -> 'ok' = 'true'::jsonb)
    ) THEN
      UPDATE public.lumibase_site_render_versions SET version = nextval('heopress_render_version_seq') WHERE site_id = s;
    END IF;
  END LOOP;
  PERFORM set_config('app.site_id', '', true);
END $$;
