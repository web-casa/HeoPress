CREATE TABLE "lumibase_indexnow_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"event_id" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"leased_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_indexnow_sites" (
	"site_id" text PRIMARY KEY NOT NULL,
	"seeded_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"pushed_urls" integer DEFAULT 0 NOT NULL,
	"leased_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lumibase_indexnow_state" (
	"site_id" text NOT NULL,
	"url" text NOT NULL,
	"fingerprint" text NOT NULL,
	"pushed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_indexnow_state_site_id_url_pk" PRIMARY KEY("site_id","url")
);
--> statement-breakpoint
ALTER TABLE "lumibase_indexnow_queue" ADD CONSTRAINT "lumibase_indexnow_queue_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_indexnow_sites" ADD CONSTRAINT "lumibase_indexnow_sites_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_indexnow_state" ADD CONSTRAINT "lumibase_indexnow_state_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "indexnow_queue_event" ON "lumibase_indexnow_queue" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "indexnow_queue_due" ON "lumibase_indexnow_queue" USING btree ("due_at");