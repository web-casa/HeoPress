CREATE TABLE "lumibase_editorial_profile_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_by" text,
	"published_at" timestamp with time zone,
	CONSTRAINT "editorial_profile_versions_status_valid" CHECK ("lumibase_editorial_profile_versions"."status" IN ('draft', 'published', 'superseded')),
	CONSTRAINT "editorial_profile_versions_version_positive" CHECK ("lumibase_editorial_profile_versions"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "lumibase_agent_runs" ADD COLUMN "editorial_profile_version" integer;--> statement-breakpoint
ALTER TABLE "lumibase_editorial_profile_versions" ADD CONSTRAINT "lumibase_editorial_profile_versions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "editorial_profile_versions_site_version_unique" ON "lumibase_editorial_profile_versions" USING btree ("site_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "editorial_profile_versions_one_published" ON "lumibase_editorial_profile_versions" USING btree ("site_id") WHERE "lumibase_editorial_profile_versions"."status" = 'published';