-- HeoPress P14 task 2.1 (ADR-0024, spec platform/database-privileges): the runtime creates no database object. The tables
-- it needs at run time — a vector space per embedding model, a materialized collection's physical table — are created,
-- emptied and dropped by these owner-owned SECURITY DEFINER entries. Each pins its search path, qualifies every object,
-- checks every argument, and enables row-level security (the site policy) on what it creates. EXECUTE is revoked from
-- PUBLIC; the application role gets it from `app-role` (EXECUTE on the functions of `public`), the rendering role never.

-- A vector space: the same id as `spaceIdFor` in packages/runtime/src/vector/store.ts — a slug of the lowercased model
-- (runs of other characters become one underscore, one leading and trailing underscore removed, at most 24 characters,
-- `model` when empty), the dimension, and the first 8 hex digits of SHA-256 over model, NUL, dimension.
CREATE OR REPLACE FUNCTION public.heopress_vector_space_id(model text, dimension integer) RETURNS text
  LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, pg_temp AS $$
    SELECT coalesce(nullif(left(regexp_replace(regexp_replace(lower(model), '[^a-z0-9]+', '_', 'g'), '^_|_$', '', 'g'), 24), ''), 'model')
           || '_' || dimension::text || '_'
           || left(encode(sha256(convert_to(model, 'UTF8') || '\x00'::bytea || convert_to(dimension::text, 'UTF8')), 'hex'), 8);
  $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_ensure_vector_space(model text, dimension integer) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  space_id text;
  tbl text;
  column_type text;
  ext_schema text;
  owner_ok boolean;
BEGIN
  -- Printable ASCII without spaces, as model names are (`text-embedding-3-small`, `BAAI/bge-m3`, `nomic-embed-text:v1.5`).
  IF model IS NULL OR model !~ '^[!-~]{1,200}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'heopress: invalid embedding model name';
  END IF;
  IF dimension IS NULL OR dimension < 1 OR dimension > 4000 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'heopress: embedding dimension must be between 1 and 4000';
  END IF;
  SELECT n.nspname INTO ext_schema FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'vector';
  IF ext_schema IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '55000', MESSAGE = 'heopress: vector search needs the pgvector extension';
  END IF;
  space_id := public.heopress_vector_space_id(model, dimension);
  tbl := 'lumibase_vectors_' || space_id;
  column_type := CASE WHEN dimension <= 2000 THEN 'vector' ELSE 'halfvec' END;
  -- One creation of a space at a time, across processes.
  PERFORM pg_advisory_xact_lock(hashtextextended('heopress:vector-space:' || space_id, 0));
  SELECT c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user) INTO owner_ok
    FROM pg_class c WHERE c.oid = to_regclass('public.' || quote_ident(tbl));
  IF owner_ok IS FALSE THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = format('heopress: %s belongs to another role; run app-role to hand it to the owner', tbl);
  END IF;
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I (
       site_id text NOT NULL REFERENCES public.lumibase_sites(id) ON DELETE CASCADE,
       source_type text NOT NULL,
       source_id text NOT NULL,
       chunk integer NOT NULL DEFAULT 0,
       purpose text NOT NULL CHECK (purpose IN (''public_answer'', ''internal_writing'')),
       revision text NOT NULL,
       model text NOT NULL CHECK (model = %L),
       dimension integer NOT NULL CHECK (dimension = %s),
       permission_generation bigint NOT NULL,
       content text NOT NULL,
       metadata jsonb NOT NULL DEFAULT ''{}''::jsonb,
       embedding %I.%I(%s) NOT NULL,
       updated_at timestamptz NOT NULL DEFAULT now(),
       PRIMARY KEY (site_id, source_type, source_id, chunk, purpose)
     )', tbl, model, dimension, ext_schema, column_type, dimension);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I USING hnsw (embedding %I.%I)',
    tbl || '_hnsw', tbl, ext_schema, column_type || '_cosine_ops');
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS site_isolation ON public.%I', tbl);
  EXECUTE format('CREATE POLICY site_isolation ON public.%I FOR ALL USING (site_id = public.app_site_id()) WITH CHECK (site_id = public.app_site_id())', tbl);
  INSERT INTO public.lumibase_vector_spaces (id, model, dimension, column_type, table_name)
    VALUES (space_id, model, dimension, column_type, tbl)
    ON CONFLICT (id) DO NOTHING;
  RETURN tbl;
END $$;--> statement-breakpoint
-- A materialized collection's physical table: `mat_` and the id lowercased, other than [a-z0-9_] removed, at most 59
-- characters (`sanitizeTableName`, apps/cms/src/services/materialize-service.ts). The materialization must exist and
-- belong to the caller's site scope: no site reaches another site's table through these entries.
CREATE OR REPLACE FUNCTION public.heopress_materialize_table(materialization_id text) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  clean text;
BEGIN
  IF materialization_id IS NULL OR length(materialization_id) > 128 THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'heopress: invalid materialized collection id';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.lumibase_materialized_collections m
     WHERE m.id = materialization_id AND m.site_id = public.app_site_id()
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '42704', MESSAGE = 'heopress: no such materialized collection in this site';
  END IF;
  clean := left(regexp_replace(lower(materialization_id), '[^a-z0-9_]', '', 'g'), 59);
  IF clean = '' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'heopress: invalid materialized collection id';
  END IF;
  RETURN 'mat_' || clean;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_materialize_create(materialization_id text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  tbl text := public.heopress_materialize_table(materialization_id);
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = to_regclass('public.' || quote_ident(tbl))
                AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = current_user)) THEN
    RAISE EXCEPTION USING ERRCODE = '42501',
      MESSAGE = format('heopress: %s belongs to another role; run app-role to hand it to the owner', tbl);
  END IF;
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.%I (
       id text PRIMARY KEY,
       site_id text NOT NULL,
       collection_id text NOT NULL,
       status text DEFAULT ''draft'',
       data jsonb DEFAULT ''{}'',
       sort integer DEFAULT 0,
       user_created text,
       user_updated text,
       created_at timestamptz DEFAULT now(),
       updated_at timestamptz DEFAULT now()
     )', tbl);
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I (site_id, status)', tbl || '_site_idx', tbl);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY', tbl);
  EXECUTE format('DROP POLICY IF EXISTS site_isolation ON public.%I', tbl);
  EXECUTE format('CREATE POLICY site_isolation ON public.%I FOR ALL USING (site_id = public.app_site_id()) WITH CHECK (site_id = public.app_site_id())', tbl);
  RETURN tbl;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_materialize_truncate(materialization_id text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  tbl text := public.heopress_materialize_table(materialization_id);
BEGIN
  IF to_regclass('public.' || quote_ident(tbl)) IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42P01', MESSAGE = format('heopress: %s does not exist', tbl);
  END IF;
  EXECUTE format('TRUNCATE TABLE public.%I', tbl);
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_materialize_drop(materialization_id text) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  tbl text := public.heopress_materialize_table(materialization_id);
BEGIN
  EXECUTE format('DROP TABLE IF EXISTS public.%I', tbl);
END $$;--> statement-breakpoint
-- Change events across sites (HeoPress P14 task 1.5, ADR-0023): an event consumer that follows every site finds the next
-- events' positions here — ids, sites and positions only, never their content — and reads each site's events in that
-- site's scope. Only events of transactions older than every one still running, as consumers read them.
CREATE OR REPLACE FUNCTION public.heopress_change_event_positions(after_txid xid8, after_seq bigint, only_site text, max_rows integer)
  RETURNS TABLE (id text, site_id text, txid xid8, seq bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT e.id, e.site_id, e.txid, e.seq FROM public.lumibase_cdc_change_events e
     WHERE e.txid < pg_snapshot_xmin(pg_current_snapshot())
       AND (after_txid IS NULL OR (e.txid, e.seq) > (after_txid, coalesce(after_seq, 0)))
       AND (only_site IS NULL OR e.site_id = only_site)
     ORDER BY e.txid, e.seq
     LIMIT least(greatest(coalesce(max_rows, 100), 1), 1000);
  $$;--> statement-breakpoint
-- The last such event (where a consumer seen for the first time starts).
CREATE OR REPLACE FUNCTION public.heopress_change_event_head(only_site text)
  RETURNS TABLE (txid xid8, seq bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT e.txid, e.seq FROM public.lumibase_cdc_change_events e
     WHERE e.txid < pg_snapshot_xmin(pg_current_snapshot())
       AND (only_site IS NULL OR e.site_id = only_site)
     ORDER BY e.txid DESC, e.seq DESC
     LIMIT 1;
  $$;--> statement-breakpoint
-- Sites with an active push subscription (webhook or extension): the change feed's dispatch pass, every tick, finds
-- them here and reads each one's subscriptions in its scope. Site ids only.
CREATE OR REPLACE FUNCTION public.heopress_cdc_push_site_ids()
  RETURNS TABLE (site_id text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT DISTINCT s.site_id FROM public.lumibase_cdc_subscriptions s WHERE s.status = 'active' AND s.kind <> 'pull';
  $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.heopress_cdc_push_site_ids() FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.heopress_change_event_positions(xid8, bigint, text, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.heopress_change_event_head(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.heopress_vector_space_id(text, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.heopress_ensure_vector_space(text, integer) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.heopress_materialize_table(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.heopress_materialize_create(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.heopress_materialize_truncate(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.heopress_materialize_drop(text) FROM PUBLIC;
