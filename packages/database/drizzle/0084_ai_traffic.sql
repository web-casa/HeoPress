CREATE TABLE "lumibase_crawl_daily" (
	"site_id" text NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"agent" text NOT NULL,
	"operator" text NOT NULL,
	"purpose" text DEFAULT '' NOT NULL,
	"resource" text NOT NULL,
	"path" text NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "lumibase_crawl_daily_site_id_day_kind_agent_resource_path_pk" PRIMARY KEY("site_id","day","kind","agent","resource","path")
);
--> statement-breakpoint
CREATE TABLE "lumibase_crawl_hits" (
	"id" text PRIMARY KEY DEFAULT gen_random_uuid()::text NOT NULL,
	"site_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"agent" text NOT NULL,
	"operator" text NOT NULL,
	"purpose" text,
	"resource" text NOT NULL,
	"path" text NOT NULL,
	"ip_hash" text,
	"status" integer NOT NULL,
	CONSTRAINT "crawl_hits_kind" CHECK ("lumibase_crawl_hits"."kind" IN ('crawler', 'referral'))
);
--> statement-breakpoint
ALTER TABLE "lumibase_crawl_daily" ADD CONSTRAINT "lumibase_crawl_daily_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_crawl_hits" ADD CONSTRAINT "lumibase_crawl_hits_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "crawl_daily_site_day" ON "lumibase_crawl_daily" USING btree ("site_id","day");--> statement-breakpoint
CREATE INDEX "crawl_hits_site_at" ON "lumibase_crawl_hits" USING btree ("site_id","at");