CREATE TABLE "lumibase_translation_group_members" (
	"item_id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"site_id" text NOT NULL,
	"collection_id" text NOT NULL,
	"locale" text NOT NULL,
	"role" text DEFAULT 'translation' NOT NULL,
	"internal_only" boolean DEFAULT false NOT NULL,
	"joined_by" text,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translation_group_members_role_valid" CHECK ("lumibase_translation_group_members"."role" IN ('source', 'translation')),
	CONSTRAINT "translation_group_members_internal_only_source" CHECK (NOT "lumibase_translation_group_members"."internal_only" OR "lumibase_translation_group_members"."role" = 'source')
);
--> statement-breakpoint
CREATE TABLE "lumibase_translation_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"site_ids" text[] NOT NULL,
	"source_item_id" text,
	"source_epoch" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_translation_group_members" ADD CONSTRAINT "lumibase_translation_group_members_item_id_lumibase_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."lumibase_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_translation_group_members" ADD CONSTRAINT "lumibase_translation_group_members_group_id_lumibase_translation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."lumibase_translation_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_translation_group_members" ADD CONSTRAINT "lumibase_translation_group_members_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_translation_group_members" ADD CONSTRAINT "lumibase_translation_group_members_collection_id_lumibase_collections_id_fk" FOREIGN KEY ("collection_id") REFERENCES "public"."lumibase_collections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_translation_groups" ADD CONSTRAINT "lumibase_translation_groups_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "translation_group_members_group_locale" ON "lumibase_translation_group_members" USING btree ("group_id","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "translation_group_members_one_source" ON "lumibase_translation_group_members" USING btree ("group_id") WHERE "lumibase_translation_group_members"."role" = 'source';