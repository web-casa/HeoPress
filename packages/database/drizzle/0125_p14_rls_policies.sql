-- HeoPress P14 task 1.7 (ADR-0023, spec platform/tenant-isolation): row-level security on every registered table.
-- Generated from packages/database/src/rls/registry.ts by rlsPolicySql(); rls-catalog.db.test.ts compares the database
-- with the same registry. Repeatable: the policies on each registered table are dropped and recreated, tables are
-- ENABLE (not FORCE: the owner migrates and backs up), exceptions are DISABLE.
CREATE OR REPLACE FUNCTION public.app_site_id_or_null() RETURNS text
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
    SELECT nullif(current_setting('app.site_id', true), '')
  $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.heopress_lockout_policy() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
    SELECT value FROM public.lumibase_settings
    WHERE key = 'login_security_policy'
    ORDER BY (site_id = '__default__') DESC, site_id ASC
    LIMIT 1
  $$;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_collections' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_collections', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_collections ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_collections FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_fields' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_fields', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_fields ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_fields FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_relations' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_relations', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_relations ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_relations FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_items' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_items', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_items ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_items FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_revisions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_revisions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_revisions ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_revisions FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_activity' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_activity', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_activity ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_activity FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_files' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_files', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_files ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_files FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_folders' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_folders', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_folders ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_folders FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_presets' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_presets', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_presets ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_presets FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_translations' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_translations', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_translations ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_translations FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_settings' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_settings', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_settings ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_settings FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_webhooks' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_webhooks', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_webhooks ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_webhooks FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_email_layouts' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_email_layouts', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_email_layouts ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_email_layouts FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_email_templates' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_email_templates', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_email_templates ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_email_templates FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_roles' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_roles', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_roles ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_roles FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_policies' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_policies', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_policies ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_policies FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_user_policies' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_user_policies', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_user_policies ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_user_policies FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_permissions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_permissions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_permissions ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_permissions FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_audit_log' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_audit_log', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_audit_log ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_audit_log FOR ALL USING (CASE WHEN site_id IS NULL THEN app_platform_scope() ELSE site_id = app_site_id() END) WITH CHECK (CASE WHEN site_id IS NULL THEN app_platform_scope() ELSE site_id = app_site_id() END);--> statement-breakpoint
CREATE POLICY instance_insert ON public.lumibase_audit_log FOR INSERT WITH CHECK (site_id IS NULL);--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_field_access_log' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_field_access_log', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_field_access_log ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_field_access_log FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_content_reviews' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_content_reviews', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_content_reviews ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_content_reviews FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_erasure_requests' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_erasure_requests', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_erasure_requests ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_erasure_requests FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_encryption_keys' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_encryption_keys', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_encryption_keys ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_encryption_keys FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_user_consents' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_user_consents', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_user_consents ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_user_consents FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_email_suppressions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_email_suppressions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_email_suppressions ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_email_suppressions FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_processing_restrictions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_processing_restrictions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_processing_restrictions ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_processing_restrictions FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_deployment_targets' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_deployment_targets', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_deployment_targets ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_deployment_targets FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_deployments' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_deployments', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_deployments ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_deployments FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_site_domains' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_site_domains', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_site_domains ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_site_domains FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_refresh_tokens' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_refresh_tokens', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_refresh_tokens ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_refresh_tokens FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_cdc_change_events' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_cdc_change_events', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_cdc_change_events ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_cdc_change_events FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_cdc_subscriptions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_cdc_subscriptions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_cdc_subscriptions ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_cdc_subscriptions FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_cdc_deliveries' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_cdc_deliveries', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_cdc_deliveries ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_cdc_deliveries FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_git_integrations' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_git_integrations', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_git_integrations ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_git_integrations FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_git_pull_requests' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_git_pull_requests', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_git_pull_requests ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_git_pull_requests FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_git_ci_runs' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_git_ci_runs', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_git_ci_runs ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_git_ci_runs FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_git_webhook_events' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_git_webhook_events', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_git_webhook_events ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_git_webhook_events FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_git_preview_envs' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_git_preview_envs', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_git_preview_envs ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_git_preview_envs FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_git_provenance' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_git_provenance', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_git_provenance ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_git_provenance FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_flows' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_flows', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_flows ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_flows FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_flow_runs' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_flow_runs', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_flow_runs ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_flow_runs FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_item_idempotency_keys' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_item_idempotency_keys', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_item_idempotency_keys ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_item_idempotency_keys FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_cdc_prune_marks' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_cdc_prune_marks', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_cdc_prune_marks ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_cdc_prune_marks FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_storage_profiles' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_storage_profiles', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_storage_profiles ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_storage_profiles FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_site_storage' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_site_storage', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_site_storage ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_site_storage FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_media_objects' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_media_objects', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_media_objects ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_media_objects FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_llm_providers' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_llm_providers', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_llm_providers ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_llm_providers FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_llm_routes' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_llm_routes', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_llm_routes ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_llm_routes FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_llm_site_settings' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_llm_site_settings', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_llm_site_settings ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_llm_site_settings FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_llm_calls' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_llm_calls', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_llm_calls ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_llm_calls FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_llm_attempts' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_llm_attempts', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_llm_attempts ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_llm_attempts FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_site_presets' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_site_presets', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_site_presets ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_site_presets FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_site_content_settings' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_site_content_settings', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_site_content_settings ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_site_content_settings FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_site_seo_settings' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_site_seo_settings', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_site_seo_settings ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_site_seo_settings FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_site_identity' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_site_identity', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_site_identity ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_site_identity FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_site_root_files' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_site_root_files', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_site_root_files ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_site_root_files FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_indexnow_state' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_indexnow_state', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_indexnow_state ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_indexnow_state FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_indexnow_sites' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_indexnow_sites', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_indexnow_sites ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_indexnow_sites FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_link_edges' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_link_edges', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_link_edges ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_link_edges FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_audit_issues' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_audit_issues', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_audit_issues ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_audit_issues FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_audit_issue_states' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_audit_issue_states', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_audit_issue_states ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_audit_issue_states FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_audit_issue_resolutions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_audit_issue_resolutions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_audit_issue_resolutions ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_audit_issue_resolutions FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_reachability_reports' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_reachability_reports', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_reachability_reports ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_reachability_reports FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_crawl_hits' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_crawl_hits', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_crawl_hits ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_crawl_hits FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_crawl_daily' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_crawl_daily', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_crawl_daily ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_crawl_daily FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_crawl_daily_paths' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_crawl_daily_paths', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_crawl_daily_paths ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_crawl_daily_paths FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_item_numbers' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_item_numbers', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_item_numbers ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_item_numbers FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_content_routes' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_content_routes', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_content_routes ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_content_routes FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_redirects' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_redirects', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_redirects ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_redirects FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_editorial_profile_versions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_editorial_profile_versions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_editorial_profile_versions ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_editorial_profile_versions FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_translation_group_members' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_translation_group_members', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_translation_group_members ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_translation_group_members FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_shared_field_syncs' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_shared_field_syncs', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_shared_field_syncs ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_shared_field_syncs FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_translation_block_map' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_translation_block_map', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_translation_block_map ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_translation_block_map FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_translation_source_baselines' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_translation_source_baselines', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_translation_source_baselines ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_translation_source_baselines FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_public_sites' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_public_sites', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_public_sites ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_public_sites FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_public_items' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_public_items', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_public_items ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_public_items FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_public_alternates' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_public_alternates', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_public_alternates ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_public_alternates FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_public_path_memory' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_public_path_memory', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_public_path_memory ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_public_path_memory FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_route_tombstones' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_route_tombstones', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_route_tombstones ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_route_tombstones FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_site_render_versions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_site_render_versions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_site_render_versions ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_site_render_versions FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_themes' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_themes', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_themes ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_themes FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_theme_versions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_theme_versions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_theme_versions ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_theme_versions FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_theme_assets' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_theme_assets', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_theme_assets ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_theme_assets FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_site_themes' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_site_themes', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_site_themes ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_site_themes FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_preview_links' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_preview_links', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_preview_links ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_preview_links FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_branch_preview_grants' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_branch_preview_grants', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_branch_preview_grants ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_branch_preview_grants FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_sources' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_sources', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_sources ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_sources FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_source_licences' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_source_licences', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_source_licences ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_source_licences FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_source_runs' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_source_runs', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_source_runs ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_source_runs FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_snapshots' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_snapshots', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_snapshots ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_snapshots FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_source_documents' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_source_documents', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_source_documents ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_source_documents FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_fetch_attempts' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_fetch_attempts', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_fetch_attempts ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_fetch_attempts FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_processing_jobs' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_processing_jobs', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_processing_jobs ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_processing_jobs FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_source_cursors' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_source_cursors', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_source_cursors ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_source_cursors FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_discovered_urls' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_discovered_urls', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_discovered_urls ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_discovered_urls FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_event_clusters' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_event_clusters', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_event_clusters ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_event_clusters FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_provider_settings' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_provider_settings', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_provider_settings ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_provider_settings FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_provider_usage' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_provider_usage', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_provider_usage ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_provider_usage FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_source_fetch_chains' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_source_fetch_chains', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_source_fetch_chains ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_source_fetch_chains FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_site_settings' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_site_settings', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_site_settings ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_site_settings FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_content_provenance' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_content_provenance', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_content_provenance ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_content_provenance FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_licence_lapse_reviews' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_licence_lapse_reviews', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_licence_lapse_reviews ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_licence_lapse_reviews FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_research_leads' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_research_leads', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_research_leads ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_research_leads FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_media_licences' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_media_licences', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_media_licences ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_media_licences FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_media' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_media', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_media ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_media FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_document_media' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_document_media', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_document_media ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ingest_document_media FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ai_pipeline_pauses' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ai_pipeline_pauses', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ai_pipeline_pauses ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ai_pipeline_pauses FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ai_processing_days' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ai_processing_days', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ai_processing_days ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ai_processing_days FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ai_productions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ai_productions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ai_productions ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ai_productions FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ai_production_steps' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ai_production_steps', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ai_production_steps ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ai_production_steps FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_quality_gate_results' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_quality_gate_results', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_quality_gate_results ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_quality_gate_results FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_quality_gate_reviews' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_quality_gate_reviews', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_quality_gate_reviews ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_quality_gate_reviews FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_quality_gate_settings' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_quality_gate_settings', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_quality_gate_settings ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_quality_gate_settings FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_auto_publish_settings' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_auto_publish_settings', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_auto_publish_settings ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_auto_publish_settings FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_auto_publish_candidates' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_auto_publish_candidates', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_auto_publish_candidates ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_auto_publish_candidates FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_auto_publish_days' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_auto_publish_days', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_auto_publish_days ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_auto_publish_days FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_flow_drafts' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_flow_drafts', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_flow_drafts ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_flow_drafts FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_notification_channels' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_notification_channels', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_notification_channels ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_notification_channels FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_notification_deliveries' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_notification_deliveries', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_notification_deliveries ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_notification_deliveries FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_git_snapshot_repos' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_git_snapshot_repos', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_git_snapshot_repos ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_git_snapshot_repos FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_git_snapshot_files' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_git_snapshot_files', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_git_snapshot_files ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_git_snapshot_files FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_import_batches' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_import_batches', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_import_batches ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_import_batches FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_import_external_ids' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_import_external_ids', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_import_external_ids ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_import_external_ids FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_import_batch_items' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_import_batch_items', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_import_batch_items ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_import_batch_items FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_plugin_job_runs' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_plugin_job_runs', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_plugin_job_runs ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_plugin_job_runs FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_plugin_storage' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_plugin_storage', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_plugin_storage ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_plugin_storage FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_plugin_endpoint_keys' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_plugin_endpoint_keys', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_plugin_endpoint_keys ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_plugin_endpoint_keys FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_plugin_endpoint_nonces' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_plugin_endpoint_nonces', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_plugin_endpoint_nonces ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_plugin_endpoint_nonces FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_retention_holds' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_retention_holds', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_retention_holds ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_retention_holds FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_deletion_ledger' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_deletion_ledger', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_deletion_ledger ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_deletion_ledger FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_site_exports' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_site_exports', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_site_exports ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_site_exports FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_api_keys' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_api_keys', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_api_keys ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_api_keys FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_api_key_roles' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_api_key_roles', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_api_key_roles ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_api_key_roles FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_api_key_policies' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_api_key_policies', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_api_key_policies ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_api_key_policies FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_user_roles' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_user_roles', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_user_roles ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_user_roles FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_user_sites' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_user_sites', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_user_sites ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_user_sites FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_shares' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_shares', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_shares DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_teams' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_teams', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_teams ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_teams FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_access_generations' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_access_generations', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_access_generations ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_access_generations FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_auth_external_issuers' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_auth_external_issuers', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_auth_external_issuers ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_auth_external_issuers FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ai_approvals' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ai_approvals', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ai_approvals ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ai_approvals FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ai_conversations' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ai_conversations', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ai_conversations ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ai_conversations FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ai_embeddings' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ai_embeddings', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ai_embeddings ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_ai_embeddings FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_approvals' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_approvals', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_approvals ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_agent_approvals FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_artifacts' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_artifacts', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_artifacts ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_agent_artifacts FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_autonomy_grants' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_autonomy_grants', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_autonomy_grants ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_agent_autonomy_grants FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_evaluations' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_evaluations', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_evaluations ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_agent_evaluations FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_freezes' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_freezes', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_freezes ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_agent_freezes FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_goals' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_goals', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_goals ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_agent_goals FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_incidents' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_incidents', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_incidents ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_agent_incidents FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_memory' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_memory', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_memory ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_agent_memory FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_permissions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_permissions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_permissions ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_agent_permissions FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_plans' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_plans', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_plans ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_agent_plans FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_roles' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_roles', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_roles ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_agent_roles FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_runs' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_runs', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_runs ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_agent_runs FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_tool_calls' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_tool_calls', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_tool_calls ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_agent_tool_calls FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_tools' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_tools', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_tools ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_agent_tools FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_constitutions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_constitutions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_constitutions ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_constitutions FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_content_drifts' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_content_drifts', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_content_drifts ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_content_drifts FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_content_intents' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_content_intents', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_content_intents ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_content_intents FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_glossary' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_glossary', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_glossary ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_glossary FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_translation_memory' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_translation_memory', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_translation_memory ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_translation_memory FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_vector_site_models' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_vector_site_models', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_vector_site_models ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_vector_site_models FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_pages' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_pages', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_pages ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_pages FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_content_versions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_content_versions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_content_versions ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_content_versions FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_releases' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_releases', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_releases ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_releases FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_release_items' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_release_items', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_release_items ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_release_items FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_transform_presets' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_transform_presets', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_transform_presets ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_transform_presets FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_materialized_collections' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_materialized_collections', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_materialized_collections ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_materialized_collections FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_dashboards' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_dashboards', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_dashboards ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_dashboards FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_panels' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_panels', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_panels ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_panels FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_notifications' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_notifications', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_notifications ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_notifications FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_operations' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_operations', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_operations ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_operations FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_pageview_events' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_pageview_events', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_pageview_events ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_pageview_events FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_pageview_daily' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_pageview_daily', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_pageview_daily ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_pageview_daily FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_pageview_uniques' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_pageview_uniques', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_pageview_uniques ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_pageview_uniques FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_astro_builds' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_astro_builds', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_astro_builds ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_astro_builds FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_static_deploys' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_static_deploys', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_static_deploys ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_static_deploys FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_extensions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_extensions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_extensions ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY extensions_read ON public.lumibase_extensions FOR SELECT USING (CASE WHEN site_id IS NULL THEN true ELSE site_id = app_site_id_or_null() END);--> statement-breakpoint
CREATE POLICY extensions_write ON public.lumibase_extensions FOR ALL USING (CASE WHEN site_id IS NULL THEN false ELSE site_id = app_site_id_or_null() END) WITH CHECK (CASE WHEN site_id IS NULL THEN false ELSE site_id = app_site_id_or_null() END);--> statement-breakpoint
CREATE POLICY extensions_platform ON public.lumibase_extensions FOR ALL USING (site_id IS NULL AND app_platform_scope()) WITH CHECK (site_id IS NULL AND app_platform_scope());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_translation_groups' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_translation_groups', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_translation_groups ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY translation_group_sites ON public.lumibase_translation_groups FOR ALL USING (site_id = app_site_id() OR app_site_id() = ANY (site_ids)) WITH CHECK (site_id = app_site_id() OR app_site_id() = ANY (site_ids));--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_system_events' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_system_events', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_system_events ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY system_events_insert ON public.lumibase_system_events FOR INSERT WITH CHECK (true);--> statement-breakpoint
CREATE POLICY system_events_read ON public.lumibase_system_events FOR SELECT USING (current_setting('app.platform_reader', true) = 'on' OR current_setting('app.retention', true) = 'on');--> statement-breakpoint
CREATE POLICY system_events_delete ON public.lumibase_system_events FOR DELETE USING (current_setting('app.retention', true) = 'on');--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_oauth_clients' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_oauth_clients', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_oauth_clients ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY agent_access ON public.lumibase_oauth_clients FOR ALL USING (current_setting('app.agent_access', true) = 'on') WITH CHECK (current_setting('app.agent_access', true) = 'on');--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_grants' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_grants', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_grants ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY agent_access ON public.lumibase_agent_grants FOR ALL USING (current_setting('app.agent_access', true) = 'on') WITH CHECK (current_setting('app.agent_access', true) = 'on');--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_oauth_codes' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_oauth_codes', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_oauth_codes ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY agent_access ON public.lumibase_oauth_codes FOR ALL USING (current_setting('app.agent_access', true) = 'on') WITH CHECK (current_setting('app.agent_access', true) = 'on');--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_oauth_tokens' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_oauth_tokens', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_oauth_tokens ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY agent_access ON public.lumibase_oauth_tokens FOR ALL USING (current_setting('app.agent_access', true) = 'on') WITH CHECK (current_setting('app.agent_access', true) = 'on');--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_agent_idempotency' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_agent_idempotency', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_agent_idempotency ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY agent_access ON public.lumibase_agent_idempotency FOR ALL USING (current_setting('app.agent_access', true) = 'on') WITH CHECK (current_setting('app.agent_access', true) = 'on');--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_batch_plans' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_batch_plans', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_batch_plans ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY agent_access ON public.lumibase_batch_plans FOR ALL USING (current_setting('app.agent_access', true) = 'on') WITH CHECK (current_setting('app.agent_access', true) = 'on');--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_batch_plan_items' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_batch_plan_items', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_batch_plan_items ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY agent_access ON public.lumibase_batch_plan_items FOR ALL USING (current_setting('app.agent_access', true) = 'on') WITH CHECK (current_setting('app.agent_access', true) = 'on');--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_batch_plan_approvals' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_batch_plan_approvals', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_batch_plan_approvals ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY agent_access ON public.lumibase_batch_plan_approvals FOR ALL USING (current_setting('app.agent_access', true) = 'on') WITH CHECK (current_setting('app.agent_access', true) = 'on');--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_public_hosts' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_public_hosts', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_public_hosts DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_render_cache' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_render_cache', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_render_cache DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_projection_rebuilds' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_projection_rebuilds', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_projection_rebuilds DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_projection_dirty' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_projection_dirty', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_projection_dirty DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_schedule' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_schedule', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_schedule DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_git_snapshot_queue' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_git_snapshot_queue', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_git_snapshot_queue DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_plugin_jobs' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_plugin_jobs', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_plugin_jobs DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_link_scans' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_link_scans', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_link_scans DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_indexnow_queue' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_indexnow_queue', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_indexnow_queue DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_audit_sites' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_audit_sites', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_audit_sites DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_reachability_sites' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_reachability_sites', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_reachability_sites DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_astro_sites' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_astro_sites', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_astro_sites DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_event_consumers' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_event_consumers', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_event_consumers DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_external_actions' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_external_actions', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_external_actions DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_deleted_site_ids' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_deleted_site_ids', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_deleted_site_ids DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_ingest_dedup_index' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_ingest_dedup_index', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_ingest_dedup_index DISABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;
