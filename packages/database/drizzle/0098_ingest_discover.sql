CREATE TABLE "lumibase_ingest_dedup_index" (
	"document_id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding" real[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_discovered_urls" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"source_id" text NOT NULL,
	"normalized_url" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"run_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"reason" text,
	"source_document_id" text,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_event_clusters" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"entities" text[] NOT NULL,
	"representative_document_id" text NOT NULL,
	"member_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_source_cursors" (
	"site_id" text NOT NULL,
	"source_id" text NOT NULL,
	"attempt_cursor" jsonb,
	"attempt_run_id" text,
	"attempt_at" timestamp with time zone,
	"success_cursor" jsonb,
	"success_run_id" text,
	"success_at" timestamp with time zone,
	CONSTRAINT "lumibase_ingest_source_cursors_site_id_source_id_pk" PRIMARY KEY("site_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_documents" ADD COLUMN "near_duplicate_check" text DEFAULT 'skipped' NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_documents" ADD COLUMN "near_duplicate_reason" text;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_documents" ADD COLUMN "duplicate_of" text;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_documents" ADD COLUMN "duplicate_similarity" real;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_documents" ADD COLUMN "duplicate_scope" text;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_documents" ADD COLUMN "duplicate_site_id" text;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_documents" ADD COLUMN "event_cluster_id" text;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_documents" ADD COLUMN "cluster_role" text;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_documents" ADD COLUMN "event_entities" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_runs" ADD COLUMN "items_discovered" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_runs" ADD COLUMN "items_new" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_runs" ADD COLUMN "items_duplicate" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_runs" ADD COLUMN "stop_reason" text;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_dedup_index" ADD CONSTRAINT "lumibase_ingest_dedup_index_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_dedup_index" ADD CONSTRAINT "ingest_dedup_index_document_fk" FOREIGN KEY ("site_id","document_id") REFERENCES "public"."lumibase_ingest_source_documents"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_discovered_urls" ADD CONSTRAINT "lumibase_ingest_discovered_urls_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_discovered_urls" ADD CONSTRAINT "ingest_discovered_urls_source_fk" FOREIGN KEY ("site_id","source_id") REFERENCES "public"."lumibase_ingest_sources"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_event_clusters" ADD CONSTRAINT "lumibase_ingest_event_clusters_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_cursors" ADD CONSTRAINT "lumibase_ingest_source_cursors_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_cursors" ADD CONSTRAINT "ingest_source_cursors_source_fk" FOREIGN KEY ("site_id","source_id") REFERENCES "public"."lumibase_ingest_sources"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_dedup_index_model_idx" ON "lumibase_ingest_dedup_index" USING btree ("embedding_model","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_discovered_urls_site_url_unique" ON "lumibase_ingest_discovered_urls" USING btree ("site_id","normalized_url");--> statement-breakpoint
CREATE INDEX "ingest_discovered_urls_source_idx" ON "lumibase_ingest_discovered_urls" USING btree ("site_id","source_id","discovered_at");--> statement-breakpoint
CREATE INDEX "ingest_event_clusters_window_idx" ON "lumibase_ingest_event_clusters" USING btree ("site_id","last_seen_at");--> statement-breakpoint
CREATE INDEX "ingest_source_documents_content_hash_idx" ON "lumibase_ingest_source_documents" USING btree ("site_id","content_hash");--> statement-breakpoint
CREATE INDEX "ingest_source_documents_cluster_idx" ON "lumibase_ingest_source_documents" USING btree ("site_id","event_cluster_id");