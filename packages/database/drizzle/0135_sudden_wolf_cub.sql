CREATE TABLE "lumibase_translation_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"source_locale" text NOT NULL,
	"target_locale" text NOT NULL,
	"segments" jsonb NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"executions" integer DEFAULT 0 NOT NULL,
	"max_executions" integer DEFAULT 5 NOT NULL,
	"call_epoch" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error_code" text,
	"service_id" text,
	"draft_provider" text,
	"draft_model" text,
	"review_provider" text,
	"review_model" text,
	"segments_translated" integer DEFAULT 0 NOT NULL,
	"segments_revised" integer DEFAULT 0 NOT NULL,
	"segments_unverified" integer DEFAULT 0 NOT NULL,
	"segments_rejected" integer DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"lease_owner" text,
	"cancel_requested_at" timestamp with time zone,
	"created_by" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translation_jobs_status_check" CHECK ("lumibase_translation_jobs"."status" IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "lumibase_translation_jobs" ADD CONSTRAINT "lumibase_translation_jobs_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "translation_jobs_due_idx" ON "lumibase_translation_jobs" USING btree ("site_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "translation_jobs_created_idx" ON "lumibase_translation_jobs" USING btree ("site_id","created_at");--> statement-breakpoint
-- Row-level security from the registry (HeoPress P14, ADR-0023): a translation job is visible and writable only in
-- its own site's scope.
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_translation_jobs' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_translation_jobs', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_translation_jobs ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_translation_jobs FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());
