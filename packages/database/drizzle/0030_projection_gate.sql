-- The public projection's maintenance gate (HeoPress P06 task 1.2; design R13, R25, R26, R31, R38).
-- Statement triggers record what a transaction changed in the tables the public output derives from;
-- the CMS takes those records (heopress_projection_take) and refreshes the projection before it
-- commits. Whatever is left at commit becomes a rebuild mark for every site depending on it (or an
-- error when heopress.projection_gate = 'strict'), so a write path that forgets the projection makes
-- its sites go into maintenance instead of serving stale public data.

-- Record changed rows. Arguments: site id column, object id column, then the columns whose change
-- matters (UPDATE only records rows where one of them changed; an empty statement records nothing).
CREATE OR REPLACE FUNCTION heopress_projection_mark() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  site_col text := TG_ARGV[0];
  id_col text := TG_ARGV[1];
  cols text[] := TG_ARGV[2:];
  pick text := 'jsonb_build_object(' || (SELECT string_agg(format('%L, x.%I', c, c), ', ') FROM unnest(cols) c) || ')';
BEGIN
  IF TG_OP = 'INSERT' THEN
    EXECUTE format(
      'INSERT INTO lumibase_projection_dirty (txid, site_id, table_name, op, object_id, new)
         SELECT txid_current(), x.%I::text, %L, ''insert'', x.%I::text, %s FROM new_rows x',
      site_col, TG_TABLE_NAME, id_col, pick);
  ELSIF TG_OP = 'DELETE' THEN
    EXECUTE format(
      'INSERT INTO lumibase_projection_dirty (txid, site_id, table_name, op, object_id, old)
         SELECT txid_current(), x.%I::text, %L, ''delete'', x.%I::text, %s FROM old_rows x',
      site_col, TG_TABLE_NAME, id_col, pick);
  ELSE
    EXECUTE format(
      'INSERT INTO lumibase_projection_dirty (txid, site_id, table_name, op, object_id, old, new)
         SELECT txid_current(), n.%I::text, %L, ''update'', n.%I::text, o.j, n.j
           FROM (SELECT x.%I AS k, x.%I AS %I, %s AS j FROM old_rows x) o
           JOIN (SELECT x.%I AS k, x.%I AS %I, %s AS j FROM new_rows x) n ON n.k = o.k
          WHERE o.j IS DISTINCT FROM n.j',
      site_col, TG_TABLE_NAME, 'k',
      id_col, site_col, site_col, pick,
      id_col, site_col, site_col, pick);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- One trigger per table and operation (transition tables cannot be shared between operations).
DO $$
DECLARE
  t record;
  op text;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('lumibase_items', 'site_id', 'id', ARRAY['site_id', 'collection_id', 'status', 'data', 'deleted_at', 'published_at', 'number']),
    ('lumibase_content_routes', 'site_id', 'item_id', ARRAY['item_id', 'locale', 'path']),
    ('lumibase_redirects', 'site_id', 'id', ARRAY['scope', 'locale', 'from_path', 'match', 'to_path', 'to_locale', 'status']),
    ('lumibase_site_content_settings', 'site_id', 'site_id', ARRAY['available_locales', 'timezone', 'site_type', 'trailing_slash', 'locale_strategy', 'locale_prefix_mode', 'locale_prefixes', 'permalinks', 'allow_cross_site_translations', 'sponsor_disclosure', 'sponsor_rel', 'sponsor_policy_version']),
    ('lumibase_sites', 'id', 'id', ARRAY['name', 'default_language']),
    ('lumibase_site_domains', 'site_id', 'id', ARRAY['hostname', 'status', 'is_primary', 'entry_locale']),
    ('lumibase_collections', 'site_id', 'id', ARRAY['name', 'hidden', 'meta']),
    ('lumibase_fields', 'site_id', 'id', ARRAY['collection_id', 'name', 'type', 'interface', 'hidden', 'encrypted', 'classification', 'options', 'special']),
    ('lumibase_translation_groups', 'site_id', 'id', ARRAY['site_ids', 'source_item_id']),
    ('lumibase_translation_group_members', 'site_id', 'item_id', ARRAY['group_id', 'site_id', 'locale', 'role', 'internal_only'])
  ) AS v(tbl, site_col, id_col, cols)
  LOOP
    FOREACH op IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'projection_' || lower(op), t.tbl);
      EXECUTE format(
        'CREATE TRIGGER %I AFTER %s ON %I REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION heopress_projection_mark(%L, %L, %s)',
        'projection_' || lower(op), op, t.tbl,
        CASE op WHEN 'INSERT' THEN 'NEW TABLE AS new_rows' WHEN 'DELETE' THEN 'OLD TABLE AS old_rows' ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows' END,
        t.site_col, t.id_col,
        (SELECT string_agg(quote_literal(c), ', ') FROM unnest(t.cols) c));
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint

-- Take (and remove) the current transaction's records: the CMS refreshes the projection from them.
CREATE OR REPLACE FUNCTION heopress_projection_take() RETURNS SETOF lumibase_projection_dirty
  LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  DELETE FROM lumibase_projection_dirty WHERE txid = txid_current() RETURNING *;
$$;
--> statement-breakpoint

-- At commit: records still there were not refreshed. Their sites, and every site sharing a translation
-- group with them (old and new memberships), get a rebuild mark; strict mode refuses the commit.
CREATE OR REPLACE FUNCTION heopress_projection_check() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  base text[];
  closure text[];
  prev text := current_setting('app.site_id', true);
  s text;
  extra text[];
BEGIN
  IF NOT EXISTS (SELECT 1 FROM lumibase_projection_dirty d WHERE d.seq = NEW.seq) THEN
    RETURN NULL; -- taken by the CMS, or already handled by an earlier firing in this transaction
  END IF;
  IF coalesce(current_setting('heopress.projection_gate', true), '') = 'strict' THEN
    RAISE EXCEPTION 'public projection not refreshed for % (transaction %)', NEW.table_name, NEW.txid USING ERRCODE = 'check_violation';
  END IF;
  SELECT array_agg(DISTINCT x) INTO base FROM (
    SELECT d.site_id AS x FROM lumibase_projection_dirty d WHERE d.txid = NEW.txid AND d.site_id IS NOT NULL
    UNION SELECT jsonb_array_elements_text(coalesce(d.old->'site_ids', '[]'::jsonb) || coalesce(d.new->'site_ids', '[]'::jsonb))
      FROM lumibase_projection_dirty d WHERE d.txid = NEW.txid AND d.table_name = 'lumibase_translation_groups'
  ) q WHERE x IS NOT NULL;
  closure := coalesce(base, ARRAY[]::text[]);
  -- Sites sharing a group with any of them (read in each site's scope: RLS may be on).
  FOREACH s IN ARRAY coalesce(base, ARRAY[]::text[]) LOOP
    PERFORM set_config('app.site_id', s, true);
    SELECT array_agg(DISTINCT x) INTO extra FROM (
      SELECT unnest(g.site_ids) AS x FROM lumibase_translation_groups g
       WHERE s = ANY (g.site_ids)
          OR g.id IN (SELECT (d.old->>'group_id') FROM lumibase_projection_dirty d WHERE d.txid = NEW.txid AND d.table_name = 'lumibase_translation_group_members'
                      UNION SELECT (d.new->>'group_id') FROM lumibase_projection_dirty d WHERE d.txid = NEW.txid AND d.table_name = 'lumibase_translation_group_members')
    ) q;
    closure := closure || coalesce(extra, ARRAY[]::text[]);
  END LOOP;
  PERFORM set_config('app.site_id', coalesce(prev, ''), true);
  INSERT INTO lumibase_projection_rebuilds (site_id, reason)
    SELECT DISTINCT c, 'unflushed: ' || (SELECT string_agg(DISTINCT d.table_name, ',') FROM lumibase_projection_dirty d WHERE d.txid = NEW.txid)
      FROM unnest(closure) c
     WHERE EXISTS (SELECT 1 FROM lumibase_sites WHERE id = c);
  DELETE FROM lumibase_projection_dirty d WHERE d.txid = NEW.txid;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS projection_check ON lumibase_projection_dirty;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER projection_check AFTER INSERT ON lumibase_projection_dirty
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION heopress_projection_check();
--> statement-breakpoint

-- The redirects the rendering role reads (public columns; the base table is not granted). A view
-- reads its table as the view's owner, whose row-level security may not apply (a superuser owner,
-- or a deployment without the optional policies): the view itself keeps to the current site, and
-- shows nothing outside a site scope.
CREATE OR REPLACE VIEW lumibase_render_redirects WITH (security_barrier) AS
  SELECT site_id, scope, locale, from_path, match, to_path, to_locale, status FROM lumibase_redirects
  WHERE site_id = NULLIF(current_setting('app.site_id', true), '');
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION heopress_projection_mark() FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION heopress_projection_check() FROM PUBLIC;
