-- HeoPress P07 task 2.4: a page's structured data is the system's one graph — a theme no longer writes JSON-LD (the
-- `json_ld` tag is gone, and a theme's own `<script type="application/ld+json">` is refused). The rendering role's view
-- of the active theme stops returning a version whose templates carry either, so a rendering service of any version —
-- one deployed before this change included — renders such a site with the built-in theme instead (it reads no row).
-- Those sites' render versions rise here, so no cached page of the former theme is served again. The CMS's worker
-- then checks each active version again with the current checker and moves a site whose version fails back to the
-- built-in theme for good, telling its administrators (P07 task 2.4).
CREATE OR REPLACE VIEW lumibase_render_themes WITH (security_barrier) AS
  SELECT st.site_id, v.id AS version_id, v.templates, v.assets
  FROM lumibase_site_themes st JOIN lumibase_theme_versions v ON v.id = st.theme_version_id AND v.site_id = st.site_id
  WHERE st.site_id = NULLIF(current_setting('app.site_id', true), '') AND v.sealed_at IS NOT NULL AND v.published_at IS NOT NULL
    AND v.templates::text !~* '\{%-?(\s|\\[nrt])*json_ld([^a-z0-9_]|$)|application/ld\+json';
--> statement-breakpoint
DO $$
DECLARE
  s text;
BEGIN
  FOR s IN SELECT id FROM public.lumibase_sites ORDER BY id LOOP
    PERFORM set_config('app.site_id', s, true);
    IF EXISTS (
      SELECT 1 FROM public.lumibase_site_themes st JOIN public.lumibase_theme_versions v ON v.id = st.theme_version_id AND v.site_id = st.site_id
      WHERE st.site_id = s AND v.templates::text ~* '\{%-?(\s|\\[nrt])*json_ld([^a-z0-9_]|$)|application/ld\+json'
    ) THEN
      UPDATE public.lumibase_site_render_versions SET version = nextval('heopress_render_version_seq') WHERE site_id = s;
    END IF;
  END LOOP;
  PERFORM set_config('app.site_id', '', true);
END $$;
