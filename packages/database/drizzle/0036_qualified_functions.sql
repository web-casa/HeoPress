-- HeoPress P06 batch 4 review round 4 (Codex): the application role may create objects in public, so no
-- function of ours searches public at all. Each is redefined with search_path = pg_catalog, pg_temp and
-- every table and function of ours named as public.<name>: a function the caller created in public (an
-- overload such as public.unnest(text[])) can never be picked, and a temporary object never shadows ours.
-- Generated from the definitions of migrations 0001–0035 (bodies unchanged apart from the qualification).
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_bump_access_generation()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  INSERT INTO public.lumibase_access_generations AS g (site_id, generation, updated_at)
  SELECT s.site_id, 1, now()
    FROM (
      SELECT to_jsonb(r) ->> 'site_id' AS site_id FROM changed_rows r
    ) s
    JOIN public.lumibase_sites ON lumibase_sites.id = s.site_id
   GROUP BY s.site_id
  ON CONFLICT (site_id) DO UPDATE SET generation = g.generation + 1, updated_at = now();
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_bump_access_generation_by_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  INSERT INTO public.lumibase_access_generations AS g (site_id, generation, updated_at)
  SELECT ro.site_id, 1, now()
    FROM (SELECT DISTINCT to_jsonb(r) ->> 'role_id' AS role_id FROM changed_rows r) s
    JOIN public.lumibase_roles ro ON ro.id = s.role_id
   GROUP BY ro.site_id
  ON CONFLICT (site_id) DO UPDATE SET generation = g.generation + 1, updated_at = now();
  RETURN NULL;
END;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_projection_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
DECLARE
  base text[];
  closure text[];
  prev text := current_setting('app.site_id', true);
  s text;
  extra text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.lumibase_projection_dirty d WHERE d.seq = NEW.seq) THEN
    RETURN NULL; -- taken by the CMS, or already handled by an earlier firing in this transaction
  END IF;
  IF coalesce(current_setting('heopress.projection_gate', true), '') = 'strict' THEN
    RAISE EXCEPTION 'public projection not refreshed for % (transaction %)', NEW.table_name, NEW.txid USING ERRCODE = 'check_violation';
  END IF;
  SELECT array_agg(DISTINCT x) INTO base FROM (
    SELECT d.site_id AS x FROM public.lumibase_projection_dirty d WHERE d.txid = NEW.txid AND d.site_id IS NOT NULL
    UNION SELECT jsonb_array_elements_text(coalesce(d.old->'site_ids', '[]'::jsonb) || coalesce(d.new->'site_ids', '[]'::jsonb))
      FROM public.lumibase_projection_dirty d WHERE d.txid = NEW.txid AND d.table_name = 'lumibase_translation_groups'
  ) q WHERE x IS NOT NULL;
  closure := coalesce(base, ARRAY[]::text[]);
  -- Sites sharing a group with any of them (read in each site's scope: RLS may be on).
  FOREACH s IN ARRAY coalesce(base, ARRAY[]::text[]) LOOP
    PERFORM set_config('app.site_id', s, true);
    SELECT array_agg(DISTINCT x) INTO extra FROM (
      SELECT unnest(g.site_ids) AS x FROM public.lumibase_translation_groups g
       WHERE s = ANY (g.site_ids)
          OR g.id IN (SELECT (d.old->>'group_id') FROM public.lumibase_projection_dirty d WHERE d.txid = NEW.txid AND d.table_name = 'lumibase_translation_group_members'
                      UNION SELECT (d.new->>'group_id') FROM public.lumibase_projection_dirty d WHERE d.txid = NEW.txid AND d.table_name = 'lumibase_translation_group_members')
    ) q;
    closure := closure || coalesce(extra, ARRAY[]::text[]);
  END LOOP;
  PERFORM set_config('app.site_id', coalesce(prev, ''), true);
  INSERT INTO public.lumibase_projection_rebuilds (site_id, reason)
    SELECT DISTINCT c, 'unflushed: ' || (SELECT string_agg(DISTINCT d.table_name, ',') FROM public.lumibase_projection_dirty d WHERE d.txid = NEW.txid)
      FROM unnest(closure) c
     WHERE EXISTS (SELECT 1 FROM public.lumibase_sites WHERE id = c);
  DELETE FROM public.lumibase_projection_dirty d WHERE d.txid = NEW.txid;
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_projection_mark()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
DECLARE
  site_col text := TG_ARGV[0];
  id_col text := TG_ARGV[1];
  cols text[] := TG_ARGV[2:];
  pick text := 'jsonb_build_object(' || (SELECT string_agg(format('%L, x.%I', c, c), ', ') FROM unnest(cols) c) || ')';
BEGIN
  IF TG_OP = 'INSERT' THEN
    EXECUTE format(
      'INSERT INTO public.lumibase_projection_dirty (txid, site_id, table_name, op, object_id, new)
         SELECT txid_current(), x.%I::text, %L, ''insert'', x.%I::text, %s FROM new_rows x',
      site_col, TG_TABLE_NAME, id_col, pick);
  ELSIF TG_OP = 'DELETE' THEN
    EXECUTE format(
      'INSERT INTO public.lumibase_projection_dirty (txid, site_id, table_name, op, object_id, old)
         SELECT txid_current(), x.%I::text, %L, ''delete'', x.%I::text, %s FROM old_rows x',
      site_col, TG_TABLE_NAME, id_col, pick);
  ELSE
    EXECUTE format(
      'INSERT INTO public.lumibase_projection_dirty (txid, site_id, table_name, op, object_id, old, new)
         SELECT txid_current(), n.%I::text, %L, ''update'', n.%I::text, o.j, n.j
           FROM (SELECT x.%I AS k, x.%I AS %I, %s AS j FROM old_rows x) o
           JOIN (SELECT x.%I AS k, x.%I AS %I, %s AS j FROM new_rows x) n ON n.k = o.k
          WHERE o.j IS DISTINCT FROM n.j',
      site_col, TG_TABLE_NAME, 'k',
      id_col, site_col, site_col, pick,
      id_col, site_col, site_col, pick);
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_projection_take()
 RETURNS SETOF public.lumibase_projection_dirty
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
  DELETE FROM public.lumibase_projection_dirty WHERE txid = txid_current() RETURNING *;
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_seal_theme_version(vid text, expected_site text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
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
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_site_theme_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.lumibase_theme_versions WHERE id = NEW.theme_version_id AND site_id = NEW.site_id AND sealed_at IS NOT NULL AND published_at IS NOT NULL) THEN
    RAISE EXCEPTION 'a site can only point at one of its own published theme versions' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_theme_asset_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
DECLARE
  vid text := CASE WHEN TG_OP = 'INSERT' THEN NEW.version_id ELSE OLD.version_id END;
  sealed timestamptz;
  found_version boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND (NEW.version_id <> OLD.version_id OR NEW.site_id <> OLD.site_id OR NEW.path <> OLD.path) THEN
    RAISE EXCEPTION 'theme asset identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  SELECT sealed_at, true INTO sealed, found_version FROM public.lumibase_theme_versions WHERE id = vid FOR SHARE;
  -- Removed with its version or its site (the cascade runs after their rows are gone): allowed.
  IF TG_OP = 'DELETE' AND (found_version IS NULL OR NOT EXISTS (SELECT 1 FROM public.lumibase_sites WHERE id = OLD.site_id)) THEN
    RETURN OLD;
  END IF;
  IF sealed IS NOT NULL THEN
    RAISE EXCEPTION 'theme version % is sealed: its assets cannot change', vid USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_theme_version_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.published_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.lumibase_sites WHERE id = OLD.site_id) THEN
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
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_theme_version_insert_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  IF NEW.sealed_at IS NOT NULL OR NEW.content_hash IS NOT NULL OR NEW.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'a theme version is created unsealed and unpublished' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_translation_group_assert(gid text, site text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
DECLARE
  prev text := current_setting('app.site_id', true);
  listed text[];
  seen boolean;
  s text;
BEGIN
  PERFORM set_config('app.site_id', site, true);
  SELECT g.site_ids INTO listed FROM public.lumibase_translation_groups g WHERE g.id = gid;
  seen := FOUND; -- saved first: PERFORM below resets FOUND
  PERFORM set_config('app.site_id', coalesce(prev, ''), true);
  IF NOT seen THEN
    IF public.heopress_translation_group_has_member(gid, site) THEN
      RAISE EXCEPTION 'site % has members in translation group % that does not list it', site, gid USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;
  FOREACH s IN ARRAY listed LOOP
    IF NOT public.heopress_translation_group_has_member(gid, s) THEN
      RAISE EXCEPTION 'translation group % lists site % without a member there', gid, s USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF NOT (site = ANY (listed)) AND public.heopress_translation_group_has_member(gid, site) THEN
    RAISE EXCEPTION 'site % has members in translation group % that does not list it', site, gid USING ERRCODE = 'check_violation';
  END IF;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_translation_group_has_member(gid text, site text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
DECLARE
  prev text := current_setting('app.site_id', true);
  found boolean;
BEGIN
  PERFORM set_config('app.site_id', site, true);
  SELECT EXISTS (SELECT 1 FROM public.lumibase_translation_group_members m WHERE m.group_id = gid AND m.site_id = site) INTO found;
  PERFORM set_config('app.site_id', coalesce(prev, ''), true);
  RETURN found;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_translation_group_lists(gid text, site text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
DECLARE
  prev text := current_setting('app.site_id', true);
  found boolean;
BEGIN
  PERFORM set_config('app.site_id', site, true);
  SELECT EXISTS (SELECT 1 FROM public.lumibase_translation_groups g WHERE g.id = gid AND site = ANY (g.site_ids)) INTO found;
  PERFORM set_config('app.site_id', coalesce(prev, ''), true);
  RETURN found;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_translation_group_owner_fixed()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  IF NEW.site_id IS DISTINCT FROM OLD.site_id THEN
    RAISE EXCEPTION 'translation group % cannot change its creating site', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_translation_group_sites_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
DECLARE
  s text;
BEGIN
  PERFORM public.heopress_translation_group_assert(NEW.id, NEW.site_id);
  IF TG_OP = 'UPDATE' THEN
    FOREACH s IN ARRAY OLD.site_ids LOOP
      IF NOT (s = ANY (NEW.site_ids)) THEN
        PERFORM public.heopress_translation_group_assert(NEW.id, s);
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_translation_member_group_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  IF NOT public.heopress_translation_group_lists(NEW.group_id, NEW.site_id) THEN
    RAISE EXCEPTION 'translation group % does not list site %', NEW.group_id, NEW.site_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_translation_member_sites_check()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM public.heopress_translation_group_assert(OLD.group_id, OLD.site_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM public.heopress_translation_group_assert(NEW.group_id, NEW.site_id);
  END IF;
  RETURN NULL;
END $function$;
