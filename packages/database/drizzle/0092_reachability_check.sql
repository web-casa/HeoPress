CREATE TABLE "lumibase_reachability_reports" (
	"site_id" text PRIMARY KEY NOT NULL,
	"report" jsonb NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"warnings" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_reachability_sites" (
	"site_id" text PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone,
	"platform" text DEFAULT 'vps' NOT NULL,
	"hosts" text[],
	"last_run_at" timestamp with time zone,
	"status" text,
	"last_error" text,
	"leased_until" timestamp with time zone,
	"lease_token" text,
	CONSTRAINT "reachability_sites_platform" CHECK ("lumibase_reachability_sites"."platform" IN ('vps', 'cloudflare', 'cloudflare-pages', 'vercel', 'netlify'))
);
--> statement-breakpoint
ALTER TABLE "lumibase_reachability_reports" ADD CONSTRAINT "lumibase_reachability_reports_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_reachability_sites" ADD CONSTRAINT "lumibase_reachability_sites_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;