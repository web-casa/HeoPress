CREATE TABLE "lumibase_ai_pipeline_pauses" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"reason" text NOT NULL,
	"period" text,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" text,
	CONSTRAINT "ai_pipeline_pauses_reason_check" CHECK ("lumibase_ai_pipeline_pauses"."reason" IN ('budget', 'manual', 'incident')),
	CONSTRAINT "ai_pipeline_pauses_period_check" CHECK (("lumibase_ai_pipeline_pauses"."reason" = 'budget') = ("lumibase_ai_pipeline_pauses"."period" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "lumibase_ai_processing_days" (
	"site_id" text NOT NULL,
	"day" text NOT NULL,
	"admitted" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_ai_processing_days_site_id_day_pk" PRIMARY KEY("site_id","day"),
	CONSTRAINT "ai_processing_days_admitted_check" CHECK ("lumibase_ai_processing_days"."admitted" >= 0)
);
--> statement-breakpoint
ALTER TABLE "lumibase_llm_calls" ADD COLUMN "capability" text;--> statement-breakpoint
ALTER TABLE "lumibase_llm_site_settings" ADD COLUMN "daily_budget_micros" bigint;--> statement-breakpoint
ALTER TABLE "lumibase_llm_site_settings" ADD COLUMN "daily_processing_limit" integer;--> statement-breakpoint
ALTER TABLE "lumibase_ai_pipeline_pauses" ADD CONSTRAINT "lumibase_ai_pipeline_pauses_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ai_processing_days" ADD CONSTRAINT "lumibase_ai_processing_days_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_pipeline_pauses_active_unique" ON "lumibase_ai_pipeline_pauses" USING btree ("site_id","reason") WHERE "lumibase_ai_pipeline_pauses"."lifted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "llm_attempts_site_created_idx" ON "lumibase_llm_attempts" USING btree ("site_id","created_at");