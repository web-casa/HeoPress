ALTER TABLE "lumibase_public_sites" ADD COLUMN "extensions" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- HeoPress P12 tasks 2.3–2.5: a plugin's routes, templates and theme components are materialised into the public
-- projection (lumibase_public_sites.extensions), as its structured-data contributions are (P07 task 2.9, migration 0073).
-- Enabling, upgrading, disabling or uninstalling an extension that declares them — enabled and granted `ext:routes`,
-- before or after the change — is recorded by the projection gate too: the CMS materialises the site again and raises
-- its render version in the same transaction.
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
       WHERE x.site_id IS NOT NULL AND x.enabled
         AND ((x.capabilities ? 'seo:structured-data' AND x.manifest ? 'structuredData')
           OR (x.capabilities ? 'ext:routes' AND x.manifest ?| ARRAY['routes', 'components']));
  ELSIF TG_OP = 'DELETE' THEN
    INSERT INTO public.lumibase_projection_dirty (txid, site_id, table_name, op, object_id)
      SELECT txid_current(), x.site_id, TG_TABLE_NAME, 'delete', x.id FROM old_rows x
       WHERE x.site_id IS NOT NULL AND x.enabled
         AND ((x.capabilities ? 'seo:structured-data' AND x.manifest ? 'structuredData')
           OR (x.capabilities ? 'ext:routes' AND x.manifest ?| ARRAY['routes', 'components']));
  ELSE
    INSERT INTO public.lumibase_projection_dirty (txid, site_id, table_name, op, object_id)
      SELECT DISTINCT txid_current(), s.site_id, TG_TABLE_NAME, 'update', n.id
        FROM old_rows o
        JOIN new_rows n ON n.id = o.id
        CROSS JOIN LATERAL (VALUES (o.site_id), (n.site_id)) AS s(site_id)
       WHERE s.site_id IS NOT NULL
         AND ((o.enabled AND ((o.capabilities ? 'seo:structured-data' AND o.manifest ? 'structuredData')
                           OR (o.capabilities ? 'ext:routes' AND o.manifest ?| ARRAY['routes', 'components'])))
           OR (n.enabled AND ((n.capabilities ? 'seo:structured-data' AND n.manifest ? 'structuredData')
                           OR (n.capabilities ? 'ext:routes' AND n.manifest ?| ARRAY['routes', 'components']))))
         AND (o.site_id, o.key, o.name, o.version, o.enabled, o.capabilities, o.manifest)
             IS DISTINCT FROM (n.site_id, n.key, n.name, n.version, n.enabled, n.capabilities, n.manifest);
  END IF;
  RETURN NULL;
END $function$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.heopress_extensions_projection_mark() FROM PUBLIC;
--> statement-breakpoint
-- Sites with an enabled plugin declaring routes or components already: a background refresh materialises them.
DO $$
DECLARE
  s text;
BEGIN
  FOR s IN SELECT id FROM public.lumibase_sites ORDER BY id LOOP
    PERFORM set_config('app.site_id', s, true);
    IF EXISTS (SELECT 1 FROM public.lumibase_extensions x
                WHERE x.site_id = s AND x.enabled AND x.capabilities ? 'ext:routes' AND x.manifest ?| ARRAY['routes', 'components'])
       AND NOT EXISTS (SELECT 1 FROM public.lumibase_projection_rebuilds WHERE site_id = s AND reason = 'refresh: structured data') THEN
      INSERT INTO public.lumibase_projection_rebuilds (site_id, reason) VALUES (s, 'refresh: structured data');
    END IF;
  END LOOP;
  PERFORM set_config('app.site_id', '', true);
END $$;
