-- HeoPress P06 batch 4 review round 2 (Codex): SECURITY DEFINER functions resolve names with a trusted
-- search path — pg_catalog, then public, then pg_temp last — so a temporary table of the caller can never
-- stand in for one of ours (PostgreSQL's warning on SECURITY DEFINER functions).
ALTER FUNCTION heopress_projection_mark() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION heopress_projection_check() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
ALTER FUNCTION heopress_projection_take() SET search_path = pg_catalog, public, pg_temp;
--> statement-breakpoint
-- Sealing names the caller's site: the version must be of that site, and of the transaction's site scope
-- when one is set (an owner that is a superuser is not bound by row-level security).
DROP FUNCTION heopress_seal_theme_version(text);
--> statement-breakpoint
CREATE FUNCTION heopress_seal_theme_version(vid text, expected_site text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v public.lumibase_theme_versions%ROWTYPE;
  manifest_paths text[];
  hash text;
BEGIN
  SELECT * INTO v FROM public.lumibase_theme_versions WHERE id = vid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no theme version %', vid USING ERRCODE = 'no_data_found'; END IF;
  -- The caller's own site only: row-level security does not bind an owner that is a superuser.
  IF v.site_id IS DISTINCT FROM expected_site
     OR coalesce(NULLIF(current_setting('app.site_id', true), ''), expected_site) IS DISTINCT FROM expected_site THEN
    RAISE EXCEPTION 'no theme version % on this site', vid USING ERRCODE = 'no_data_found';
  END IF;
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
    FULL JOIN (SELECT * FROM public.lumibase_theme_assets WHERE version_id = vid) a ON a.path = e->>'path'
    WHERE e IS NULL OR a.path IS NULL
       OR a.sha256 IS DISTINCT FROM e->>'sha256' OR a.content_type IS DISTINCT FROM e->>'contentType'
       OR octet_length(a.bytes) IS DISTINCT FROM (e->>'size')::bigint OR a.site_id IS DISTINCT FROM v.site_id
  ) THEN
    RAISE EXCEPTION 'asset manifest and assets differ' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT coalesce(sum(octet_length(bytes)), 0) FROM public.lumibase_theme_assets WHERE version_id = vid) > 20971520 THEN
    RAISE EXCEPTION 'theme assets exceed 20 MB' USING ERRCODE = 'check_violation';
  END IF;
  hash := encode(sha256(convert_to(v.templates::text || '|' || v.assets::text, 'UTF8')), 'hex');
  UPDATE public.lumibase_theme_versions SET content_hash = hash, sealed_at = now() WHERE id = vid;
  RETURN hash;
END $$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION heopress_seal_theme_version(text, text) FROM PUBLIC;
