-- HeoPress P07 tasks 6.1, 6.4 (Codex review of batch 11, round 2): the AI traffic entry, bounded against any caller.
--
--   * Known agents only: a hit names one of the crawlers (`packages/seo-geo/src/crawlers.ts`, AI purposes) or assistants
--     (`packages/seo-geo/src/ai-traffic.ts`) the renderer knows, with their operator and purpose
--     (`lumibase_ai_agent_known`; a test keeps it equal to the lists, a change of the lists comes with a migration).
--   * A day's 10,000-path bound counts distinct paths (`lumibase_crawl_daily_paths`), whichever agent read them, under a
--     lock of the site's day: concurrent writers cannot exceed it. `(not found)` and `(other)` are not counted.
--   * What 0085 wrote before is brought within the same rules: hits of ordinary search engines, of no purpose or of an
--     unknown agent are removed; a day past 10,000 paths keeps its 10,000 most read, the rest under `(other)`. Site by
--     site, in each site's scope (the tables force row-level security).
CREATE OR REPLACE FUNCTION public.lumibase_ai_agent_known(p_kind text, p_agent text, p_operator text, p_purpose text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
  SELECT EXISTS (
    SELECT 1 FROM (VALUES
      ('crawler', 'gptbot', 'OpenAI', 'training'),
      ('crawler', 'claudebot', 'Anthropic', 'training'),
      ('crawler', 'ccbot', 'Common Crawl', 'training'),
      ('crawler', 'google-extended', 'Google', 'training'),
      ('crawler', 'applebot-extended', 'Apple', 'training'),
      ('crawler', 'meta-externalagent', 'Meta', 'training'),
      ('crawler', 'bytespider', 'ByteDance', 'training'),
      ('crawler', 'amazonbot', 'Amazon', 'training'),
      ('crawler', 'oai-searchbot', 'OpenAI', 'search'),
      ('crawler', 'claude-searchbot', 'Anthropic', 'search'),
      ('crawler', 'perplexitybot', 'Perplexity', 'search'),
      ('crawler', 'duckassistbot', 'DuckDuckGo', 'search'),
      ('crawler', 'chatgpt-user', 'OpenAI', 'user-fetch'),
      ('crawler', 'claude-user', 'Anthropic', 'user-fetch'),
      ('crawler', 'perplexity-user', 'Perplexity', 'user-fetch'),
      ('crawler', 'mistralai-user', 'Mistral AI', 'user-fetch'),
      ('crawler', 'meta-externalfetcher', 'Meta', 'user-fetch'),
      ('referral', 'chatgpt', 'OpenAI', NULL),
      ('referral', 'perplexity', 'Perplexity', NULL),
      ('referral', 'claude', 'Anthropic', NULL),
      ('referral', 'gemini', 'Google', NULL),
      ('referral', 'copilot', 'Microsoft', NULL),
      ('referral', 'deepseek', 'DeepSeek', NULL),
      ('referral', 'mistral', 'Mistral AI', NULL),
      ('referral', 'meta-ai', 'Meta', NULL),
      ('referral', 'you', 'You.com', NULL),
      ('referral', 'phind', 'Phind', NULL),
      ('referral', 'poe', 'Quora', NULL),
      ('referral', 'kimi', 'Moonshot AI', NULL),
      ('referral', 'doubao', 'ByteDance', NULL)
    ) AS k(kind, agent, operator, purpose)
    WHERE k.kind = p_kind AND k.agent = p_agent AND k.operator = p_operator AND k.purpose IS NOT DISTINCT FROM p_purpose
  )
$function$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.lumibase_ai_agent_known(text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.lumibase_record_crawl_hit(
  p_host text, p_kind text, p_agent text, p_operator text, p_purpose text, p_resource text, p_path text, p_ip_hash text, p_status integer
)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
DECLARE
  v_site text;
  v_day date := (now() AT TIME ZONE 'UTC')::date;
  v_path text := p_path;
BEGIN
  IF p_host IS NULL OR length(p_host) NOT BETWEEN 1 AND 253
     OR NOT public.lumibase_ai_agent_known(p_kind, p_agent, p_operator, p_purpose)
     OR p_resource IS NULL OR p_resource NOT IN ('page', 'markdown', 'llms', 'robots', 'sitemap', 'feed', 'file', 'other')
     OR p_path IS NULL OR length(p_path) NOT BETWEEN 1 AND 512 OR left(p_path, 1) <> '/' OR position('?' IN p_path) > 0
     OR (p_ip_hash IS NOT NULL AND p_ip_hash !~ '^[0-9a-f]{16,64}$')
     OR p_status IS NULL OR p_status NOT BETWEEN 100 AND 599 THEN
    RETURN;
  END IF;
  SELECT h.site_id INTO v_site FROM public.lumibase_public_hosts h WHERE h.hostname = lower(p_host);
  IF v_site IS NULL THEN
    RETURN;
  END IF;
  PERFORM pg_catalog.set_config('app.site_id', v_site, true);
  IF p_status >= 400 THEN
    v_path := '(not found)';
  ELSIF NOT EXISTS (SELECT 1 FROM public.lumibase_crawl_daily_paths p WHERE p.site_id = v_site AND p.day = v_day AND p.path = v_path) THEN
    -- A new path of the day: counted under the day's lock (one writer at a time decides on the bound).
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('crawl-daily:' || v_site || ':' || v_day::text, 0));
    IF NOT EXISTS (SELECT 1 FROM public.lumibase_crawl_daily_paths p WHERE p.site_id = v_site AND p.day = v_day AND p.path = v_path) THEN
      IF (SELECT count(*) FROM public.lumibase_crawl_daily_paths p WHERE p.site_id = v_site AND p.day = v_day) >= 10000 THEN
        v_path := '(other)';
      ELSE
        INSERT INTO public.lumibase_crawl_daily_paths (site_id, day, path) VALUES (v_site, v_day, v_path);
      END IF;
    END IF;
  END IF;
  INSERT INTO public.lumibase_crawl_hits (site_id, kind, agent, operator, purpose, resource, path, ip_hash, status)
    VALUES (v_site, p_kind, p_agent, p_operator, p_purpose, p_resource, v_path, p_ip_hash, p_status);
  INSERT INTO public.lumibase_crawl_daily (site_id, day, kind, agent, operator, purpose, resource, path, hits)
    VALUES (v_site, v_day, p_kind, p_agent, p_operator, coalesce(p_purpose, ''), p_resource, v_path, 1)
    ON CONFLICT (site_id, day, kind, agent, resource, path) DO UPDATE SET hits = public.lumibase_crawl_daily.hits + 1;
END $function$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.lumibase_record_crawl_hit(text, text, text, text, text, text, text, text, integer) FROM PUBLIC;
--> statement-breakpoint
-- The reconciliation of existing rows, as a function of its own (run once here; the tests run it on rows they made).
CREATE OR REPLACE FUNCTION public.lumibase_crawl_traffic_reconcile()
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
DECLARE
  s text;
  d record;
BEGIN
  FOR s IN SELECT id FROM public.lumibase_sites LOOP
    PERFORM pg_catalog.set_config('app.site_id', s, true);
    -- Hits the rules no longer take: ordinary search engines, no purpose, unknown agents.
    DELETE FROM public.lumibase_crawl_hits h
     WHERE h.site_id = s AND NOT public.lumibase_ai_agent_known(h.kind, h.agent, h.operator, h.purpose);
    DELETE FROM public.lumibase_crawl_daily c
     WHERE c.site_id = s AND NOT public.lumibase_ai_agent_known(c.kind, c.agent, c.operator, nullif(c.purpose, ''));
    -- Days past the bound: the 10,000 most read paths kept, the rest folded into `(other)`.
    FOR d IN
      SELECT c.day FROM public.lumibase_crawl_daily c
       WHERE c.site_id = s AND c.path NOT IN ('(not found)', '(other)')
       GROUP BY c.day HAVING count(DISTINCT c.path) > 10000
    LOOP
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
    END LOOP;
    -- The distinct paths of every day kept so far.
    INSERT INTO public.lumibase_crawl_daily_paths (site_id, day, path)
      SELECT DISTINCT c.site_id, c.day, c.path FROM public.lumibase_crawl_daily c
       WHERE c.site_id = s AND c.path NOT IN ('(not found)', '(other)')
    ON CONFLICT DO NOTHING;
  END LOOP;
END $function$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.lumibase_crawl_traffic_reconcile() FROM PUBLIC;
--> statement-breakpoint
SELECT public.lumibase_crawl_traffic_reconcile();
