CREATE TABLE "lumibase_site_themes" (
	"site_id" text PRIMARY KEY NOT NULL,
	"theme_version_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_theme_assets" (
	"version_id" text NOT NULL,
	"site_id" text NOT NULL,
	"path" text NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	CONSTRAINT "lumibase_theme_assets_version_id_path_pk" PRIMARY KEY("version_id","path")
);
--> statement-breakpoint
CREATE TABLE "lumibase_theme_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"theme_id" text NOT NULL,
	"number" integer NOT NULL,
	"templates" jsonb NOT NULL,
	"assets" jsonb NOT NULL,
	"content_hash" text,
	"sealed_at" timestamp with time zone,
	"checks" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lumibase_themes" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_site_themes" ADD CONSTRAINT "lumibase_site_themes_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_site_themes" ADD CONSTRAINT "lumibase_site_themes_theme_version_id_lumibase_theme_versions_id_fk" FOREIGN KEY ("theme_version_id") REFERENCES "public"."lumibase_theme_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_theme_assets" ADD CONSTRAINT "lumibase_theme_assets_version_id_lumibase_theme_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."lumibase_theme_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_theme_assets" ADD CONSTRAINT "lumibase_theme_assets_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_theme_versions" ADD CONSTRAINT "lumibase_theme_versions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_theme_versions" ADD CONSTRAINT "lumibase_theme_versions_theme_id_lumibase_themes_id_fk" FOREIGN KEY ("theme_id") REFERENCES "public"."lumibase_themes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_themes" ADD CONSTRAINT "lumibase_themes_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "theme_assets_version_sha" ON "lumibase_theme_assets" USING btree ("version_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "theme_versions_theme_number_unique" ON "lumibase_theme_versions" USING btree ("theme_id","number");--> statement-breakpoint
CREATE INDEX "theme_versions_site" ON "lumibase_theme_versions" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "themes_site_name_unique" ON "lumibase_themes" USING btree ("site_id","name");--> statement-breakpoint
-- HeoPress P06 tasks 2.3, 2.4, 2.7 (design §5, R6, R23, R34): theme versions are immutable once sealed.
ALTER TABLE "lumibase_theme_assets" ADD CONSTRAINT "theme_assets_sha256" CHECK (sha256 = encode(sha256(bytes), 'hex'));
--> statement-breakpoint
ALTER TABLE "lumibase_theme_assets" ADD CONSTRAINT "theme_assets_size" CHECK (octet_length(bytes) <= 2097152);
--> statement-breakpoint
ALTER TABLE "lumibase_theme_assets" ADD CONSTRAINT "theme_assets_path" CHECK (path ~ '^[a-z0-9_-]+(/[a-z0-9_-]+)*\.[a-z0-9]+$');
--> statement-breakpoint

-- A sealed version's content, and a published version's existence, never change.
CREATE OR REPLACE FUNCTION heopress_theme_version_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- A published version stays, unless its whole site is going (the site row is already gone in the cascade).
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
  IF OLD.sealed_at IS NULL AND NEW.sealed_at IS NOT NULL AND current_setting('heopress.sealing', true) IS DISTINCT FROM OLD.id THEN
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
CREATE TRIGGER theme_version_guard BEFORE UPDATE OR DELETE ON lumibase_theme_versions
  FOR EACH ROW EXECUTE FUNCTION heopress_theme_version_guard();
--> statement-breakpoint

-- A new version starts unsealed and unpublished.
CREATE OR REPLACE FUNCTION heopress_theme_version_insert_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.sealed_at IS NOT NULL OR NEW.content_hash IS NOT NULL OR NEW.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'a theme version is created unsealed and unpublished' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER theme_version_insert_guard BEFORE INSERT ON lumibase_theme_versions
  FOR EACH ROW EXECUTE FUNCTION heopress_theme_version_insert_guard();
--> statement-breakpoint

-- A sealed version's assets are fixed: no new, changed or removed asset (except with the version itself).
CREATE OR REPLACE FUNCTION heopress_theme_asset_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  vid text := CASE WHEN TG_OP = 'INSERT' THEN NEW.version_id ELSE OLD.version_id END;
  sealed timestamptz;
BEGIN
  SELECT sealed_at INTO sealed FROM lumibase_theme_versions WHERE id = vid;
  -- Removed with its version or its site (the cascade runs after their rows are gone): allowed.
  IF TG_OP = 'DELETE' AND (sealed IS NULL OR NOT EXISTS (SELECT 1 FROM lumibase_sites WHERE id = OLD.site_id)) THEN
    RETURN OLD;
  END IF;
  IF sealed IS NOT NULL THEN
    RAISE EXCEPTION 'theme version % is sealed: its assets cannot change', vid USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND NOT EXISTS (SELECT 1 FROM lumibase_theme_versions WHERE id = vid AND site_id = NEW.site_id) THEN
    RAISE EXCEPTION 'theme asset site does not match its version' USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE TRIGGER theme_asset_guard BEFORE INSERT OR UPDATE OR DELETE ON lumibase_theme_assets
  FOR EACH ROW EXECUTE FUNCTION heopress_theme_asset_guard();
--> statement-breakpoint

-- Seal (R34): the manifest and the asset rows correspond one to one (paths sorted, no duplicates), each
-- entry's digest, type and size match the bytes, the version stays within 20 MB; then the content hash is
-- computed and sealed_at set — the one allowed transition.
CREATE OR REPLACE FUNCTION heopress_seal_theme_version(vid text) RETURNS text
  LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  v lumibase_theme_versions%ROWTYPE;
  manifest_paths text[];
  hash text;
BEGIN
  SELECT * INTO v FROM lumibase_theme_versions WHERE id = vid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no theme version %', vid USING ERRCODE = 'no_data_found'; END IF;
  IF v.sealed_at IS NOT NULL THEN RAISE EXCEPTION 'theme version % is already sealed', vid USING ERRCODE = 'check_violation'; END IF;
  IF jsonb_typeof(v.templates) <> 'object' OR jsonb_typeof(v.assets) <> 'array' THEN
    RAISE EXCEPTION 'malformed theme version' USING ERRCODE = 'check_violation';
  END IF;
  SELECT coalesce(array_agg(e->>'path' ORDER BY ord), '{}') INTO manifest_paths FROM jsonb_array_elements(v.assets) WITH ORDINALITY AS a(e, ord);
  IF manifest_paths IS DISTINCT FROM (SELECT coalesce(array_agg(p ORDER BY p COLLATE "C"), '{}') FROM (SELECT DISTINCT unnest(manifest_paths) AS p) d) THEN
    RAISE EXCEPTION 'asset manifest must list distinct paths in order' USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(v.assets) e
    FULL JOIN (SELECT * FROM lumibase_theme_assets WHERE version_id = vid) a ON a.path = e->>'path'
    WHERE e IS NULL OR a.path IS NULL OR a.sha256 <> e->>'sha256' OR a.content_type <> e->>'contentType' OR octet_length(a.bytes) <> (e->>'size')::int
  ) OR EXISTS (SELECT 1 FROM lumibase_theme_assets a WHERE a.version_id = vid AND NOT (a.path = ANY (manifest_paths))) THEN
    RAISE EXCEPTION 'asset manifest and assets differ' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT coalesce(sum(octet_length(bytes)), 0) FROM lumibase_theme_assets WHERE version_id = vid) > 20971520 THEN
    RAISE EXCEPTION 'theme assets exceed 20 MB' USING ERRCODE = 'check_violation';
  END IF;
  hash := encode(sha256(convert_to(v.templates::text || '|' || v.assets::text, 'UTF8')), 'hex');
  PERFORM set_config('heopress.sealing', vid, true);
  UPDATE lumibase_theme_versions SET content_hash = hash, sealed_at = now() WHERE id = vid;
  PERFORM set_config('heopress.sealing', '', true);
  RETURN hash;
END $$;
--> statement-breakpoint

-- The site's pointer is part of its public output: the projection gate records its changes (R13).
DO $$
DECLARE
  op text;
BEGIN
  FOREACH op IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I AFTER %s ON lumibase_site_themes REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION heopress_projection_mark(%L, %L, %L, %L)',
      'projection_' || lower(op), op,
      CASE op WHEN 'INSERT' THEN 'NEW TABLE AS new_rows' WHEN 'DELETE' THEN 'OLD TABLE AS old_rows' ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows' END,
      'site_id', 'site_id', 'theme_version_id', 'version');
  END LOOP;
END $$;
--> statement-breakpoint

-- What the rendering role reads, limited to the current site (the views read their tables as their owner).
CREATE VIEW lumibase_render_themes WITH (security_barrier) AS
  SELECT st.site_id, v.id AS version_id, v.templates, v.assets
  FROM lumibase_site_themes st JOIN lumibase_theme_versions v ON v.id = st.theme_version_id
  WHERE st.site_id = NULLIF(current_setting('app.site_id', true), '');
--> statement-breakpoint
CREATE VIEW lumibase_render_theme_assets WITH (security_barrier) AS
  SELECT a.version_id, a.sha256, a.content_type, a.bytes
  FROM lumibase_theme_assets a JOIN lumibase_theme_versions v ON v.id = a.version_id
  WHERE v.published_at IS NOT NULL AND a.site_id = NULLIF(current_setting('app.site_id', true), '');
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION heopress_theme_version_guard() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION heopress_theme_version_insert_guard() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION heopress_theme_asset_guard() FROM PUBLIC;
