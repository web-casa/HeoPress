CREATE TABLE "lumibase_audit_issues" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"rule" text NOT NULL,
	"severity" text NOT NULL,
	"fingerprint" text NOT NULL,
	"item_ids" text[] DEFAULT '{}' NOT NULL,
	"admin_only" boolean DEFAULT false NOT NULL,
	"evidence" jsonb NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_issues_severity" CHECK ("lumibase_audit_issues"."severity" IN ('error', 'warning', 'notice'))
);
--> statement-breakpoint
CREATE TABLE "lumibase_audit_sites" (
	"site_id" text PRIMARY KEY NOT NULL,
	"requested_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"status" text,
	"issues" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"leased_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "lumibase_audit_issues" ADD CONSTRAINT "lumibase_audit_issues_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_audit_sites" ADD CONSTRAINT "lumibase_audit_sites_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_issues_site_fingerprint" ON "lumibase_audit_issues" USING btree ("site_id","fingerprint");--> statement-breakpoint
CREATE INDEX "audit_issues_site_rule" ON "lumibase_audit_issues" USING btree ("site_id","rule");