CREATE TABLE "lumibase_audit_issue_resolutions" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"rule" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"item_ids" text[] DEFAULT '{}' NOT NULL,
	"pages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"admin_only" boolean DEFAULT false NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_audit_issue_states" (
	"site_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"decided_by" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	"until" timestamp with time zone NOT NULL,
	CONSTRAINT "lumibase_audit_issue_states_site_id_fingerprint_pk" PRIMARY KEY("site_id","fingerprint"),
	CONSTRAINT "audit_issue_states_status" CHECK ("lumibase_audit_issue_states"."status" IN ('ignored'))
);
--> statement-breakpoint
ALTER TABLE "lumibase_audit_issue_resolutions" ADD CONSTRAINT "lumibase_audit_issue_resolutions_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_audit_issue_states" ADD CONSTRAINT "lumibase_audit_issue_states_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_issue_resolutions_site_resolved" ON "lumibase_audit_issue_resolutions" USING btree ("site_id","resolved_at");--> statement-breakpoint
CREATE INDEX "audit_issue_resolutions_resolved" ON "lumibase_audit_issue_resolutions" USING btree ("resolved_at");--> statement-breakpoint
CREATE INDEX "audit_issue_states_until" ON "lumibase_audit_issue_states" USING btree ("until");