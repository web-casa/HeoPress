CREATE TABLE "lumibase_link_edges" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"origin" text NOT NULL,
	"source_item_id" text,
	"source_label" text,
	"field" text,
	"position" integer DEFAULT 0 NOT NULL,
	"href" text NOT NULL,
	"target_url" text NOT NULL,
	"target_locale" text,
	"target_path" text,
	"fragment" text,
	"anchor_text" text DEFAULT '' NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" text,
	CONSTRAINT "link_edges_origin" CHECK ("lumibase_link_edges"."origin" IN ('auto', 'manual'))
);
--> statement-breakpoint
CREATE TABLE "lumibase_link_scans" (
	"site_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"cursor" text,
	"processed" integer DEFAULT 0 NOT NULL,
	"rerun" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone,
	"last_error" text,
	"finished_at" timestamp with time zone,
	"leased_until" timestamp with time zone,
	"lease_token" text
);
--> statement-breakpoint
ALTER TABLE "lumibase_link_edges" ADD CONSTRAINT "lumibase_link_edges_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_link_scans" ADD CONSTRAINT "lumibase_link_scans_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "link_edges_site_source" ON "lumibase_link_edges" USING btree ("site_id","source_item_id");--> statement-breakpoint
CREATE INDEX "link_edges_site_target" ON "lumibase_link_edges" USING btree ("site_id","target_locale","target_path");