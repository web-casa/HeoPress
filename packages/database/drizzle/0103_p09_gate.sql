CREATE TABLE "lumibase_quality_gate_results" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"production_id" text,
	"collection" text NOT NULL,
	"item_id" text NOT NULL,
	"item_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"policy_hash" text NOT NULL,
	"editorial_profile_version" integer,
	"constitution_hash" text,
	"licence_revisions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text NOT NULL,
	"score" integer NOT NULL,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_gate_results_status_check" CHECK ("lumibase_quality_gate_results"."status" IN ('passed', 'blocked', 'needs_review'))
);
--> statement-breakpoint
CREATE TABLE "lumibase_quality_gate_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"result_id" text NOT NULL,
	"item_id" text NOT NULL,
	"item_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"reviewer_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "quality_gate_reviews_decision_check" CHECK ("lumibase_quality_gate_reviews"."decision" IN ('approve', 'reject'))
);
--> statement-breakpoint
CREATE TABLE "lumibase_quality_gate_settings" (
	"site_id" text PRIMARY KEY NOT NULL,
	"levels" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"thresholds" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_quality_gate_results" ADD CONSTRAINT "lumibase_quality_gate_results_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_quality_gate_results" ADD CONSTRAINT "lumibase_quality_gate_results_production_id_lumibase_ai_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."lumibase_ai_productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_quality_gate_reviews" ADD CONSTRAINT "lumibase_quality_gate_reviews_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_quality_gate_reviews" ADD CONSTRAINT "lumibase_quality_gate_reviews_result_id_lumibase_quality_gate_results_id_fk" FOREIGN KEY ("result_id") REFERENCES "public"."lumibase_quality_gate_results"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_quality_gate_settings" ADD CONSTRAINT "lumibase_quality_gate_settings_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "quality_gate_results_item_idx" ON "lumibase_quality_gate_results" USING btree ("site_id","item_id","created_at");--> statement-breakpoint
CREATE INDEX "quality_gate_results_production_idx" ON "lumibase_quality_gate_results" USING btree ("site_id","production_id","created_at");--> statement-breakpoint
CREATE INDEX "quality_gate_reviews_result_idx" ON "lumibase_quality_gate_reviews" USING btree ("site_id","result_id");