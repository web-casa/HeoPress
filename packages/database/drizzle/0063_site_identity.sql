CREATE TABLE "lumibase_site_identity" (
	"site_id" text PRIMARY KEY NOT NULL,
	"identity" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_public_sites" ADD COLUMN "identity" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_site_identity" ADD CONSTRAINT "lumibase_site_identity_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;