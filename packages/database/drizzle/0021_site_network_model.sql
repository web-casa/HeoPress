CREATE TABLE "lumibase_item_numbers" (
	"site_id" text NOT NULL,
	"collection_id" text NOT NULL,
	"last" integer NOT NULL,
	CONSTRAINT "lumibase_item_numbers_site_id_collection_id_pk" PRIMARY KEY("site_id","collection_id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_site_content_settings" (
	"site_id" text PRIMARY KEY NOT NULL,
	"available_locales" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"site_type" text DEFAULT 'blog' NOT NULL,
	"trailing_slash" text DEFAULT 'always' NOT NULL,
	"locale_strategy" text DEFAULT 'subdirectory' NOT NULL,
	"locale_prefix_mode" text DEFAULT 'default_at_root' NOT NULL,
	"locale_prefixes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"permalinks" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allow_cross_site_translations" boolean DEFAULT false NOT NULL,
	"sponsor_disclosure" boolean DEFAULT true NOT NULL,
	"sponsor_rel" boolean DEFAULT true NOT NULL,
	"sponsor_policy_version" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_content_settings_trailing_slash_valid" CHECK ("lumibase_site_content_settings"."trailing_slash" IN ('always', 'never')),
	CONSTRAINT "site_content_settings_locale_strategy_valid" CHECK ("lumibase_site_content_settings"."locale_strategy" IN ('subdirectory', 'subdomain', 'domain')),
	CONSTRAINT "site_content_settings_locale_prefix_mode_valid" CHECK ("lumibase_site_content_settings"."locale_prefix_mode" IN ('default_at_root', 'all_prefixed'))
);
--> statement-breakpoint
CREATE TABLE "lumibase_site_presets" (
	"site_id" text NOT NULL,
	"preset" text NOT NULL,
	"version" integer NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"upgraded_at" timestamp with time zone,
	CONSTRAINT "lumibase_site_presets_site_id_preset_pk" PRIMARY KEY("site_id","preset")
);
--> statement-breakpoint
ALTER TABLE "lumibase_items" ADD COLUMN "number" integer;--> statement-breakpoint
ALTER TABLE "lumibase_items" ADD COLUMN "published_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lumibase_items" ADD COLUMN "published_at_source" text;--> statement-breakpoint
ALTER TABLE "lumibase_item_numbers" ADD CONSTRAINT "lumibase_item_numbers_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_item_numbers" ADD CONSTRAINT "lumibase_item_numbers_collection_id_lumibase_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."lumibase_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_site_content_settings" ADD CONSTRAINT "lumibase_site_content_settings_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_site_presets" ADD CONSTRAINT "lumibase_site_presets_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "items_site_collection_number_unique" ON "lumibase_items" USING btree ("site_id","collection_id","number");--> statement-breakpoint
ALTER TABLE "lumibase_items" ADD CONSTRAINT "items_number_positive" CHECK ("lumibase_items"."number" IS NULL OR "lumibase_items"."number" > 0);--> statement-breakpoint
ALTER TABLE "lumibase_items" ADD CONSTRAINT "items_published_at_source_valid" CHECK ("lumibase_items"."published_at_source" IS NULL OR "lumibase_items"."published_at_source" IN ('recorded', 'set', 'estimated', 'unknown'));--> statement-breakpoint
-- HeoPress P05 back-fill (design R11, R25, R28). One content settings row per
-- existing site: its default language is its only language until changed.
INSERT INTO "lumibase_site_content_settings" ("site_id", "available_locales")
SELECT "id", jsonb_build_array("default_language") FROM "lumibase_sites"
ON CONFLICT ("site_id") DO NOTHING;--> statement-breakpoint
-- Item numbers in creation order per site and collection, only for items without one: numbers already
-- given are kept, the new ones follow the highest in use (or the counter's, whichever is higher).
WITH used AS (
  SELECT i."site_id", i."collection_id",
         greatest(coalesce(max(i."number"), 0), coalesce(max(n."last"), 0)) AS top
    FROM "lumibase_items" i
    LEFT JOIN "lumibase_item_numbers" n ON n."site_id" = i."site_id" AND n."collection_id" = i."collection_id"
   GROUP BY i."site_id", i."collection_id"
), numbered AS (
  SELECT i."id", u.top + row_number() OVER (PARTITION BY i."site_id", i."collection_id" ORDER BY i."created_at", i."id") AS n
    FROM "lumibase_items" i
    JOIN used u ON u."site_id" = i."site_id" AND u."collection_id" = i."collection_id"
   WHERE i."number" IS NULL
)
UPDATE "lumibase_items" i
   SET "number" = numbered.n
  FROM numbered
 WHERE i."id" = numbered."id";--> statement-breakpoint
INSERT INTO "lumibase_item_numbers" ("site_id", "collection_id", "last")
SELECT "site_id", "collection_id", max("number") FROM "lumibase_items" WHERE "number" IS NOT NULL GROUP BY "site_id", "collection_id"
ON CONFLICT ("site_id", "collection_id") DO UPDATE SET "last" = greatest("lumibase_item_numbers"."last", EXCLUDED."last");--> statement-breakpoint
-- First publish times are unknown for existing items: published ones get their
-- creation time as an estimate; the others are marked unknown (they may have
-- been published before).
UPDATE "lumibase_items" SET "published_at" = "created_at", "published_at_source" = 'estimated'
 WHERE "status" = 'published' AND "published_at_source" IS NULL;--> statement-breakpoint
UPDATE "lumibase_items" SET "published_at_source" = 'unknown'
 WHERE "published_at_source" IS NULL;
