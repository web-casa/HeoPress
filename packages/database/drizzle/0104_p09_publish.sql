CREATE TABLE "lumibase_auto_publish_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"production_id" text,
	"collection" text NOT NULL,
	"item_id" text NOT NULL,
	"item_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"gate_result_id" text,
	"licence_revisions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"autonomy_level" integer NOT NULL,
	"settings_version" integer NOT NULL,
	"status" text NOT NULL,
	"reason" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"not_before" timestamp with time zone,
	"published_at" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_publish_candidates_status_check" CHECK ("lumibase_auto_publish_candidates"."status" IN ('review', 'veto_window', 'queued', 'published', 'superseded', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "lumibase_auto_publish_days" (
	"site_id" text NOT NULL,
	"day" text NOT NULL,
	"published" integer DEFAULT 0 NOT NULL,
	"last_published_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_auto_publish_days_site_id_day_pk" PRIMARY KEY("site_id","day")
);
--> statement-breakpoint
CREATE TABLE "lumibase_auto_publish_settings" (
	"site_id" text PRIMARY KEY NOT NULL,
	"agent_role" text DEFAULT 'content-pipeline' NOT NULL,
	"veto_window_minutes" integer DEFAULT 30 NOT NULL,
	"daily_limit" integer,
	"min_interval_minutes" integer DEFAULT 0 NOT NULL,
	"source_max_age_days" integer DEFAULT 60 NOT NULL,
	"freshness_exempt_collections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_locales" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_auto_publish_candidates" ADD CONSTRAINT "lumibase_auto_publish_candidates_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_auto_publish_candidates" ADD CONSTRAINT "lumibase_auto_publish_candidates_production_id_lumibase_ai_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."lumibase_ai_productions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_auto_publish_days" ADD CONSTRAINT "lumibase_auto_publish_days_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_auto_publish_settings" ADD CONSTRAINT "lumibase_auto_publish_settings_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auto_publish_candidates_open_unique" ON "lumibase_auto_publish_candidates" USING btree ("site_id","item_id") WHERE "lumibase_auto_publish_candidates"."status" IN ('review', 'veto_window', 'queued');--> statement-breakpoint
CREATE INDEX "auto_publish_candidates_due_idx" ON "lumibase_auto_publish_candidates" USING btree ("status","not_before");--> statement-breakpoint
CREATE INDEX "auto_publish_candidates_site_idx" ON "lumibase_auto_publish_candidates" USING btree ("site_id","status","created_at");