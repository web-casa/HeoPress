CREATE TABLE "lumibase_projection_dirty" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"txid" bigint NOT NULL,
	"site_id" text,
	"table_name" text NOT NULL,
	"op" text NOT NULL,
	"object_id" text,
	"old" jsonb,
	"new" jsonb
);
--> statement-breakpoint
CREATE TABLE "lumibase_projection_rebuilds" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_public_alternates" (
	"site_id" text NOT NULL,
	"item_id" text NOT NULL,
	"locale" text NOT NULL,
	"url" text NOT NULL,
	"target_item_id" text NOT NULL,
	CONSTRAINT "lumibase_public_alternates_site_id_item_id_target_item_id_pk" PRIMARY KEY("site_id","item_id","target_item_id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_public_hosts" (
	"hostname" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"is_primary" boolean NOT NULL,
	"entry_locale" text,
	"primary_hostname" text
);
--> statement-breakpoint
CREATE TABLE "lumibase_public_items" (
	"item_id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"collection" text NOT NULL,
	"locale" text NOT NULL,
	"path" text NOT NULL,
	"number" integer,
	"data" jsonb NOT NULL,
	"card" jsonb NOT NULL,
	"sponsored" boolean DEFAULT false NOT NULL,
	"sponsor_name" text,
	"published_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	"sanitizer" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_public_path_memory" (
	"item_id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"locale" text NOT NULL,
	"path" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_public_sites" (
	"site_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"default_language" text NOT NULL,
	"settings" jsonb NOT NULL,
	"built_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lumibase_route_tombstones" (
	"site_id" text NOT NULL,
	"locale" text NOT NULL,
	"path" text NOT NULL,
	"item_id" text NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_route_tombstones_site_id_locale_path_pk" PRIMARY KEY("site_id","locale","path")
);
--> statement-breakpoint
CREATE TABLE "lumibase_site_render_versions" (
	"site_id" text PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_public_alternates" ADD CONSTRAINT "lumibase_public_alternates_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_public_hosts" ADD CONSTRAINT "lumibase_public_hosts_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_public_items" ADD CONSTRAINT "lumibase_public_items_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_public_path_memory" ADD CONSTRAINT "lumibase_public_path_memory_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_public_sites" ADD CONSTRAINT "lumibase_public_sites_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_route_tombstones" ADD CONSTRAINT "lumibase_route_tombstones_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_site_render_versions" ADD CONSTRAINT "lumibase_site_render_versions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "projection_dirty_txid" ON "lumibase_projection_dirty" USING btree ("txid");--> statement-breakpoint
CREATE INDEX "projection_rebuilds_site" ON "lumibase_projection_rebuilds" USING btree ("site_id");--> statement-breakpoint
CREATE INDEX "public_items_site_collection" ON "lumibase_public_items" USING btree ("site_id","collection","published_at");--> statement-breakpoint
CREATE INDEX "public_items_site_locale_path" ON "lumibase_public_items" USING btree ("site_id","locale","path");