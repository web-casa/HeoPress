CREATE TABLE "lumibase_ingest_fetch_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"source_id" text NOT NULL,
	"run_id" text,
	"operation_id" text NOT NULL,
	"url" text NOT NULL,
	"final_url" text,
	"fetch_method" text NOT NULL,
	"fetch_provider" text NOT NULL,
	"outcome" text NOT NULL,
	"failure_category" text,
	"message" text,
	"http_status" integer,
	"bytes" integer,
	"duration_ms" integer,
	"source_document_id" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_host_slots" (
	"host" text NOT NULL,
	"slot" integer NOT NULL,
	"holder" text,
	"lease_until" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	CONSTRAINT "lumibase_ingest_host_slots_host_slot_pk" PRIMARY KEY("host","slot")
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_processing_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"source_document_id" text NOT NULL,
	"kind" text DEFAULT 'process' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enqueued_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"byte_size" integer NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_written_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_snapshots_site_id_unique" UNIQUE("site_id","id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_source_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"source_id" text NOT NULL,
	"run_id" text,
	"operation_id" text NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"final_url" text NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"published_at" timestamp with time zone,
	"language" text,
	"canonical_candidate" text,
	"body_html" text NOT NULL,
	"body_text" text NOT NULL,
	"content_hash" text NOT NULL,
	"snapshot_id" text NOT NULL,
	"extraction_rule_version" text NOT NULL,
	"hidden_content" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetch_method" text NOT NULL,
	"fetch_provider" text NOT NULL,
	"http_status" integer,
	"licence_status" text NOT NULL,
	"usage_mode" text NOT NULL,
	"commercial_use" boolean NOT NULL,
	"licence_revision_id" text,
	"fetched_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_source_documents_site_id_unique" UNIQUE("site_id","id")
);
--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_runs" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_runs" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_fetch_attempts" ADD CONSTRAINT "lumibase_ingest_fetch_attempts_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_fetch_attempts" ADD CONSTRAINT "ingest_fetch_attempts_source_fk" FOREIGN KEY ("site_id","source_id") REFERENCES "public"."lumibase_ingest_sources"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_processing_jobs" ADD CONSTRAINT "lumibase_ingest_processing_jobs_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_processing_jobs" ADD CONSTRAINT "ingest_processing_jobs_document_fk" FOREIGN KEY ("site_id","source_document_id") REFERENCES "public"."lumibase_ingest_source_documents"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_snapshots" ADD CONSTRAINT "lumibase_ingest_snapshots_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_documents" ADD CONSTRAINT "lumibase_ingest_source_documents_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_documents" ADD CONSTRAINT "ingest_source_documents_source_fk" FOREIGN KEY ("site_id","source_id") REFERENCES "public"."lumibase_ingest_sources"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_documents" ADD CONSTRAINT "ingest_source_documents_snapshot_fk" FOREIGN KEY ("site_id","snapshot_id") REFERENCES "public"."lumibase_ingest_snapshots"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_fetch_attempts_source_idx" ON "lumibase_ingest_fetch_attempts" USING btree ("site_id","source_id","started_at");--> statement-breakpoint
CREATE INDEX "ingest_fetch_attempts_operation_idx" ON "lumibase_ingest_fetch_attempts" USING btree ("site_id","operation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_processing_jobs_document_kind_unique" ON "lumibase_ingest_processing_jobs" USING btree ("site_id","source_document_id","kind");--> statement-breakpoint
CREATE INDEX "ingest_processing_jobs_pending_idx" ON "lumibase_ingest_processing_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_snapshots_site_hash_unique" ON "lumibase_ingest_snapshots" USING btree ("site_id","sha256");--> statement-breakpoint
CREATE INDEX "ingest_snapshots_written_idx" ON "lumibase_ingest_snapshots" USING btree ("site_id","last_written_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_source_documents_operation_unique" ON "lumibase_ingest_source_documents" USING btree ("site_id","operation_id");--> statement-breakpoint
CREATE INDEX "ingest_source_documents_source_idx" ON "lumibase_ingest_source_documents" USING btree ("site_id","source_id","created_at");--> statement-breakpoint
CREATE INDEX "ingest_source_documents_url_idx" ON "lumibase_ingest_source_documents" USING btree ("site_id","normalized_url");--> statement-breakpoint
CREATE INDEX "ingest_source_documents_snapshot_idx" ON "lumibase_ingest_source_documents" USING btree ("site_id","snapshot_id");