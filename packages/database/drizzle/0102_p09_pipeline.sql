CREATE TABLE "lumibase_ai_production_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"production_id" text NOT NULL,
	"step" text NOT NULL,
	"capability" text,
	"call_id" text,
	"provider" text,
	"model" text,
	"prompt_version" text,
	"editorial_profile_version" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micros" bigint,
	"outcome" text DEFAULT 'ok' NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_ai_productions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"mode" text NOT NULL,
	"target_locale" text,
	"collection" text NOT NULL,
	"sources" jsonb NOT NULL,
	"prompt_version" text NOT NULL,
	"editorial_profile_version" integer,
	"status" text DEFAULT 'running' NOT NULL,
	"status_reason" text,
	"value_score" integer,
	"value_reasons" jsonb,
	"value_threshold" integer,
	"item_id" text,
	"content_version_key" text,
	"block_map" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"gate" jsonb,
	"publish_proposal" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"not_before" timestamp with time zone,
	"flow_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_productions_mode_check" CHECK ("lumibase_ai_productions"."mode" IN ('translate', 'rewrite', 'write', 'retranslate')),
	CONSTRAINT "ai_productions_status_check" CHECK ("lumibase_ai_productions"."status" IN ('running', 'drafted', 'low_value', 'refused_usage', 'terminated', 'retry_scheduled', 'failed', 'nothing_to_do'))
);
--> statement-breakpoint
ALTER TABLE "lumibase_llm_site_settings" ADD COLUMN "value_threshold" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_ai_production_steps" ADD CONSTRAINT "lumibase_ai_production_steps_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ai_production_steps" ADD CONSTRAINT "lumibase_ai_production_steps_production_id_lumibase_ai_productions_id_fk" FOREIGN KEY ("production_id") REFERENCES "public"."lumibase_ai_productions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_ai_productions" ADD CONSTRAINT "lumibase_ai_productions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_production_steps_production_idx" ON "lumibase_ai_production_steps" USING btree ("production_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_productions_site_key_unique" ON "lumibase_ai_productions" USING btree ("site_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "ai_productions_item_idx" ON "lumibase_ai_productions" USING btree ("site_id","item_id");