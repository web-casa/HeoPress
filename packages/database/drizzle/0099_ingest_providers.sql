CREATE TABLE "lumibase_ingest_provider_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"provider" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"consent_at" timestamp with time zone,
	"consent_by" text,
	"credential_ciphertext" text,
	"credential_key_id" text,
	"credential_hint" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"monthly_budget_micros" bigint,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"paused_until" timestamp with time zone,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_provider_usage" (
	"site_id" text NOT NULL,
	"provider" text NOT NULL,
	"month" text NOT NULL,
	"requests" integer DEFAULT 0 NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"exhausted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_ingest_provider_usage_site_id_provider_month_pk" PRIMARY KEY("site_id","provider","month")
);
--> statement-breakpoint
CREATE TABLE "lumibase_ingest_source_fetch_chains" (
	"site_id" text NOT NULL,
	"source_id" text NOT NULL,
	"chain" text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_ingest_source_fetch_chains_site_id_source_id_pk" PRIMARY KEY("site_id","source_id")
);
--> statement-breakpoint
ALTER TABLE "lumibase_ingest_provider_settings" ADD CONSTRAINT "lumibase_ingest_provider_settings_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_provider_usage" ADD CONSTRAINT "lumibase_ingest_provider_usage_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_fetch_chains" ADD CONSTRAINT "lumibase_ingest_source_fetch_chains_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ingest_source_fetch_chains" ADD CONSTRAINT "ingest_source_fetch_chains_source_fk" FOREIGN KEY ("site_id","source_id") REFERENCES "public"."lumibase_ingest_sources"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ingest_provider_settings_site_provider_unique" ON "lumibase_ingest_provider_settings" USING btree ("site_id","provider");