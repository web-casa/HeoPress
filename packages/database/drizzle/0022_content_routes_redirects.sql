CREATE TABLE "lumibase_content_routes" (
	"site_id" text NOT NULL,
	"item_id" text PRIMARY KEY NOT NULL,
	"collection_id" text NOT NULL,
	"locale" text NOT NULL,
	"path" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_redirects" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"scope" text DEFAULT 'content' NOT NULL,
	"locale" text DEFAULT '' NOT NULL,
	"from_path" text NOT NULL,
	"match" text DEFAULT 'exact' NOT NULL,
	"to_path" text NOT NULL,
	"to_locale" text DEFAULT '' NOT NULL,
	"status" integer DEFAULT 301 NOT NULL,
	"source" text NOT NULL,
	"import_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redirects_scope_valid" CHECK ("lumibase_redirects"."scope" IN ('content', 'url')),
	CONSTRAINT "redirects_match_valid" CHECK ("lumibase_redirects"."match" IN ('exact', 'prefix')),
	CONSTRAINT "redirects_status_valid" CHECK ("lumibase_redirects"."status" IN (301, 302, 307, 308))
);
--> statement-breakpoint
ALTER TABLE "lumibase_content_routes" ADD CONSTRAINT "lumibase_content_routes_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_routes" ADD CONSTRAINT "lumibase_content_routes_item_id_lumibase_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."lumibase_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_content_routes" ADD CONSTRAINT "lumibase_content_routes_collection_id_lumibase_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."lumibase_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_redirects" ADD CONSTRAINT "lumibase_redirects_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "content_routes_site_locale_path_unique" ON "lumibase_content_routes" USING btree ("site_id","locale","path");--> statement-breakpoint
CREATE UNIQUE INDEX "redirects_site_scope_locale_from_match_unique" ON "lumibase_redirects" USING btree ("site_id","scope","locale","from_path","match");