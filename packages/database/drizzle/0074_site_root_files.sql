CREATE TABLE "lumibase_site_root_files" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"content" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_site_root_files" ADD CONSTRAINT "lumibase_site_root_files_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_root_files_site_filename" ON "lumibase_site_root_files" USING btree ("site_id","filename");