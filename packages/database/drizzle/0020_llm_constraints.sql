ALTER TABLE "lumibase_llm_calls" DROP CONSTRAINT "llm_calls_terminal_check";--> statement-breakpoint
ALTER TABLE "lumibase_llm_providers" DROP CONSTRAINT "llm_providers_pricing_check";--> statement-breakpoint
ALTER TABLE "lumibase_llm_attempts" DROP CONSTRAINT "llm_attempts_previous_fk";
--> statement-breakpoint
ALTER TABLE "lumibase_llm_attempts" ADD CONSTRAINT "llm_attempts_site_call_id_unique" UNIQUE("site_id","call_id","id");--> statement-breakpoint
ALTER TABLE "lumibase_llm_attempts" ADD CONSTRAINT "llm_attempts_previous_fk" FOREIGN KEY ("site_id","call_id","previous_attempt_id") REFERENCES "public"."lumibase_llm_attempts"("site_id","call_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_llm_calls" ADD CONSTRAINT "llm_calls_terminal_check" CHECK (("lumibase_llm_calls"."status" = 'open' AND "lumibase_llm_calls"."terminal_reason" IS NULL AND "lumibase_llm_calls"."winner_attempt_id" IS NULL AND "lumibase_llm_calls"."result" IS NULL)
       OR ("lumibase_llm_calls"."status" = 'completed' AND "lumibase_llm_calls"."terminal_reason" IS NULL AND "lumibase_llm_calls"."winner_attempt_id" IS NOT NULL AND "lumibase_llm_calls"."result" IS NOT NULL)
       OR ("lumibase_llm_calls"."status" = 'failed' AND "lumibase_llm_calls"."terminal_reason" IS NOT NULL AND "lumibase_llm_calls"."winner_attempt_id" IS NULL AND "lumibase_llm_calls"."result" IS NULL));--> statement-breakpoint
ALTER TABLE "lumibase_llm_providers" ADD CONSTRAINT "llm_providers_pricing_check" CHECK (("lumibase_llm_providers"."pricing_kind" = 'per_1m_tokens' AND "lumibase_llm_providers"."input_price_micros" IS NOT NULL AND "lumibase_llm_providers"."output_price_micros" IS NOT NULL
            AND "lumibase_llm_providers"."input_price_micros" >= 0 AND "lumibase_llm_providers"."output_price_micros" >= 0)
       OR ("lumibase_llm_providers"."pricing_kind" = 'per_request' AND "lumibase_llm_providers"."request_price_micros" IS NOT NULL AND "lumibase_llm_providers"."request_price_micros" >= 0));