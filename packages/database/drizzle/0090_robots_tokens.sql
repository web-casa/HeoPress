-- HeoPress P07 tasks 2.8, 4.1 (Codex review of batch 12): an item's own indexing setting (`seo_robots`) read in the
-- database exactly as `@heopress/seo-geo` `parseItemRobots` reads it, so the discovery outputs' bounded scans select
-- the rows the exact decision can list — and an index can hold the few a collection not indexed by default can list.
--
--   * Tokens: comma-separated, ASCII letters lowered, ASCII white space around each removed, empty ones dropped, each once.
--   * `noindex`: the token `noindex` is there.
--   * Own `index`: the token `index`, not `noindex`, and not exactly `index` and `follow` (the preset's value, which sets
--     nothing).
-- Immutable: usable in an index predicate. A test keeps them equal to `parseItemRobots` on generated values.
CREATE OR REPLACE FUNCTION public.lumibase_robots_tokens(p_value text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
  SELECT coalesce(array_agg(DISTINCT t ORDER BY t), '{}'::text[])
    FROM (
      SELECT regexp_replace(translate(raw, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), '^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$', '', 'g') AS t
        FROM unnest(string_to_array(coalesce(p_value, ''), ',')) AS raw
    ) x
   WHERE t <> ''
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.lumibase_robots_noindex(p_value text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
  SELECT 'noindex' = ANY(public.lumibase_robots_tokens(p_value))
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.lumibase_robots_own_index(p_value text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE PARALLEL SAFE
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
  SELECT 'index' = ANY(t) AND NOT 'noindex' = ANY(t) AND NOT (cardinality(t) = 2 AND 'follow' = ANY(t))
    FROM (SELECT public.lumibase_robots_tokens(p_value) AS t) x
$function$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.lumibase_robots_tokens(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.lumibase_robots_noindex(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.lumibase_robots_own_index(text) FROM PUBLIC;
