-- HeoPress P07 task 6.4 (Codex review of batch 11, round 3): the reconciliation of AI traffic rows, completed and repeatable.
--
--   * Answers of 400 or more that 0085 kept under their own path are moved under `(not found)`: the details (their status
--     is known), and the day totals by those details (the days still holding details; older totals cannot be told apart).
--   * `p_since`: only the days from then on; null: every day. `p_site`: that site only; null: every site. Run here once for
--     everything, the tables locked against new writes until this migration commits; then hourly by the CMS for each site
--     from yesterday on (`purgeCrawlHits`): a hit a writer of the previous definition was still making while this
--     migration ran (a call keeps the definition it started with) is brought within the rules within the hour.
--   * The day path lists serve today's bound only: kept from yesterday on, older ones removed.
CREATE OR REPLACE FUNCTION public.lumibase_crawl_traffic_reconcile(p_since date DEFAULT NULL, p_site text DEFAULT NULL)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
DECLARE
  s text;
  d record;
  e record;
  v_from date := coalesce(p_since, '-infinity'::date);
BEGIN
  FOR s IN SELECT id FROM public.lumibase_sites WHERE p_site IS NULL OR id = p_site LOOP
    PERFORM pg_catalog.set_config('app.site_id', s, true);
    DELETE FROM public.lumibase_crawl_hits h
     WHERE h.site_id = s AND h.at >= v_from AND NOT public.lumibase_ai_agent_known(h.kind, h.agent, h.operator, h.purpose);
    DELETE FROM public.lumibase_crawl_daily c
     WHERE c.site_id = s AND c.day >= v_from AND NOT public.lumibase_ai_agent_known(c.kind, c.agent, c.operator, nullif(c.purpose, ''));
    -- Error answers kept under their own path: their day totals moved under `(not found)`, then the details.
    FOR e IN
      SELECT (h.at AT TIME ZONE 'UTC')::date AS day, h.kind, h.agent, h.operator, coalesce(h.purpose, '') AS purpose, h.resource, h.path, count(*)::int AS n
        FROM public.lumibase_crawl_hits h
       WHERE h.site_id = s AND h.at >= v_from AND h.status >= 400 AND h.path <> '(not found)'
       GROUP BY 1, h.kind, h.agent, h.operator, h.purpose, h.resource, h.path
    LOOP
      UPDATE public.lumibase_crawl_daily c SET hits = c.hits - least(c.hits, e.n)
       WHERE c.site_id = s AND c.day = e.day AND c.kind = e.kind AND c.agent = e.agent AND c.resource = e.resource AND c.path = e.path;
      INSERT INTO public.lumibase_crawl_daily (site_id, day, kind, agent, operator, purpose, resource, path, hits)
        VALUES (s, e.day, e.kind, e.agent, e.operator, e.purpose, e.resource, '(not found)', e.n)
        ON CONFLICT (site_id, day, kind, agent, resource, path) DO UPDATE SET hits = public.lumibase_crawl_daily.hits + excluded.hits;
    END LOOP;
    UPDATE public.lumibase_crawl_hits h SET path = '(not found)'
     WHERE h.site_id = s AND h.at >= v_from AND h.status >= 400 AND h.path <> '(not found)';
    DELETE FROM public.lumibase_crawl_daily c WHERE c.site_id = s AND c.day >= v_from AND c.hits <= 0;
    -- Days past the bound: the 10,000 most read paths kept, the rest folded into `(other)`.
    FOR d IN
      SELECT c.day FROM public.lumibase_crawl_daily c
       WHERE c.site_id = s AND c.day >= v_from AND c.path NOT IN ('(not found)', '(other)')
       GROUP BY c.day HAVING count(DISTINCT c.path) > 10000
    LOOP
      PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crawl-daily:' || s || ':' || d.day::text, 0));
      CREATE TEMP TABLE IF NOT EXISTS heopress_crawl_keep (path text PRIMARY KEY) ON COMMIT DROP;
      DELETE FROM heopress_crawl_keep;
      INSERT INTO heopress_crawl_keep
        SELECT c.path FROM public.lumibase_crawl_daily c
         WHERE c.site_id = s AND c.day = d.day AND c.path NOT IN ('(not found)', '(other)')
         GROUP BY c.path ORDER BY sum(c.hits) DESC, c.path LIMIT 10000;
      INSERT INTO public.lumibase_crawl_daily (site_id, day, kind, agent, operator, purpose, resource, path, hits)
        SELECT s, d.day, c.kind, c.agent, c.operator, c.purpose, c.resource, '(other)', sum(c.hits)::int
          FROM public.lumibase_crawl_daily c
         WHERE c.site_id = s AND c.day = d.day AND c.path NOT IN ('(not found)', '(other)') AND c.path NOT IN (SELECT path FROM heopress_crawl_keep)
         GROUP BY c.kind, c.agent, c.operator, c.purpose, c.resource
        ON CONFLICT (site_id, day, kind, agent, resource, path) DO UPDATE SET hits = public.lumibase_crawl_daily.hits + excluded.hits;
      DELETE FROM public.lumibase_crawl_daily c
       WHERE c.site_id = s AND c.day = d.day AND c.path NOT IN ('(not found)', '(other)') AND c.path NOT IN (SELECT path FROM heopress_crawl_keep);
      DELETE FROM public.lumibase_crawl_daily_paths p
       WHERE p.site_id = s AND p.day = d.day AND p.path NOT IN (SELECT path FROM heopress_crawl_keep);
    END LOOP;
    -- The path lists: from yesterday on only (today's bound is all they serve), as the totals hold them (a path moved
    -- under `(not found)` or `(other)` no longer counts against the bound).
    DELETE FROM public.lumibase_crawl_daily_paths p
     WHERE p.site_id = s AND p.day < ((now() AT TIME ZONE 'UTC')::date - 1);
    DELETE FROM public.lumibase_crawl_daily_paths p
     WHERE p.site_id = s AND p.day >= greatest(v_from, (now() AT TIME ZONE 'UTC')::date - 1)
       AND NOT EXISTS (SELECT 1 FROM public.lumibase_crawl_daily c WHERE c.site_id = s AND c.day = p.day AND c.path = p.path);
    INSERT INTO public.lumibase_crawl_daily_paths (site_id, day, path)
      SELECT DISTINCT c.site_id, c.day, c.path FROM public.lumibase_crawl_daily c
       WHERE c.site_id = s AND c.day >= greatest(v_from, (now() AT TIME ZONE 'UTC')::date - 1) AND c.path NOT IN ('(not found)', '(other)')
    ON CONFLICT DO NOTHING;
  END LOOP;
END $function$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.lumibase_crawl_traffic_reconcile(date, text) FROM PUBLIC;
--> statement-breakpoint
DROP FUNCTION IF EXISTS public.lumibase_crawl_traffic_reconcile();
--> statement-breakpoint
-- No new write between the reconciliation and this migration's commit (waits for the writes under way).
LOCK TABLE public.lumibase_crawl_hits, public.lumibase_crawl_daily, public.lumibase_crawl_daily_paths IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
SELECT public.lumibase_crawl_traffic_reconcile(NULL, NULL);
