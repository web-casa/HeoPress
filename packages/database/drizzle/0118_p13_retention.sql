CREATE TABLE "lumibase_deletion_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"request_id" text NOT NULL,
	"object_kind" text NOT NULL,
	"object_scope" text,
	"object_id" text NOT NULL,
	"action" text NOT NULL,
	"erased_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_ledger_object_kind_check" CHECK ("lumibase_deletion_ledger"."object_kind" IN ('item', 'ingest_snapshot')),
	CONSTRAINT "deletion_ledger_action_check" CHECK ("lumibase_deletion_ledger"."action" IN ('hard_delete', 'crypto_shred', 'tombstone'))
);
--> statement-breakpoint
CREATE TABLE "lumibase_retention_holds" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text NOT NULL,
	"opened_by" text,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	"released_by" text,
	CONSTRAINT "retention_holds_target_kind_check" CHECK ("lumibase_retention_holds"."target_kind" IN ('ingest_snapshot'))
);
--> statement-breakpoint
ALTER TABLE "lumibase_ingest_snapshots" ADD COLUMN "content_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_snapshots" ADD COLUMN "deletion_reason" text;--> statement-breakpoint
ALTER TABLE "lumibase_content_provenance" ADD COLUMN "source_missing_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lumibase_content_provenance" ADD COLUMN "source_missing_reason" text;--> statement-breakpoint
ALTER TABLE "lumibase_retention_holds" ADD CONSTRAINT "lumibase_retention_holds_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_ledger_object_unique" ON "lumibase_deletion_ledger" USING btree ("site_id","request_id","object_kind","object_id");--> statement-breakpoint
CREATE INDEX "deletion_ledger_erased_idx" ON "lumibase_deletion_ledger" USING btree ("site_id","erased_at");--> statement-breakpoint
CREATE INDEX "retention_holds_open_idx" ON "lumibase_retention_holds" USING btree ("site_id","target_kind","target_id") WHERE "lumibase_retention_holds"."released_at" IS NULL;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_snapshots" ADD CONSTRAINT "ingest_snapshots_tombstone_check" CHECK (("lumibase_ingest_snapshots"."content_deleted_at" IS NULL AND "lumibase_ingest_snapshots"."deletion_reason" IS NULL) OR ("lumibase_ingest_snapshots"."content_deleted_at" IS NOT NULL AND "lumibase_ingest_snapshots"."deletion_reason" IN ('retention_expired', 'personal_data_erasure')));