-- Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
-- =============================================================================
-- Postgres Row-Level Security (RLS) policies — Phase G hardening.
--
-- These policies enforce site-level isolation at the database layer as a
-- defence-in-depth measure. Application-level permission checks remain the
-- primary gate; RLS is a safety net if those checks are ever bypassed.
--
-- Prerequisites:
--   1. Run this migration AFTER the schema migration (0000_lumibase_init),
--      which creates every system table in the `lumibase_` namespace — these
--      policies target those names.
--   2. The Postgres role used by Hyperdrive must NOT be a superuser.
--      Use a dedicated `lumibase_app` role with GRANT on all tables.
--   3. Declare the custom setting in postgresql.conf or via ALTER DATABASE:
--        ALTER DATABASE heopress SET "app.site_id" = '';
--
-- How to apply:
--   psql $DATABASE_URL -f packages/database/migrations/rls-policies.sql
-- =============================================================================

-- Ensure the app.site_id setting exists with a safe default.
ALTER DATABASE heopress SET "app.site_id" = '';

-- =============================================================================
-- Helper function — returns the current site_id from session config.
-- Returns NULL (not empty string) when unset so IS NULL checks work.
-- =============================================================================
CREATE OR REPLACE FUNCTION app_site_id() RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT NULLIF(current_setting('app.site_id', true), '');
  $$;

-- =============================================================================
-- Macro: enable RLS on a table and create USING policy.
-- We use a DO block to keep things DRY.
-- =============================================================================

DO $$
DECLARE
  tbl text;
  tables text[] := ARRAY[
    'lumibase_collections', 'lumibase_fields', 'lumibase_relations',
    'lumibase_items', 'lumibase_revisions', 'lumibase_activity',
    'lumibase_files', 'lumibase_folders', 'lumibase_presets', 'lumibase_translations',
    'lumibase_settings', 'lumibase_webhooks', 'lumibase_extensions',
    'lumibase_email_layouts', 'lumibase_email_templates',
    'lumibase_roles', 'lumibase_policies', 'lumibase_user_policies',
    'lumibase_permissions', 'lumibase_audit_log',
    -- Regulated / sensitive content readiness (site-isolated).
    'lumibase_field_access_log', 'lumibase_content_reviews', 'lumibase_erasure_requests', 'lumibase_encryption_keys',
    -- Privacy / data-subject rights (site-isolated).
    'lumibase_user_consents', 'lumibase_email_suppressions', 'lumibase_processing_restrictions',
    -- Deployment integrations (site-isolated).
    'lumibase_deployment_targets', 'lumibase_deployments',
    -- Custom domains & free subdomains (site-isolated).
    'lumibase_site_domains',
    -- Auth session store (site-isolated; holds session-equivalent secrets).
    'lumibase_refresh_tokens',
    -- Change Feed (outbox + subscriptions + delivery log, site-isolated).
    'lumibase_cdc_change_events', 'lumibase_cdc_subscriptions', 'lumibase_cdc_deliveries',
    -- Git integration (GitHub / GitLab) — site-isolated.
    'lumibase_git_integrations', 'lumibase_git_pull_requests', 'lumibase_git_ci_runs',
    'lumibase_git_webhook_events', 'lumibase_git_preview_envs', 'lumibase_git_provenance',
    -- Flow engine (visual-flow-builder + high-load async runs).
    'lumibase_flows', 'lumibase_flow_runs',
    -- P04: idempotency keys, change-feed prune marks, per-site storage.
    'lumibase_item_idempotency_keys', 'lumibase_cdc_prune_marks',
    'lumibase_storage_profiles', 'lumibase_site_storage', 'lumibase_media_objects',
    -- P04: model providers, routing, settings and the per-attempt ledger.
    'lumibase_llm_providers', 'lumibase_llm_routes', 'lumibase_llm_site_settings',
    'lumibase_llm_calls', 'lumibase_llm_attempts',
    -- P05: the site network model.
    'lumibase_site_presets', 'lumibase_site_content_settings', 'lumibase_site_seo_settings', 'lumibase_site_identity', 'lumibase_site_root_files', 'lumibase_indexnow_state', 'lumibase_indexnow_sites', 'lumibase_link_edges', 'lumibase_audit_issues', 'lumibase_audit_issue_states', 'lumibase_audit_issue_resolutions', 'lumibase_reachability_reports', 'lumibase_crawl_hits', 'lumibase_crawl_daily', 'lumibase_crawl_daily_paths', 'lumibase_item_numbers',
    'lumibase_content_routes', 'lumibase_redirects', 'lumibase_editorial_profile_versions',
    'lumibase_translation_group_members', 'lumibase_shared_field_syncs',
    'lumibase_translation_block_map', 'lumibase_translation_source_baselines',
    -- P06: the public projection (the rendering role reads it in one site's scope; the CMS
    -- writes each site's rows in that site's scope). Not here: lumibase_public_hosts (the
    -- renderer looks a host up before it knows the site), and the change records and rebuild
    -- marks (written by the SECURITY DEFINER gate, read by the rebuild worker across sites).
    'lumibase_public_sites', 'lumibase_public_items', 'lumibase_public_alternates',
    'lumibase_public_path_memory', 'lumibase_route_tombstones', 'lumibase_site_render_versions',
    -- P06: themes (versions, assets, the site's active version).
    'lumibase_themes', 'lumibase_theme_versions', 'lumibase_theme_assets', 'lumibase_site_themes',
    -- P06: preview links (looked up in the site the preview URL names; the rendering role has no grant).
    'lumibase_preview_links',
    -- P08: content sources, their licence revisions and runs. Not here: lumibase_ingest_schedule
    -- (the scheduler reads it across sites to find the due sources; ids and times only).
    'lumibase_ingest_sources', 'lumibase_ingest_source_licences', 'lumibase_ingest_source_runs',
    -- P08 (fetching): snapshots, source documents, fetch attempts and processing jobs. Not here:
    -- lumibase_ingest_host_slots (per-host politeness shared by every site; host names and times only).
    'lumibase_ingest_snapshots', 'lumibase_ingest_source_documents', 'lumibase_ingest_fetch_attempts',
    'lumibase_ingest_processing_jobs',
    -- P08 (discovery and deduplication): cursors, discovered URLs and event clusters. Not here:
    -- lumibase_ingest_dedup_index (the deployment-wide near-duplicate index: embeddings and hashes, no text;
    -- read by the internal duplicate check across sites).
    'lumibase_ingest_source_cursors', 'lumibase_ingest_discovered_urls', 'lumibase_ingest_event_clusters',
    -- P08 (crawl services): per-site service settings, monthly usage and per-source fallback chains.
    'lumibase_ingest_provider_settings', 'lumibase_ingest_provider_usage', 'lumibase_ingest_source_fetch_chains',
    -- P08 (after registration): site settings, content provenance and the licence review queue, research leads,
    -- source media with their licences and the document reference map.
    'lumibase_ingest_site_settings', 'lumibase_content_provenance', 'lumibase_licence_lapse_reviews',
    'lumibase_ingest_research_leads', 'lumibase_ingest_media_licences', 'lumibase_ingest_media', 'lumibase_ingest_document_media',
    -- P09 (cost control): pipeline pauses and the daily processing counter.
    'lumibase_ai_pipeline_pauses', 'lumibase_ai_processing_days',
    -- P09 (content pipeline): productions and their run records.
    'lumibase_ai_productions', 'lumibase_ai_production_steps',
    -- P09 (quality gate): results bound to versions, human review decisions, per-site check levels.
    'lumibase_quality_gate_results', 'lumibase_quality_gate_reviews', 'lumibase_quality_gate_settings',
    -- P09 (auto-publish): settings (cadence, veto window, required languages), candidates, the daily counter.
    'lumibase_auto_publish_settings', 'lumibase_auto_publish_candidates', 'lumibase_auto_publish_days',
    -- P09 (flow authoring): agent-drafted flow definitions awaiting a person's approval.
    'lumibase_flow_drafts',
    -- P10 (notifications): outbound IM / webhook channels (sealed targets) and their delivery queue.
    'lumibase_notification_channels', 'lumibase_notification_deliveries'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- Enable RLS (idempotent).
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    -- Force RLS even for table owner (defence-in-depth).
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);

    -- Drop existing policy if re-running migration.
    EXECUTE format('DROP POLICY IF EXISTS site_isolation ON %I', tbl);

    -- Read isolation: rows visible only when site_id matches session var.
    -- app_site_id() returning NULL → no rows visible (fail-safe).
    -- Use a distinct dollar-quote tag (dollar-pol-dollar) so it does not clash
    -- with the outer DO block; nested identical tags are a syntax error.
    -- PERMISSIVE (the default): with only RESTRICTIVE policies PostgreSQL
    -- grants no rows at all, so the upstream file denied every row to a
    -- non-superuser role (found by rls.db.test.ts, HeoPress P03 task 7.1).
    EXECUTE format($pol$
      CREATE POLICY site_isolation ON %I
        USING (site_id = app_site_id())
        WITH CHECK (site_id = app_site_id())
    $pol$, tbl);
  END LOOP;
END $$;

-- =============================================================================
-- Translation groups (HeoPress P05, design R1): a group may span sites. The
-- group row is visible to, and changed by, the site that created it and every
-- site with a member (`site_ids`); members follow the plain site policy, so a
-- site reads another site's members only inside that site's scope.
-- =============================================================================
ALTER TABLE lumibase_translation_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE lumibase_translation_groups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_isolation ON lumibase_translation_groups;
DROP POLICY IF EXISTS translation_group_sites ON lumibase_translation_groups;
CREATE POLICY translation_group_sites ON lumibase_translation_groups
  USING (site_id = app_site_id() OR app_site_id() = ANY (site_ids))
  WITH CHECK (site_id = app_site_id() OR app_site_id() = ANY (site_ids));

-- =============================================================================
-- Tables with nullable site_id (extensions can be global) — special policy.
-- =============================================================================
-- Every site reads the global rows (site_id IS NULL); writes stay inside the
-- active site. Global rows are written only in the platform scope
-- (app.platform_scope = 'on', no active site): one policy for all commands
-- would let any site change or delete global extensions, or make its own one
-- global (HeoPress P03, Codex review round 5).
CREATE OR REPLACE FUNCTION app_platform_scope() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
    SELECT coalesce(current_setting('app.platform_scope', true), '') = 'on'
           AND NULLIF(current_setting('app.site_id', true), '') IS NULL;
  $$;

ALTER TABLE lumibase_extensions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS site_isolation ON lumibase_extensions;
DROP POLICY IF EXISTS extensions_read ON lumibase_extensions;
DROP POLICY IF EXISTS extensions_write ON lumibase_extensions;
DROP POLICY IF EXISTS extensions_platform ON lumibase_extensions;
CREATE POLICY extensions_read ON lumibase_extensions FOR SELECT
  USING (site_id IS NULL OR site_id = app_site_id());
CREATE POLICY extensions_write ON lumibase_extensions FOR ALL
  USING (site_id = app_site_id())
  WITH CHECK (site_id = app_site_id());
CREATE POLICY extensions_platform ON lumibase_extensions FOR ALL
  USING (site_id IS NULL AND app_platform_scope())
  WITH CHECK (site_id IS NULL AND app_platform_scope());

-- =============================================================================
-- role_policies junction table — no site_id column; inherit via roles.
-- We allow unrestricted access here (policy check happens at role level).
-- =============================================================================
ALTER TABLE lumibase_role_policies DISABLE ROW LEVEL SECURITY;

-- =============================================================================
-- core tables (lumibase_sites, lumibase_users) — managed by platform, no RLS needed.
-- =============================================================================
-- lumibase_sites, lumibase_users: intentionally excluded from site-scoped RLS.

COMMENT ON FUNCTION app_site_id IS
  'Returns the current request site_id from SET LOCAL app.site_id.
   Used by all RLS policies for site-level row isolation.';

-- =============================================================================
-- Instance events (HeoPress P07a task 11.4): no site. The application role
-- inserts; it reads only with `app.platform_reader` or `app.retention` set in
-- its transaction, and deletes only with `app.retention`.
-- =============================================================================
ALTER TABLE lumibase_system_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE lumibase_system_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS system_events_insert ON lumibase_system_events;
CREATE POLICY system_events_insert ON lumibase_system_events FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS system_events_read ON lumibase_system_events;
CREATE POLICY system_events_read ON lumibase_system_events FOR SELECT
  USING (current_setting('app.platform_reader', true) = 'on' OR current_setting('app.retention', true) = 'on');
DROP POLICY IF EXISTS system_events_delete ON lumibase_system_events;
CREATE POLICY system_events_delete ON lumibase_system_events FOR DELETE
  USING (current_setting('app.retention', true) = 'on');


-- =============================================================================
-- External agents' access (HeoPress P10 tasks 1.1–1.5): OAuth clients, grants,
-- codes, tokens, MCP idempotency and batch plans (P10 tasks 3.1–3.4) are
-- instance-level (a grant names its
-- sites). The application role reads and writes them only in a transaction
-- that set `app.agent_access = 'on'` — the agent-access service does — so a
-- site-scoped request can never read token hashes or grants.
-- =============================================================================
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['lumibase_oauth_clients', 'lumibase_agent_grants', 'lumibase_oauth_codes', 'lumibase_oauth_tokens', 'lumibase_agent_idempotency',
    'lumibase_batch_plans', 'lumibase_batch_plan_items', 'lumibase_batch_plan_approvals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS agent_access ON %I', tbl);
    EXECUTE format($pol$
      CREATE POLICY agent_access ON %I
        USING (current_setting('app.agent_access', true) = 'on')
        WITH CHECK (current_setting('app.agent_access', true) = 'on')
    $pol$, tbl);
  END LOOP;
END $$;
