CREATE TABLE "lumibase_plugin_endpoint_keys" (
	"site_id" text NOT NULL,
	"extension_name" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"key_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_plugin_endpoint_keys_site_id_extension_name_pk" PRIMARY KEY("site_id","extension_name")
);
--> statement-breakpoint
CREATE TABLE "lumibase_plugin_endpoint_nonces" (
	"site_id" text NOT NULL,
	"extension_name" text NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "lumibase_plugin_endpoint_nonces_site_id_extension_name_nonce_pk" PRIMARY KEY("site_id","extension_name","nonce")
);
--> statement-breakpoint
CREATE TABLE "lumibase_plugin_job_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"extension_name" text NOT NULL,
	"job_name" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lumibase_plugin_jobs" (
	"site_id" text NOT NULL,
	"extension_name" text NOT NULL,
	"job_name" text NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"progress" jsonb,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_plugin_jobs_site_id_extension_name_job_name_pk" PRIMARY KEY("site_id","extension_name","job_name")
);
--> statement-breakpoint
CREATE TABLE "lumibase_plugin_storage" (
	"site_id" text NOT NULL,
	"extension_name" text NOT NULL,
	"namespace" text NOT NULL,
	"doc_id" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_plugin_storage_site_id_extension_name_namespace_doc_id_pk" PRIMARY KEY("site_id","extension_name","namespace","doc_id")
);
--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN "trusted" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN "trusted_at" timestamp;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN "trusted_by" text;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_plugin_endpoint_keys" ADD CONSTRAINT "lumibase_plugin_endpoint_keys_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_plugin_endpoint_nonces" ADD CONSTRAINT "lumibase_plugin_endpoint_nonces_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_plugin_job_runs" ADD CONSTRAINT "lumibase_plugin_job_runs_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_plugin_jobs" ADD CONSTRAINT "lumibase_plugin_jobs_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_plugin_storage" ADD CONSTRAINT "lumibase_plugin_storage_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plugin_endpoint_nonces_expires_idx" ON "lumibase_plugin_endpoint_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "plugin_job_runs_job_idx" ON "lumibase_plugin_job_runs" USING btree ("site_id","extension_name","job_name","started_at");--> statement-breakpoint
CREATE INDEX "plugin_jobs_due_idx" ON "lumibase_plugin_jobs" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "plugin_storage_data_idx" ON "lumibase_plugin_storage" USING gin ("data");--> statement-breakpoint
CREATE INDEX "plugin_storage_recent_idx" ON "lumibase_plugin_storage" USING btree ("site_id","extension_name","namespace","updated_at");--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD CONSTRAINT "lumibase_extensions_trusted_by_lumibase_users_id_fk" FOREIGN KEY ("trusted_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- HeoPress P12 task 3.3: `_ext`, the prefix of plugin public endpoints, joins the public site's own top-level paths
-- (mirror of packages/public-site/src/system-paths.ts). Content that already took it stops the upgrade with a report.
CREATE OR REPLACE FUNCTION public.heopress_is_system_path(segment text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'pg_catalog', 'pg_temp'
 AS $function$
  SELECT lower(segment) ~ '^(feed|rss|atom)([-_.][a-z0-9-]+)*$'
      OR lower(segment) ~ '^\.?well-known$'
      OR lower(segment) ~ '^[^/]+\.(txt|xml|html|htm|json|webmanifest|ico)$'
      OR lower(segment) = '_ext'
$function$;
--> statement-breakpoint
DO $$
DECLARE
  report text;
BEGIN
  SELECT string_agg(format('%s %s', site_id, path), E'\n' ORDER BY site_id, path)
    INTO report
    FROM (
      SELECT site_id, path FROM lumibase_content_routes
       WHERE lower(split_part(path, '/', 2)) = '_ext'
       ORDER BY site_id, path LIMIT 50
    ) conflicts;
  IF report IS NOT NULL THEN
    RAISE EXCEPTION 'content paths now reserved for plugin endpoints (move them, e.g. with a new slug and a redirect, then upgrade again):%', E'\n' || report
      USING ERRCODE = 'check_violation';
  END IF;
END $$;
