CREATE TABLE "lumibase_content_provenance" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"item_id" text NOT NULL,
	"source_document_id" text NOT NULL,
	"source_id" text NOT NULL,
	"operation" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_document_media" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"document_id" text NOT NULL,
	"position" integer NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"media_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_media" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"format" text NOT NULL,
	"byte_size" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"licence_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ingest_media_site_id_unique" UNIQUE("site_id","id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_media_licences" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"url" text NOT NULL,
	"evidence" text NOT NULL,
	"attribution" text,
	"allowed_uses" text[] NOT NULL,
	"valid_until" timestamp with time zone,
	"set_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_research_leads" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"origin_source_id" text NOT NULL,
	"origin_document_id" text NOT NULL,
	"url" text NOT NULL,
	"normalized_url" text NOT NULL,
	"matched_pattern" text NOT NULL,
	"lead_source_id" text,
	"discovered_url_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_site_settings" (
	"site_id" text PRIMARY KEY NOT NULL,
	"licence_lapse_policy" text DEFAULT 'hide' NOT NULL,
	"primary_source_patterns" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_licence_lapse_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"item_id" text NOT NULL,
	"source_id" text NOT NULL,
	"licence_revision_id" text,
	"reason" text NOT NULL,
	"action" text NOT NULL,
	"previous_status" text NOT NULL,
	"previous_editorial_state" text,
	"previous_hold" boolean DEFAULT false NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text
);
--> statement-breakpoint
ALTER TABLE "lumibase_ingest_sources" ADD COLUMN "managed_by" text;--> statement-breakpoint
ALTER TABLE "lumibase_content_provenance" ADD CONSTRAINT "lumibase_content_provenance_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_provenance" ADD CONSTRAINT "lumibase_content_provenance_item_id_lumibase_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."lumibase_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_provenance" ADD CONSTRAINT "content_provenance_document_fk" FOREIGN KEY ("site_id","source_document_id") REFERENCES "public"."lumibase_ingest_source_documents"("site_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_document_media" ADD CONSTRAINT "lumibase_ingest_document_media_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_document_media" ADD CONSTRAINT "ingest_document_media_document_fk" FOREIGN KEY ("site_id","document_id") REFERENCES "public"."lumibase_ingest_source_documents"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_document_media" ADD CONSTRAINT "ingest_document_media_media_fk" FOREIGN KEY ("site_id","media_id") REFERENCES "public"."lumibase_ingest_media"("site_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_media" ADD CONSTRAINT "lumibase_ingest_media_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_media_licences" ADD CONSTRAINT "lumibase_ingest_media_licences_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_research_leads" ADD CONSTRAINT "lumibase_ingest_research_leads_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_research_leads" ADD CONSTRAINT "ingest_research_leads_document_fk" FOREIGN KEY ("site_id","origin_document_id") REFERENCES "public"."lumibase_ingest_source_documents"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_site_settings" ADD CONSTRAINT "lumibase_ingest_site_settings_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_licence_lapse_reviews" ADD CONSTRAINT "lumibase_licence_lapse_reviews_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_licence_lapse_reviews" ADD CONSTRAINT "lumibase_licence_lapse_reviews_item_id_lumibase_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."lumibase_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_provenance_item_document_unique" ON "lumibase_content_provenance" USING btree ("site_id","item_id","source_document_id");--> statement-breakpoint
CREATE INDEX "content_provenance_source_idx" ON "lumibase_content_provenance" USING btree ("site_id","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_document_media_document_url_unique" ON "lumibase_ingest_document_media" USING btree ("site_id","document_id","normalized_url");--> statement-breakpoint
CREATE INDEX "ingest_document_media_status_idx" ON "lumibase_ingest_document_media" USING btree ("site_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_media_site_hash_unique" ON "lumibase_ingest_media" USING btree ("site_id","sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_media_licences_site_url_unique" ON "lumibase_ingest_media_licences" USING btree ("site_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_research_leads_document_url_unique" ON "lumibase_ingest_research_leads" USING btree ("site_id","origin_document_id","normalized_url");--> statement-breakpoint
CREATE INDEX "ingest_research_leads_status_idx" ON "lumibase_ingest_research_leads" USING btree ("site_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "licence_lapse_reviews_open_unique" ON "lumibase_licence_lapse_reviews" USING btree ("site_id","item_id") WHERE "lumibase_licence_lapse_reviews"."state" = 'open';--> statement-breakpoint
CREATE INDEX "licence_lapse_reviews_state_idx" ON "lumibase_licence_lapse_reviews" USING btree ("site_id","state","detected_at");