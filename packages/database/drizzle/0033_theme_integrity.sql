CREATE UNIQUE INDEX "theme_versions_id_site_unique" ON "lumibase_theme_versions" USING btree ("id","site_id");--> statement-breakpoint
ALTER TABLE "lumibase_site_themes" ADD CONSTRAINT "site_themes_version_site_fk" FOREIGN KEY ("theme_version_id","site_id") REFERENCES "public"."lumibase_theme_versions"("id","site_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_theme_assets" ADD CONSTRAINT "theme_assets_version_site_fk" FOREIGN KEY ("version_id","site_id") REFERENCES "public"."lumibase_theme_versions"("id","site_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
-- HeoPress P06 batch 4 review (Codex): the theme invariants hold against the application role itself.

-- Sealing is done by the seal function only: it runs as the table owner, and the guard admits the
-- unsealed → sealed transition only from the owner (a session setting is no credential).
CREATE OR REPLACE FUNCTION heopress_theme_version_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL AND EXISTS (SELECT 1 FROM lumibase_sites WHERE id = OLD.site_id) THEN
      RAISE EXCEPTION 'theme version % was published and cannot be deleted', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.id <> OLD.id OR NEW.site_id <> OLD.site_id OR NEW.theme_id <> OLD.theme_id OR NEW.number <> OLD.number THEN
    RAISE EXCEPTION 'theme version identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.sealed_at IS NOT NULL AND (NEW.templates IS DISTINCT FROM OLD.templates OR NEW.assets IS DISTINCT FROM OLD.assets
      OR NEW.content_hash IS DISTINCT FROM OLD.content_hash OR NEW.sealed_at IS DISTINCT FROM OLD.sealed_at) THEN
    RAISE EXCEPTION 'theme version % is sealed', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.sealed_at IS NULL AND (NEW.sealed_at IS NOT NULL OR NEW.content_hash IS NOT NULL)
      AND current_user <> (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = TG_RELID) THEN
    RAISE EXCEPTION 'theme versions are sealed by heopress_seal_theme_version only' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'published_at is set once' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.published_at IS NOT NULL AND NEW.sealed_at IS NULL THEN
    RAISE EXCEPTION 'only a sealed theme version can be published' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Assets: their identity never changes; any change waits for, and respects, the version's seal (the version
-- row is locked first, the lock sealing takes).
CREATE OR REPLACE FUNCTION heopress_theme_asset_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  vid text := CASE WHEN TG_OP = 'INSERT' THEN NEW.version_id ELSE OLD.version_id END;
  sealed timestamptz;
  found_version boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.version_id <> OLD.version_id OR NEW.site_id <> OLD.site_id OR NEW.path <> OLD.path) THEN
    RAISE EXCEPTION 'theme asset identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT sealed_at, true INTO sealed, found_version FROM lumibase_theme_versions WHERE id = vid FOR SHARE;
  -- Removed with its version or its site (the cascade runs after their rows are gone): allowed.
  IF TG_OP = 'DELETE' AND (found_version IS NULL OR NOT EXISTS (SELECT 1 FROM lumibase_sites WHERE id = OLD.site_id)) THEN
    RETURN OLD;
  END IF;
  IF sealed IS NOT NULL THEN
    RAISE EXCEPTION 'theme version % is sealed: its assets cannot change', vid USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint

-- Seal: runs as the owner; every manifest entry complete and well-typed, compared null-safely.
CREATE OR REPLACE FUNCTION heopress_seal_theme_version(vid text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v lumibase_theme_versions%ROWTYPE;
  manifest_paths text[];
  hash text;
BEGIN
  SELECT * INTO v FROM lumibase_theme_versions WHERE id = vid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no theme version %', vid USING ERRCODE = 'no_data_found'; END IF;
  IF v.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'theme version % is already sealed', vid USING ERRCODE = 'check_violation'; END IF;
  IF jsonb_typeof(v.templates) <> 'object' OR jsonb_typeof(v.assets) <> 'array'
     OR EXISTS (SELECT 1 FROM jsonb_each(v.templates) t WHERE jsonb_typeof(t.value) <> 'string') THEN
    RAISE EXCEPTION 'malformed theme version' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v.assets) e
    WHERE jsonb_typeof(e) <> 'object'
       OR jsonb_typeof(e->'path') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'sha256') IS DISTINCT FROM 'string'
       OR jsonb_typeof(e->'contentType') IS DISTINCT FROM 'string' OR jsonb_typeof(e->'size') IS DISTINCT FROM 'number'
       OR (e->>'sha256') !~ '^[0-9a-f]{64}$' OR (e->>'size') !~ '^[0-9]+$'
       OR (SELECT count(*) FROM jsonb_object_keys(e)) <> 4
  ) THEN
    RAISE EXCEPTION 'malformed asset manifest entry' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(array_agg(e->>'path' ORDER BY ord), '{}') INTO manifest_paths FROM jsonb_array_elements(v.assets) WITH ORDINALITY AS a(e, ord);
  IF manifest_paths IS DISTINCT FROM (SELECT coalesce(array_agg(p ORDER BY p COLLATE "C"), '{}') FROM (SELECT DISTINCT unnest(manifest_paths) AS p) d) THEN
    RAISE EXCEPTION 'asset manifest must list distinct paths in order' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v.assets) e
    FULL JOIN (SELECT * FROM lumibase_theme_assets WHERE version_id = vid) a ON a.path = e->>'path'
    WHERE e IS NULL OR a.path IS NULL
       OR a.sha256 IS DISTINCT FROM e->>'sha256' OR a.content_type IS DISTINCT FROM e->>'contentType'
       OR octet_length(a.bytes) IS DISTINCT FROM (e->>'size')::bigint OR a.site_id IS DISTINCT FROM v.site_id
  ) THEN
    RAISE EXCEPTION 'asset manifest and assets differ' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT coalesce(sum(octet_length(bytes)), 0) FROM lumibase_theme_assets WHERE version_id = vid) > 20971520 THEN
    RAISE EXCEPTION 'theme assets exceed 20 MB' USING ERRCODE = 'check_violation';
  END IF;
  hash := encode(sha256(convert_to(v.templates::text || '|' || v.assets::text, 'UTF8')), 'hex');
  UPDATE lumibase_theme_versions SET content_hash = hash, sealed_at = now() WHERE id = vid;
  RETURN hash;
END $$;
--> statement-breakpoint

-- The pointer names a published version of its own site (the composite key covers the site).
CREATE OR REPLACE FUNCTION heopress_site_theme_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lumibase_theme_versions WHERE id = NEW.theme_version_id AND site_id = NEW.site_id AND sealed_at IS NOT NULL AND published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a site can only point at one of its own published theme versions' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER site_theme_guard BEFORE INSERT OR UPDATE ON lumibase_site_themes
  FOR EACH ROW EXECUTE FUNCTION heopress_site_theme_guard();
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION heopress_site_theme_guard() FROM PUBLIC;
--> statement-breakpoint

-- The views check the version's own site and publication too (defence in depth); assets carry their path.
CREATE OR REPLACE VIEW lumibase_render_themes WITH (security_barrier) AS
  SELECT st.site_id, v.id AS version_id, v.templates, v.assets
  FROM lumibase_site_themes st JOIN lumibase_theme_versions v ON v.id = st.theme_version_id AND v.site_id = st.site_id
  WHERE st.site_id = NULLIF(current_setting('app.site_id', true), '') AND v.sealed_at IS NOT NULL AND v.published_at IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE VIEW lumibase_render_theme_assets WITH (security_barrier) AS
  SELECT a.version_id, a.sha256, a.content_type, a.bytes, a.path
  FROM lumibase_theme_assets a JOIN lumibase_theme_versions v ON v.id = a.version_id AND v.site_id = a.site_id
  WHERE v.published_at IS NOT NULL AND v.sealed_at IS NOT NULL AND a.site_id = NULLIF(current_setting('app.site_id', true), '');
--> statement-breakpoint
-- A SECURITY DEFINER function: only roles granted it explicitly (the application role) may call it.
REVOKE EXECUTE ON FUNCTION heopress_seal_theme_version(text) FROM PUBLIC;
