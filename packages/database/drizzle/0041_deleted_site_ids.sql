CREATE TABLE "lumibase_deleted_site_ids" (
	"site_id" text PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
