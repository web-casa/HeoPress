CREATE TABLE "lumibase_astro_builds" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"generation" integer NOT NULL,
	"revision" bigint,
	"theme" text NOT NULL,
	"status" text DEFAULT 'building' NOT NULL,
	"reason" text NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"deadline_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_astro_sites" (
	"site_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"theme" text NOT NULL,
	"requested_at" timestamp with time zone,
	"first_requested_at" timestamp with time zone,
	"generation" integer DEFAULT 0 NOT NULL,
	"active_generation" integer,
	"active_revision" bigint,
	"active_theme" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_astro_builds" ADD CONSTRAINT "lumibase_astro_builds_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_astro_sites" ADD CONSTRAINT "lumibase_astro_sites_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "astro_builds_site_generation_unique" ON "lumibase_astro_builds" USING btree ("site_id","generation");--> statement-breakpoint
CREATE INDEX "astro_builds_status_idx" ON "lumibase_astro_builds" USING btree ("status","deadline_at");