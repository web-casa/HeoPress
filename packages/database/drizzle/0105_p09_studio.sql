CREATE TABLE "lumibase_flow_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"trigger_type" text NOT NULL,
	"trigger_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"graph" jsonb NOT NULL,
	"drafted_by" text,
	"drafted_via" text NOT NULL,
	"api_key_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"approval_mode" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"verification" text,
	"flow_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flow_drafts_status_check" CHECK ("lumibase_flow_drafts"."status" IN ('pending', 'approved', 'rejected')),
	CONSTRAINT "flow_drafts_via_check" CHECK ("lumibase_flow_drafts"."drafted_via" IN ('agent', 'studio'))
);
--> statement-breakpoint
ALTER TABLE "lumibase_system_state" ADD COLUMN "approval_mode" text DEFAULT 'solo' NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_flow_drafts" ADD CONSTRAINT "lumibase_flow_drafts_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "flow_drafts_site_idx" ON "lumibase_flow_drafts" USING btree ("site_id","status","created_at");--> statement-breakpoint
ALTER TABLE "lumibase_system_state" ADD CONSTRAINT "system_state_approval_mode_chk" CHECK ("lumibase_system_state"."approval_mode" IN ('solo', 'team'));