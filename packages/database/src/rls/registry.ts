/**
 * The row-level security registry (HeoPress P14, ADR-0023, spec `platform/tenant-isolation`): the one declaration of
 * how every table with a site is isolated. Each table that has a `site_id` column is either under a policy here or
 * registered as an exception with the category of its reason; `rls-registry.test.ts` scans the schema and fails on a
 * table that is neither, and the policy migration is generated from this list (`rlsPolicySql`).
 *
 * Policies:
 * - `site`: a row is visible and writable only in its own site's scope (`site_id = app_site_id()`);
 * - `site-or-instance`: as `site` for a site's rows; the instance's rows (`site_id IS NULL`: a sign-in before any site,
 *   an instance administrator's action) are inserted from any scope — an audit entry is never lost for want of one —
 *   and read or changed only in the platform scope (the audit log);
 * - `site-or-global-read`: as `site`, and every site reads the global rows (`site_id IS NULL`), which only the
 *   platform scope writes (extensions);
 * - `translation-group`: the group row is visible to, and changed by, its own site and every member site;
 * - `agent-access`: instance-level tables of the external agents' access, only in a transaction that set
 *   `app.agent_access`;
 * - `system-events`: instance events, inserted by anyone, read under `app.platform_reader` or `app.retention`, deleted
 *   under `app.retention`;
 * - `exempt`: no row-level security, for one of four reasons (`ExemptReason`). Nothing else is a reason.
 *
 * A new table with a site: add its policy in its own migration and register it here, in the same change
 * (`docs/dev/tenant-isolation.md`).
 */

type RlsPolicy = 'site' | 'site-or-instance' | 'site-or-global-read' | 'translation-group' | 'agent-access' | 'system-events' | 'exempt';

/**
 * Why a table with a site has no row-level security:
 * - `pre-site-lookup`: read to find the site, before any site is known (a public host);
 * - `cross-site-schedule`: a scheduler's or worker's queue, read across sites to find what is due — ids, times, leases
 *   and counters only, no content; the work itself runs in each site's scope;
 * - `render-cache`: the public renderer's page cache, public pages only, swept across sites;
 * - `instance`: the deployment's own bookkeeping, written by the owner or read deployment-wide by one checked path.
 */
type ExemptReason = 'pre-site-lookup' | 'cross-site-schedule' | 'render-cache' | 'instance';

export interface RlsEntry {
  table: string;
  policy: RlsPolicy;
  /** Exempt tables only: the category of the reason, and what it is. */
  reason?: { category: ExemptReason; note: string };
}

function site(table: string): RlsEntry {
  return { table, policy: 'site' };
}

function exempt(table: string, category: ExemptReason, note: string): RlsEntry {
  return { table, policy: 'exempt', reason: { category, note } };
}

function agentAccess(table: string): RlsEntry {
  return { table, policy: 'agent-access' };
}

export const RLS_REGISTRY: readonly RlsEntry[] = [
  site('lumibase_collections'),
  site('lumibase_fields'),
  site('lumibase_relations'),
  site('lumibase_items'),
  site('lumibase_revisions'),
  site('lumibase_activity'),
  site('lumibase_files'),
  site('lumibase_folders'),
  site('lumibase_presets'),
  site('lumibase_translations'),
  site('lumibase_settings'),
  site('lumibase_webhooks'),
  site('lumibase_email_layouts'),
  site('lumibase_email_templates'),
  site('lumibase_roles'),
  site('lumibase_policies'),
  site('lumibase_user_policies'),
  site('lumibase_permissions'),
  // Instance entries have no site: the platform scope reads them (P14 review of nullable site columns).
  { table: 'lumibase_audit_log', policy: 'site-or-instance' },
  // Regulated / sensitive content readiness (site-isolated).
  site('lumibase_field_access_log'),
  site('lumibase_content_reviews'),
  site('lumibase_erasure_requests'),
  site('lumibase_encryption_keys'),
  // Privacy / data-subject rights (site-isolated).
  site('lumibase_user_consents'),
  site('lumibase_email_suppressions'),
  site('lumibase_processing_restrictions'),
  // Deployment integrations (site-isolated).
  site('lumibase_deployment_targets'),
  site('lumibase_deployments'),
  // Custom domains & free subdomains (site-isolated).
  site('lumibase_site_domains'),
  // Auth session store (site-isolated; holds session-equivalent secrets).
  site('lumibase_refresh_tokens'),
  // Change Feed (outbox + subscriptions + delivery log, site-isolated).
  site('lumibase_cdc_change_events'),
  site('lumibase_cdc_subscriptions'),
  site('lumibase_cdc_deliveries'),
  // Git integration (GitHub / GitLab) — site-isolated.
  site('lumibase_git_integrations'),
  site('lumibase_git_pull_requests'),
  site('lumibase_git_ci_runs'),
  site('lumibase_git_webhook_events'),
  site('lumibase_git_preview_envs'),
  site('lumibase_git_provenance'),
  // Flow engine (visual-flow-builder + high-load async runs).
  site('lumibase_flows'),
  site('lumibase_flow_runs'),
  // P04: idempotency keys, change-feed prune marks, per-site storage.
  site('lumibase_item_idempotency_keys'),
  site('lumibase_cdc_prune_marks'),
  site('lumibase_storage_profiles'),
  site('lumibase_site_storage'),
  site('lumibase_media_objects'),
  // P04: model providers, routing, settings and the per-attempt ledger.
  site('lumibase_llm_providers'),
  site('lumibase_llm_routes'),
  site('lumibase_llm_site_settings'),
  site('lumibase_llm_calls'),
  site('lumibase_llm_attempts'),
  // P05: the site network model.
  site('lumibase_site_presets'),
  site('lumibase_site_content_settings'),
  site('lumibase_site_seo_settings'),
  site('lumibase_site_identity'),
  site('lumibase_site_root_files'),
  site('lumibase_indexnow_state'),
  site('lumibase_indexnow_sites'),
  site('lumibase_link_edges'),
  site('lumibase_audit_issues'),
  site('lumibase_audit_issue_states'),
  site('lumibase_audit_issue_resolutions'),
  site('lumibase_reachability_reports'),
  site('lumibase_crawl_hits'),
  site('lumibase_crawl_daily'),
  site('lumibase_crawl_daily_paths'),
  site('lumibase_item_numbers'),
  site('lumibase_content_routes'),
  site('lumibase_redirects'),
  site('lumibase_editorial_profile_versions'),
  site('lumibase_translation_group_members'),
  site('lumibase_shared_field_syncs'),
  site('lumibase_translation_block_map'),
  site('lumibase_translation_source_baselines'),
  // P06: the public projection (the rendering role reads it in one site's scope; the CMS
  // writes each site's rows in that site's scope). Not here: lumibase_public_hosts (the
  // renderer looks a host up before it knows the site), and the change records and rebuild
  // marks (written by the SECURITY DEFINER gate, read by the rebuild worker across sites).
  site('lumibase_public_sites'),
  site('lumibase_public_items'),
  site('lumibase_public_alternates'),
  site('lumibase_public_path_memory'),
  site('lumibase_route_tombstones'),
  site('lumibase_site_render_versions'),
  // P06: themes (versions, assets, the site's active version).
  site('lumibase_themes'),
  site('lumibase_theme_versions'),
  site('lumibase_theme_assets'),
  site('lumibase_site_themes'),
  // P06: preview links (looked up in the site the preview URL names; the rendering role has no grant).
  site('lumibase_preview_links'),
  // P10: branch preview grants (looked up in the site the public host belongs to; the rendering role has no grant).
  site('lumibase_branch_preview_grants'),
  // P08: content sources, their licence revisions and runs. Not here: lumibase_ingest_schedule
  // (the scheduler reads it across sites to find the due sources; ids and times only).
  site('lumibase_ingest_sources'),
  site('lumibase_ingest_source_licences'),
  site('lumibase_ingest_source_runs'),
  // P08 (fetching): snapshots, source documents, fetch attempts and processing jobs. Not here:
  // lumibase_ingest_host_slots (per-host politeness shared by every site; host names and times only).
  site('lumibase_ingest_snapshots'),
  site('lumibase_ingest_source_documents'),
  site('lumibase_ingest_fetch_attempts'),
  site('lumibase_ingest_processing_jobs'),
  // P08 (discovery and deduplication): cursors, discovered URLs and event clusters. Not here:
  // lumibase_ingest_dedup_index (the deployment-wide near-duplicate index: embeddings and hashes, no text;
  // read by the internal duplicate check across sites).
  site('lumibase_ingest_source_cursors'),
  site('lumibase_ingest_discovered_urls'),
  site('lumibase_ingest_event_clusters'),
  // P08 (crawl services): per-site service settings, monthly usage and per-source fallback chains.
  site('lumibase_ingest_provider_settings'),
  site('lumibase_ingest_provider_usage'),
  site('lumibase_ingest_source_fetch_chains'),
  // P08 (after registration): site settings, content provenance and the licence review queue, research leads,
  // source media with their licences and the document reference map.
  site('lumibase_ingest_site_settings'),
  site('lumibase_content_provenance'),
  site('lumibase_licence_lapse_reviews'),
  site('lumibase_ingest_research_leads'),
  site('lumibase_ingest_media_licences'),
  site('lumibase_ingest_media'),
  site('lumibase_ingest_document_media'),
  // P09 (cost control): pipeline pauses and the daily processing counter.
  site('lumibase_ai_pipeline_pauses'),
  site('lumibase_ai_processing_days'),
  // P09 (content pipeline): productions and their run records.
  site('lumibase_ai_productions'),
  site('lumibase_ai_production_steps'),
  // P09 (quality gate): results bound to versions, human review decisions, per-site check levels.
  site('lumibase_quality_gate_results'),
  site('lumibase_quality_gate_reviews'),
  site('lumibase_quality_gate_settings'),
  // P09 (auto-publish): settings (cadence, veto window, required languages), candidates, the daily counter.
  site('lumibase_auto_publish_settings'),
  site('lumibase_auto_publish_candidates'),
  site('lumibase_auto_publish_days'),
  // P09 (flow authoring): agent-drafted flow definitions awaiting a person's approval.
  site('lumibase_flow_drafts'),
  // P10 (notifications): outbound IM / webhook channels (sealed targets) and their delivery queue.
  site('lumibase_notification_channels'),
  site('lumibase_notification_deliveries'),
  // P11 (Git snapshots): a site's content repository (sealed credential) and the files it last pushed. Not here:
  // lumibase_git_snapshot_queue (the worker finds due sites across sites; ids and times only).
  site('lumibase_git_snapshot_repos'),
  site('lumibase_git_snapshot_files'),
  // P12 (site import): batches, external-ID maps and the items each batch activates.
  site('lumibase_import_batches'),
  site('lumibase_import_external_ids'),
  site('lumibase_import_batch_items'),
  // P12 (plugin runtime): run history, private storage, callback keys (sealed) and nonces. Not here:
  // lumibase_plugin_jobs (the scheduler finds due jobs across sites; ids, times and the progress cursor only).
  site('lumibase_plugin_job_runs'),
  site('lumibase_plugin_storage'),
  site('lumibase_plugin_endpoint_keys'),
  site('lumibase_plugin_endpoint_nonces'),
  // P13 (data retention): retention holds (open disputes) and the deletion ledger. The ledger is replayed after a
  // restore site by site, in each site's scope.
  site('lumibase_retention_holds'),
  site('lumibase_deletion_ledger'),
  // P13 (single-site exports). Not here: lumibase_backups and lumibase_backup_drills (instance-level, the instance
  // administrator's routes and the backup worker only).
  site('lumibase_site_exports'),
  // P14 (ADR-0023): the tables with a site that P13's policy file did not cover. Access control.
  site('lumibase_api_keys'),
  site('lumibase_api_key_roles'),
  site('lumibase_api_key_policies'),
  site('lumibase_user_roles'),
  site('lumibase_user_sites'),
  site('lumibase_shares'),
  site('lumibase_teams'),
  site('lumibase_access_generations'),
  site('lumibase_auth_external_issuers'),
  // P14: AI and agents.
  site('lumibase_ai_approvals'),
  site('lumibase_ai_conversations'),
  site('lumibase_ai_embeddings'),
  site('lumibase_agent_approvals'),
  site('lumibase_agent_artifacts'),
  site('lumibase_agent_autonomy_grants'),
  site('lumibase_agent_evaluations'),
  site('lumibase_agent_freezes'),
  site('lumibase_agent_goals'),
  site('lumibase_agent_incidents'),
  site('lumibase_agent_memory'),
  site('lumibase_agent_permissions'),
  site('lumibase_agent_plans'),
  site('lumibase_agent_roles'),
  site('lumibase_agent_runs'),
  site('lumibase_agent_tool_calls'),
  site('lumibase_agent_tools'),
  site('lumibase_constitutions'),
  site('lumibase_content_drifts'),
  site('lumibase_content_intents'),
  site('lumibase_glossary'),
  site('lumibase_translation_memory'),
  site('lumibase_vector_site_models'),
  // P14: content, releases, the Studio's own rows.
  site('lumibase_pages'),
  site('lumibase_content_versions'),
  site('lumibase_releases'),
  site('lumibase_release_items'),
  site('lumibase_transform_presets'),
  site('lumibase_materialized_collections'),
  site('lumibase_dashboards'),
  site('lumibase_panels'),
  site('lumibase_notifications'),
  site('lumibase_operations'),
  // P14: AI traffic, static builds and deployments.
  site('lumibase_pageview_events'),
  site('lumibase_pageview_daily'),
  site('lumibase_pageview_uniques'),
  site('lumibase_astro_builds'),
  site('lumibase_static_deploys'),

  // Special policies.
  { table: 'lumibase_extensions', policy: 'site-or-global-read' },
  { table: 'lumibase_translation_groups', policy: 'translation-group' },
  { table: 'lumibase_system_events', policy: 'system-events' },
  // External agents' access (P10): instance-level (a grant names its sites).
  agentAccess('lumibase_oauth_clients'),
  agentAccess('lumibase_agent_grants'),
  agentAccess('lumibase_oauth_codes'),
  agentAccess('lumibase_oauth_tokens'),
  agentAccess('lumibase_agent_idempotency'),
  agentAccess('lumibase_batch_plans'),
  agentAccess('lumibase_batch_plan_items'),
  agentAccess('lumibase_batch_plan_approvals'),

  // Exceptions.
  exempt('lumibase_public_hosts', 'pre-site-lookup', 'the renderer looks a host up to find its site'),
  exempt('lumibase_render_cache', 'render-cache', 'public pages keyed per site; the renderer and the invalidation consumer sweep it across sites'),
  exempt('lumibase_projection_rebuilds', 'cross-site-schedule', 'rebuild marks (site, reason, times), written by the SECURITY DEFINER gate, read by the rebuild worker across sites'),
  exempt('lumibase_projection_dirty', 'cross-site-schedule', 'change records (ids) written by statement triggers and flushed before commit'),
  exempt('lumibase_ingest_schedule', 'cross-site-schedule', 'when each active source is next due'),
  exempt('lumibase_git_snapshot_queue', 'cross-site-schedule', 'sites due for a Git snapshot'),
  exempt('lumibase_plugin_jobs', 'cross-site-schedule', "plugin jobs' due times, leases and progress cursors"),
  exempt('lumibase_link_scans', 'cross-site-schedule', "a site's link scan: cursor, lease and start time"),
  exempt('lumibase_indexnow_queue', 'cross-site-schedule', 'sites waiting for their IndexNow pass (event ids and times)'),
  exempt('lumibase_audit_sites', 'cross-site-schedule', "a site's audit runs: requested, leased, last run"),
  exempt('lumibase_reachability_sites', 'cross-site-schedule', "a site's reachability checks: requested, leased, last run"),
  exempt('lumibase_astro_sites', 'cross-site-schedule', 'sites marked dirty for a static build (generations and times)'),
  exempt('lumibase_event_consumers', 'cross-site-schedule', "event consumers' positions in the change events"),
  exempt('lumibase_external_actions', 'cross-site-schedule', "the outbound action ledger's states, swept by the reconciler"),
  exempt('lumibase_deleted_site_ids', 'instance', 'the hold on deleted site ids, written only by owner-run triggers'),
  exempt('lumibase_ingest_dedup_index', 'instance', 'the deployment-wide near-duplicate index (embeddings and hashes, no text), read only by the checked duplicate check'),
];

/** The tables with a site that `registry` does not list, sorted (the schema check of `rls-registry.test.ts`). */
export function unregisteredSiteTables(
  tables: ReadonlyArray<{ name: string; hasSite: boolean }>,
  registry: ReadonlyArray<{ table: string }> = RLS_REGISTRY,
): string[] {
  const registered = new Set(registry.map((e) => e.table));
  return tables.filter((t) => t.hasSite && !registered.has(t.name)).map((t) => t.name).sort();
}
