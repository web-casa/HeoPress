CREATE TABLE "lumibase_notification_channels" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"target_ciphertext" text NOT NULL,
	"target_hint" text NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"link_base_url" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_channels_site_name_unique" UNIQUE("site_id","name"),
	CONSTRAINT "notification_channels_site_id_unique" UNIQUE("site_id","id")
);
--> statement-breakpoint
CREATE TABLE "lumibase_notification_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"event" text NOT NULL,
	"message" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_notification_channels" ADD CONSTRAINT "lumibase_notification_channels_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_notification_deliveries" ADD CONSTRAINT "lumibase_notification_deliveries_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_notification_deliveries" ADD CONSTRAINT "notification_deliveries_channel_fk" FOREIGN KEY ("site_id","channel_id") REFERENCES "public"."lumibase_notification_channels"("site_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_deliveries_due_idx" ON "lumibase_notification_deliveries" USING btree ("site_id","status","next_attempt_at");