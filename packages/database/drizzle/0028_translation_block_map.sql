CREATE TABLE "lumibase_translation_block_map" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"group_id" text NOT NULL,
	"source_item_id" text NOT NULL,
	"source_key" text NOT NULL,
	"source_hash" text NOT NULL,
	"target_item_id" text NOT NULL,
	"target_key" text NOT NULL,
	"target_hash" text NOT NULL,
	"stale" boolean DEFAULT false NOT NULL,
	"stale_reason" text,
	"human_edited" boolean DEFAULT false NOT NULL,
	"mapped_by" text,
	"mapped_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translation_block_map_reason_valid" CHECK ("lumibase_translation_block_map"."stale_reason" IS NULL OR "lumibase_translation_block_map"."stale_reason" IN ('changed', 'deleted', 'moved', 'source_changed', 'source_removed'))
);
--> statement-breakpoint
CREATE TABLE "lumibase_translation_source_baselines" (
	"site_id" text NOT NULL,
	"source_item_id" text NOT NULL,
	"field" text NOT NULL,
	"block_order" text[] NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_translation_source_baselines_source_item_id_field_pk" PRIMARY KEY("source_item_id","field")
);
--> statement-breakpoint
ALTER TABLE "lumibase_translation_block_map" ADD CONSTRAINT "lumibase_translation_block_map_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_translation_block_map" ADD CONSTRAINT "lumibase_translation_block_map_group_id_lumibase_translation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."lumibase_translation_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_translation_block_map" ADD CONSTRAINT "lumibase_translation_block_map_target_item_id_lumibase_items_id_fk" FOREIGN KEY ("target_item_id") REFERENCES "public"."lumibase_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_translation_source_baselines" ADD CONSTRAINT "lumibase_translation_source_baselines_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_translation_source_baselines" ADD CONSTRAINT "lumibase_translation_source_baselines_source_item_id_lumibase_items_id_fk" FOREIGN KEY ("source_item_id") REFERENCES "public"."lumibase_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "translation_block_map_target_unique" ON "lumibase_translation_block_map" USING btree ("target_item_id","target_key");--> statement-breakpoint
CREATE INDEX "translation_block_map_source" ON "lumibase_translation_block_map" USING btree ("source_item_id");