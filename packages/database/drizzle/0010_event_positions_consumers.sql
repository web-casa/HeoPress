CREATE SEQUENCE "public"."lumibase_cdc_change_events_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "lumibase_event_consumer_failures" (
	"consumer" text NOT NULL,
	"event_id" text NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 1 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_event_consumer_failures_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_event_consumer_processed" (
	"consumer" text NOT NULL,
	"event_id" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_event_consumer_processed_consumer_event_id_pk" PRIMARY KEY("consumer","event_id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_event_consumers" (
	"name" text PRIMARY KEY NOT NULL,
	"site_id" text,
	"cursor_txid" "xid8",
	"cursor_seq" bigint,
	"status" text DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_cdc_change_events" ADD COLUMN "txid" "xid8" DEFAULT pg_current_xact_id() NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_cdc_change_events" ADD COLUMN "seq" bigint DEFAULT nextval('lumibase_cdc_change_events_seq') NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_cdc_change_events" ADD COLUMN "item_version" integer;--> statement-breakpoint
ALTER TABLE "lumibase_event_consumer_failures" ADD CONSTRAINT "lumibase_event_consumer_failures_consumer_lumibase_event_consumers_name_fk" FOREIGN KEY ("consumer") REFERENCES "public"."lumibase_event_consumers"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_event_consumer_processed" ADD CONSTRAINT "lumibase_event_consumer_processed_consumer_lumibase_event_consumers_name_fk" FOREIGN KEY ("consumer") REFERENCES "public"."lumibase_event_consumers"("name") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_event_consumers" ADD CONSTRAINT "lumibase_event_consumers_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_consumer_failures_due_idx" ON "lumibase_event_consumer_failures" USING btree ("state","next_attempt_at");--> statement-breakpoint
CREATE INDEX "cdc_change_events_position_idx" ON "lumibase_cdc_change_events" USING btree ("txid","seq");--> statement-breakpoint
CREATE INDEX "cdc_change_events_site_position_idx" ON "lumibase_cdc_change_events" USING btree ("site_id","txid","seq");