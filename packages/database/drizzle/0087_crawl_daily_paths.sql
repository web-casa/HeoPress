CREATE TABLE "lumibase_crawl_daily_paths" (
	"site_id" text NOT NULL,
	"day" date NOT NULL,
	"path" text NOT NULL,
	CONSTRAINT "lumibase_crawl_daily_paths_site_id_day_path_pk" PRIMARY KEY("site_id","day","path")
);
--> statement-breakpoint
ALTER TABLE "lumibase_crawl_daily_paths" ADD CONSTRAINT "lumibase_crawl_daily_paths_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;