CREATE TABLE "lumibase_llm_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"call_id" text NOT NULL,
	"seq" integer NOT NULL,
	"position" integer NOT NULL,
	"previous_attempt_id" text,
	"source" text NOT NULL,
	"provider_id" text,
	"instance_ref" text,
	"snapshot" jsonb NOT NULL,
	"request_digest" text NOT NULL,
	"period" text NOT NULL,
	"outcome" text NOT NULL,
	"billing" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"owner_id" text,
	"lease_until" timestamp with time zone,
	"reserved_micros" bigint NOT NULL,
	"actual_micros" bigint,
	"input_tokens" integer,
	"output_tokens" integer,
	"error_code" text,
	"settled_by" text,
	"reconciliation" jsonb,
	"late_result" jsonb,
	"overspend" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	CONSTRAINT "llm_attempts_call_seq_unique" UNIQUE("site_id","call_id","seq"),
	CONSTRAINT "llm_attempts_site_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "llm_attempts_source_check" CHECK (("lumibase_llm_attempts"."source" = 'site' AND "lumibase_llm_attempts"."provider_id" IS NOT NULL AND "lumibase_llm_attempts"."instance_ref" IS NULL)
       OR ("lumibase_llm_attempts"."source" = 'instance' AND "lumibase_llm_attempts"."provider_id" IS NULL AND "lumibase_llm_attempts"."instance_ref" IS NOT NULL)),
	CONSTRAINT "llm_attempts_outcome_check" CHECK ("lumibase_llm_attempts"."outcome" IN ('in_flight', 'succeeded', 'failed_transferable', 'failed_final', 'lost')),
	CONSTRAINT "llm_attempts_billing_check" CHECK ("lumibase_llm_attempts"."billing" IN ('reserved', 'unknown', 'settled', 'cancelled')),
	CONSTRAINT "llm_attempts_reserved_in_flight_check" CHECK ("lumibase_llm_attempts"."billing" <> 'reserved' OR "lumibase_llm_attempts"."outcome" = 'in_flight'),
	CONSTRAINT "llm_attempts_settled_amount_check" CHECK ("lumibase_llm_attempts"."billing" <> 'settled' OR "lumibase_llm_attempts"."actual_micros" IS NOT NULL),
	CONSTRAINT "llm_attempts_amounts_check" CHECK ("lumibase_llm_attempts"."reserved_micros" >= 0 AND ("lumibase_llm_attempts"."actual_micros" IS NULL OR "lumibase_llm_attempts"."actual_micros" >= 0))
);
--> statement-breakpoint
CREATE TABLE "lumibase_llm_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"call_key" text NOT NULL,
	"task_type" text NOT NULL,
	"origin_kind" text NOT NULL,
	"origin_id" text,
	"request_digest" text NOT NULL,
	"candidates" jsonb NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"terminal_reason" text,
	"cancel_requested_at" timestamp with time zone,
	"owner_id" text,
	"lease_until" timestamp with time zone,
	"winner_attempt_id" text,
	"result" jsonb,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_calls_site_call_key_unique" UNIQUE("site_id","call_key"),
	CONSTRAINT "llm_calls_site_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "llm_calls_status_check" CHECK ("lumibase_llm_calls"."status" IN ('open', 'completed', 'failed')),
	CONSTRAINT "llm_calls_terminal_check" CHECK (("lumibase_llm_calls"."status" = 'open' AND "lumibase_llm_calls"."terminal_reason" IS NULL)
       OR ("lumibase_llm_calls"."status" = 'completed' AND "lumibase_llm_calls"."winner_attempt_id" IS NOT NULL AND "lumibase_llm_calls"."result" IS NOT NULL)
       OR ("lumibase_llm_calls"."status" = 'failed' AND "lumibase_llm_calls"."terminal_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "lumibase_llm_providers" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"secret_ciphertext" text,
	"capabilities" jsonb NOT NULL,
	"probe" jsonb,
	"pricing_kind" text NOT NULL,
	"input_price_micros" bigint,
	"output_price_micros" bigint,
	"request_price_micros" bigint,
	"currency" text NOT NULL,
	"timeout_ms" integer DEFAULT 60000 NOT NULL,
	"disabled_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "llm_providers_site_id_unique" UNIQUE("site_id","id"),
	CONSTRAINT "llm_providers_kind_check" CHECK ("lumibase_llm_providers"."kind" = 'openai_compatible'),
	CONSTRAINT "llm_providers_pricing_check" CHECK (("lumibase_llm_providers"."pricing_kind" = 'per_1m_tokens' AND "lumibase_llm_providers"."input_price_micros" >= 0 AND "lumibase_llm_providers"."output_price_micros" >= 0)
       OR ("lumibase_llm_providers"."pricing_kind" = 'per_request' AND "lumibase_llm_providers"."request_price_micros" >= 0)),
	CONSTRAINT "llm_providers_timeout_check" CHECK ("lumibase_llm_providers"."timeout_ms" > 0)
);
--> statement-breakpoint
CREATE TABLE "lumibase_llm_routes" (
	"site_id" text NOT NULL,
	"task_type" text NOT NULL,
	"position" integer NOT NULL,
	"provider_id" text NOT NULL,
	CONSTRAINT "lumibase_llm_routes_site_id_task_type_position_pk" PRIMARY KEY("site_id","task_type","position"),
	CONSTRAINT "llm_routes_position_check" CHECK ("lumibase_llm_routes"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "lumibase_llm_site_settings" (
	"site_id" text PRIMARY KEY NOT NULL,
	"currency" text NOT NULL,
	"monthly_budget_micros" bigint,
	"budget_timezone" text DEFAULT 'UTC' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_llm_attempts" ADD CONSTRAINT "lumibase_llm_attempts_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_llm_attempts" ADD CONSTRAINT "llm_attempts_call_fk" FOREIGN KEY ("site_id","call_id") REFERENCES "public"."lumibase_llm_calls"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_llm_attempts" ADD CONSTRAINT "llm_attempts_provider_fk" FOREIGN KEY ("site_id","provider_id") REFERENCES "public"."lumibase_llm_providers"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_llm_attempts" ADD CONSTRAINT "llm_attempts_previous_fk" FOREIGN KEY ("site_id","previous_attempt_id") REFERENCES "public"."lumibase_llm_attempts"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_llm_calls" ADD CONSTRAINT "lumibase_llm_calls_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_llm_providers" ADD CONSTRAINT "lumibase_llm_providers_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_llm_routes" ADD CONSTRAINT "lumibase_llm_routes_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_llm_routes" ADD CONSTRAINT "llm_routes_provider_fk" FOREIGN KEY ("site_id","provider_id") REFERENCES "public"."lumibase_llm_providers"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_llm_site_settings" ADD CONSTRAINT "lumibase_llm_site_settings_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "llm_attempts_budget_idx" ON "lumibase_llm_attempts" USING btree ("site_id","period","billing");--> statement-breakpoint
CREATE INDEX "llm_attempts_in_flight_lease_idx" ON "lumibase_llm_attempts" USING btree ("lease_until") WHERE "lumibase_llm_attempts"."outcome" = 'in_flight';--> statement-breakpoint
CREATE INDEX "llm_attempts_unknown_idx" ON "lumibase_llm_attempts" USING btree ("site_id","created_at") WHERE "lumibase_llm_attempts"."billing" = 'unknown';--> statement-breakpoint
CREATE INDEX "llm_calls_open_lease_idx" ON "lumibase_llm_calls" USING btree ("lease_until") WHERE "lumibase_llm_calls"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "llm_providers_site_name_unique" ON "lumibase_llm_providers" USING btree ("site_id","name") WHERE "lumibase_llm_providers"."deleted_at" IS NULL;