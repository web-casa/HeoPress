CREATE TABLE "lumibase_ingest_schedule" (
	"source_id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_source_licences" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"source_id" text NOT NULL,
	"licence_status" text NOT NULL,
	"usage_mode" text NOT NULL,
	"commercial_use" boolean NOT NULL,
	"trust_level" text NOT NULL,
	"evidence" text,
	"scope" text,
	"valid_from" timestamp with time zone,
	"valid_until" timestamp with time zone,
	"review_due_at" timestamp with time zone,
	"attribution" text,
	"set_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_source_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"source_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"trigger" text DEFAULT 'scheduled' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"outcome" text DEFAULT 'running' NOT NULL,
	"failure_category" text,
	"message" text,
	"items_found" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"url" text NOT NULL,
	"list_selectors" jsonb,
	"schedule_times" text[] NOT NULL,
	"timezone" text NOT NULL,
	"max_items_per_run" integer DEFAULT 20 NOT NULL,
	"licence_status" text DEFAULT 'unknown' NOT NULL,
	"usage_mode" text DEFAULT 'discovery_only' NOT NULL,
	"commercial_use" boolean DEFAULT false NOT NULL,
	"review_due_at" timestamp with time zone,
	"trust_level" text DEFAULT 'low' NOT NULL,
	"attribution" text,
	"licence_valid_from" timestamp with time zone,
	"licence_valid_until" timestamp with time zone,
	"licence_revision_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_failure_category" text,
	"last_failure_message" text,
	"last_run_at" timestamp with time zone,
	"next_run_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_sources_site_id_unique" UNIQUE("site_id","id")
);
--> statement-breakpoint
ALTER TABLE "lumibase_ingest_schedule" ADD CONSTRAINT "lumibase_ingest_schedule_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_schedule" ADD CONSTRAINT "ingest_schedule_source_fk" FOREIGN KEY ("site_id","source_id") REFERENCES "public"."lumibase_ingest_sources"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_licences" ADD CONSTRAINT "lumibase_ingest_source_licences_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_licences" ADD CONSTRAINT "ingest_source_licences_source_fk" FOREIGN KEY ("site_id","source_id") REFERENCES "public"."lumibase_ingest_sources"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_runs" ADD CONSTRAINT "lumibase_ingest_source_runs_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_runs" ADD CONSTRAINT "ingest_source_runs_source_fk" FOREIGN KEY ("site_id","source_id") REFERENCES "public"."lumibase_ingest_sources"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_sources" ADD CONSTRAINT "lumibase_ingest_sources_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_schedule_due_idx" ON "lumibase_ingest_schedule" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "ingest_source_licences_source_idx" ON "lumibase_ingest_source_licences" USING btree ("site_id","source_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_source_runs_slot_unique" ON "lumibase_ingest_source_runs" USING btree ("source_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "ingest_source_runs_source_idx" ON "lumibase_ingest_source_runs" USING btree ("site_id","source_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_sources_site_name_unique" ON "lumibase_ingest_sources" USING btree ("site_id","name");