CREATE TABLE "lumibase_branch_preview_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"version_id" text NOT NULL,
	"collection" text NOT NULL,
	"item_id" text NOT NULL,
	"created_by" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"exchanged_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_content_versions" ADD COLUMN "base_data" jsonb;--> statement-breakpoint
ALTER TABLE "lumibase_content_versions" ADD COLUMN "base_version" integer;--> statement-breakpoint
ALTER TABLE "lumibase_content_versions" ADD COLUMN "revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_content_versions" ADD COLUMN "state" text DEFAULT 'open' NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_content_versions" ADD COLUMN "merged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lumibase_content_versions" ADD COLUMN "merged_by" text;--> statement-breakpoint
ALTER TABLE "lumibase_branch_preview_grants" ADD CONSTRAINT "lumibase_branch_preview_grants_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_branch_preview_grants" ADD CONSTRAINT "lumibase_branch_preview_grants_version_id_lumibase_content_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."lumibase_content_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_branch_preview_grants" ADD CONSTRAINT "lumibase_branch_preview_grants_created_by_lumibase_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "branch_preview_grants_token_hash_unique" ON "lumibase_branch_preview_grants" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "branch_preview_grants_site_version_idx" ON "lumibase_branch_preview_grants" USING btree ("site_id","version_id");--> statement-breakpoint
ALTER TABLE "lumibase_content_versions" ADD CONSTRAINT "lumibase_content_versions_merged_by_lumibase_users_id_fk" FOREIGN KEY ("merged_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;