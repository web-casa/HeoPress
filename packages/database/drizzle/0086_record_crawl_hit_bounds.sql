-- HeoPress P07 tasks 6.1, 6.4 (Codex review of batch 11): the AI traffic entry, stricter. A crawler's hit must name its
-- AI purpose (training, search, user-fetch; ordinary search engines are not recorded), a host is at most 253 characters,
-- and what is kept is bounded whatever a caller sends: an answer of 400 or more is kept under the path `(not found)`, and
-- a site's day keeps at most 10,000 distinct paths — further new ones are kept under `(other)`.
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
     OR p_kind IS NULL OR p_kind NOT IN ('crawler', 'referral')
     OR p_agent IS NULL OR p_agent !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
     OR p_operator IS NULL OR length(p_operator) NOT BETWEEN 1 AND 64
     OR (p_kind = 'crawler' AND (p_purpose IS NULL OR p_purpose NOT IN ('training', 'search', 'user-fetch')))
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
  IF p_status >= 400 THEN
    v_path := '(not found)';
  ELSIF NOT EXISTS (
    SELECT 1 FROM public.lumibase_crawl_daily d
     WHERE d.site_id = v_site AND d.day = v_day AND d.kind = p_kind AND d.agent = p_agent AND d.resource = p_resource AND d.path = v_path
  ) AND (SELECT count(*) FROM (SELECT 1 FROM public.lumibase_crawl_daily d WHERE d.site_id = v_site AND d.day = v_day LIMIT 10000) x) >= 10000 THEN
    v_path := '(other)';
  END IF;
  INSERT INTO public.lumibase_crawl_hits (site_id, kind, agent, operator, purpose, resource, path, ip_hash, status)
    VALUES (v_site, p_kind, p_agent, p_operator, p_purpose, p_resource, v_path, p_ip_hash, p_status);
  INSERT INTO public.lumibase_crawl_daily (site_id, day, kind, agent, operator, purpose, resource, path, hits)
    VALUES (v_site, v_day, p_kind, p_agent, p_operator, coalesce(p_purpose, ''), p_resource, v_path, 1)
    ON CONFLICT (site_id, day, kind, agent, resource, path) DO UPDATE SET hits = public.lumibase_crawl_daily.hits + 1;
END $function$;
--> statement-breakpoint
REVOKE EXECUTE ON FUNCTION public.lumibase_record_crawl_hit(text, text, text, text, text, text, text, text, integer) FROM PUBLIC;
