CREATE TABLE "lumibase_backup_drills" (
	"id" text PRIMARY KEY NOT NULL,
	"backup_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"report" jsonb,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "backup_drills_status_valid" CHECK ("lumibase_backup_drills"."status" IN ('queued', 'running', 'passed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "lumibase_backups" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"method" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"trigger" text DEFAULT 'schedule' NOT NULL,
	"parent_id" text,
	"base_id" text,
	"target" text,
	"manifest_sha256" text,
	"size_bytes" bigint,
	"object_count" integer,
	"media_objects" integer,
	"media_new" integer,
	"encrypted" boolean DEFAULT false NOT NULL,
	"key_id" text,
	"recovery_point" timestamp with time zone,
	"error" text,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	CONSTRAINT "backups_kind_valid" CHECK ("lumibase_backups"."kind" IN ('full', 'incremental')),
	CONSTRAINT "backups_method_valid" CHECK ("lumibase_backups"."method" IN ('basebackup', 'dump')),
	CONSTRAINT "backups_status_valid" CHECK ("lumibase_backups"."status" IN ('queued', 'running', 'succeeded', 'failed', 'removed')),
	CONSTRAINT "backups_chain_valid" CHECK (("lumibase_backups"."kind" = 'full' AND "lumibase_backups"."parent_id" IS NULL) OR ("lumibase_backups"."kind" = 'incremental' AND "lumibase_backups"."parent_id" IS NOT NULL AND "lumibase_backups"."base_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "lumibase_site_exports" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"location" text,
	"bundle_hash" text,
	"items" integer,
	"media" integer,
	"report" jsonb,
	"error" text,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "site_exports_status_valid" CHECK ("lumibase_site_exports"."status" IN ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "lumibase_backups" ADD CONSTRAINT "backups_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."lumibase_backups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_backups" ADD CONSTRAINT "backups_base_fk" FOREIGN KEY ("base_id") REFERENCES "public"."lumibase_backups"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_site_exports" ADD CONSTRAINT "lumibase_site_exports_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_drills_created" ON "lumibase_backup_drills" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "backups_created" ON "lumibase_backups" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "backups_status" ON "lumibase_backups" USING btree ("status");--> statement-breakpoint
CREATE INDEX "site_exports_site_created" ON "lumibase_site_exports" USING btree ("site_id","created_at");