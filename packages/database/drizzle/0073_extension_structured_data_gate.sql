-- HeoPress P07 task 2.9: an extension's structured-data contributions are materialised into the public projection
-- (lumibase_public_sites.structured, lumibase_public_items.structured). Enabling, upgrading, disabling or uninstalling
-- an extension that contributes — enabled, granted `seo:structured-data` and declaring `structuredData` in its
-- manifest, before or after the change — is recorded by the projection gate: the CMS materialises the site again and
-- raises its render version in the same transaction. Other extension writes (most of them, and the marketplace's
-- catalogue rows, which have no site) are not recorded.
CREATE OR REPLACE FUNCTION public.heopress_extensions_projection_mark()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.lumibase_projection_dirty (txid, site_id, table_name, op, object_id)
      SELECT txid_current(), x.site_id, TG_TABLE_NAME, 'insert', x.id FROM new_rows x
       WHERE x.site_id IS NOT NULL AND x.enabled AND x.capabilities ? 'seo:structured-data' AND x.manifest ? 'structuredData';
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.lumibase_projection_dirty (txid, site_id, table_name, op, object_id)
      SELECT txid_current(), x.site_id, TG_TABLE_NAME, 'delete', x.id FROM old_rows x
       WHERE x.site_id IS NOT NULL AND x.enabled AND x.capabilities ? 'seo:structured-data' AND x.manifest ? 'structuredData';
  ELSE
    INSERT INTO public.lumibase_projection_dirty (txid, site_id, table_name, op, object_id)
      SELECT DISTINCT txid_current(), s.site_id, TG_TABLE_NAME, 'update', n.id
        FROM old_rows o
        JOIN new_rows n ON n.id = o.id
        CROSS JOIN LATERAL (VALUES (o.site_id), (n.site_id)) AS s(site_id)
       WHERE s.site_id IS NOT NULL
         AND ((o.enabled AND o.capabilities ? 'seo:structured-data' AND o.manifest ? 'structuredData')
           OR (n.enabled AND n.capabilities ? 'seo:structured-data' AND n.manifest ? 'structuredData'))
         AND (o.site_id, o.key, o.name, o.version, o.enabled, o.capabilities, o.manifest)
             IS DISTINCT FROM (n.site_id, n.key, n.name, n.version, n.enabled, n.capabilities, n.manifest);
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.heopress_extensions_projection_mark() FROM PUBLIC;
--> statement-breakpoint
DO $$
DECLARE
  op text;
BEGIN
  FOREACH op IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.lumibase_extensions', 'projection_' || lower(op));
    EXECUTE format(
      'CREATE TRIGGER %I AFTER %s ON public.lumibase_extensions REFERENCING %s FOR EACH STATEMENT EXECUTE FUNCTION public.heopress_extensions_projection_mark()',
      'projection_' || lower(op), op,
      CASE op WHEN 'INSERT' THEN 'NEW TABLE AS new_rows' WHEN 'DELETE' THEN 'OLD TABLE AS old_rows' ELSE 'OLD TABLE AS old_rows NEW TABLE AS new_rows' END);
  END LOOP;
END $$;
--> statement-breakpoint
-- Sites with a contributing extension already: a background refresh materialises its contributions.
DO $$
DECLARE
  s text;
BEGIN
  FOR s IN SELECT id FROM public.lumibase_sites ORDER BY id LOOP
    PERFORM set_config('app.site_id', s, true);
    IF EXISTS (SELECT 1 FROM public.lumibase_extensions x
                WHERE x.site_id = s AND x.enabled AND x.capabilities ? 'seo:structured-data' AND x.manifest ? 'structuredData')
       AND NOT EXISTS (SELECT 1 FROM public.lumibase_projection_rebuilds WHERE site_id = s AND reason = 'refresh: structured data') THEN
      INSERT INTO public.lumibase_projection_rebuilds (site_id, reason) VALUES (s, 'refresh: structured data');
    END IF;
  END LOOP;
  PERFORM set_config('app.site_id', '', true);
END $$;
