CREATE TABLE "lumibase_shared_field_syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"group_id" text NOT NULL,
	"source_item_id" text NOT NULL,
	"source_epoch" integer NOT NULL,
	"source_version" integer NOT NULL,
	"target_item_id" text NOT NULL,
	"fields" text[] NOT NULL,
	"values" jsonb NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"reason" text,
	"notified_at" timestamp with time zone,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "shared_field_syncs_status_valid" CHECK ("lumibase_shared_field_syncs"."status" IN ('pending', 'applied', 'blocked_permission', 'blocked_hold', 'superseded'))
);
--> statement-breakpoint
ALTER TABLE "lumibase_shared_field_syncs" ADD CONSTRAINT "lumibase_shared_field_syncs_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_shared_field_syncs" ADD CONSTRAINT "lumibase_shared_field_syncs_group_id_lumibase_translation_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."lumibase_translation_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_shared_field_syncs" ADD CONSTRAINT "lumibase_shared_field_syncs_target_item_id_lumibase_items_id_fk" FOREIGN KEY ("target_item_id") REFERENCES "public"."lumibase_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "shared_field_syncs_intent_unique" ON "lumibase_shared_field_syncs" USING btree ("target_item_id","source_item_id","source_epoch","source_version");--> statement-breakpoint
CREATE INDEX "shared_field_syncs_group_status" ON "lumibase_shared_field_syncs" USING btree ("group_id","status");