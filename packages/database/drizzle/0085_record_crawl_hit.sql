-- HeoPress P07 tasks 6.1, 6.4 (spec analytics/ai-traffic): the rendering service's only write — one AI traffic hit, already
-- classified. It runs as the owner (the rendering role has no grant on the tables), resolves the site from the request's
-- host itself (a caller cannot name another site), checks every value (kinds, lengths, a path, a hex hash) and writes the
-- detail row and the day total in the site's scope (the tables force row-level security). Nothing else of the request is
-- taken: no User-Agent, referrer, query or address. A value it refuses is dropped without error (a statistic, never a
-- reason to fail an answer). EXECUTE is granted to the rendering role by `app-role --render` only.
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
BEGIN
  IF p_kind IS NULL OR p_kind NOT IN ('crawler', 'referral')
     OR p_agent IS NULL OR p_agent !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
     OR p_operator IS NULL OR length(p_operator) NOT BETWEEN 1 AND 64
     OR (p_purpose IS NOT NULL AND p_purpose NOT IN ('training', 'search', 'user-fetch', 'search-engine'))
     OR (p_kind = 'referral' AND p_purpose IS NOT NULL)
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
  INSERT INTO public.lumibase_crawl_hits (site_id, kind, agent, operator, purpose, resource, path, ip_hash, status)
    VALUES (v_site, p_kind, p_agent, p_operator, p_purpose, p_resource, p_path, p_ip_hash, p_status);
  INSERT INTO public.lumibase_crawl_daily (site_id, day, kind, agent, operator, purpose, resource, path, hits)
    VALUES (v_site, (now() AT TIME ZONE 'UTC')::date, p_kind, p_agent, p_operator, coalesce(p_purpose, ''), p_resource, p_path, 1)
    ON CONFLICT (site_id, day, kind, agent, resource, path) DO UPDATE SET hits = public.lumibase_crawl_daily.hits + 1;
END $function$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.lumibase_record_crawl_hit(text, text, text, text, text, text, text, text, integer) FROM PUBLIC;
