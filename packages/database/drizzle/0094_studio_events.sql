CREATE TABLE "lumibase_system_events" (
	"id" text PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" text NOT NULL,
	"source" text NOT NULL,
	"event" text NOT NULL,
	"message" text NOT NULL,
	"actor" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "system_events_level" CHECK ("lumibase_system_events"."level" IN ('info', 'warn', 'error'))
);
--> statement-breakpoint
CREATE INDEX "system_events_occurred_at" ON "lumibase_system_events" USING btree ("occurred_at");--> statement-breakpoint
CREATE INDEX "content_reviews_site_created_idx" ON "lumibase_content_reviews" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "content_reviews_site_decided_idx" ON "lumibase_content_reviews" USING btree ("site_id","decided_at");