CREATE TABLE "lumibase_import_batch_items" (
	"batch_id" text NOT NULL,
	"site_id" text NOT NULL,
	"item_id" text NOT NULL,
	"external_id" text NOT NULL,
	"collection" text NOT NULL,
	"pinned_version" integer NOT NULL,
	"safety_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"internal_only" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	CONSTRAINT "lumibase_import_batch_items_batch_id_item_id_pk" PRIMARY KEY("batch_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_import_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"namespace" text NOT NULL,
	"bundle_hash" text NOT NULL,
	"report_hash" text NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"report" jsonb NOT NULL,
	"activation_report" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"imported_at" timestamp with time zone,
	"activated_by" text,
	"activated_at" timestamp with time zone,
	CONSTRAINT "import_batches_status_valid" CHECK ("lumibase_import_batches"."status" IN ('planned', 'imported', 'activated', 'superseded'))
);
--> statement-breakpoint
CREATE TABLE "lumibase_import_external_ids" (
	"site_id" text NOT NULL,
	"namespace" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text NOT NULL,
	"target_id" text NOT NULL,
	"record_hash" text NOT NULL,
	"target_version" integer,
	"batch_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_import_external_ids_site_id_namespace_kind_external_id_pk" PRIMARY KEY("site_id","namespace","kind","external_id"),
	CONSTRAINT "import_external_ids_kind_valid" CHECK ("lumibase_import_external_ids"."kind" IN ('item', 'media', 'group'))
);
--> statement-breakpoint
ALTER TABLE "lumibase_import_batch_items" ADD CONSTRAINT "lumibase_import_batch_items_batch_id_lumibase_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."lumibase_import_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_import_batch_items" ADD CONSTRAINT "lumibase_import_batch_items_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_import_batch_items" ADD CONSTRAINT "lumibase_import_batch_items_item_id_lumibase_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."lumibase_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_import_batches" ADD CONSTRAINT "lumibase_import_batches_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_import_batches" ADD CONSTRAINT "lumibase_import_batches_created_by_lumibase_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_import_batches" ADD CONSTRAINT "lumibase_import_batches_activated_by_lumibase_users_id_fk" FOREIGN KEY ("activated_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_import_external_ids" ADD CONSTRAINT "lumibase_import_external_ids_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_import_external_ids" ADD CONSTRAINT "lumibase_import_external_ids_batch_id_lumibase_import_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."lumibase_import_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batch_items_item" ON "lumibase_import_batch_items" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "import_batches_site_created" ON "lumibase_import_batches" USING btree ("site_id","created_at");