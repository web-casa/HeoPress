CREATE TABLE "lumibase_external_actions" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"site_id" text,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"state" text DEFAULT 'not_sent' NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"in_flight_until" timestamp with time zone,
	"key_expires_at" timestamp with time zone,
	"last_error" text,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "external_actions_paused_idx" ON "lumibase_external_actions" USING btree ("site_id","paused");