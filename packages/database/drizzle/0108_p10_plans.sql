CREATE TABLE "lumibase_batch_plan_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"plan_id" text NOT NULL,
	"plan_hash" text NOT NULL,
	"approver_id" text NOT NULL,
	"verification" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_plan_approvals_verification" CHECK ("lumibase_batch_plan_approvals"."verification" IN ('totp', 'none'))
);
--> statement-breakpoint
CREATE TABLE "lumibase_batch_plan_items" (
	"plan_id" text NOT NULL,
	"site_id" text NOT NULL,
	"position" integer NOT NULL,
	"canary" boolean DEFAULT false NOT NULL,
	"arguments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "lumibase_batch_plan_items_plan_id_site_id_pk" PRIMARY KEY("plan_id","site_id"),
	CONSTRAINT "batch_plan_items_status" CHECK ("lumibase_batch_plan_items"."status" IN ('pending', 'running', 'succeeded', 'conflict', 'forbidden', 'failed', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "lumibase_batch_plans" (
	"id" text PRIMARY KEY NOT NULL,
	"operation" text NOT NULL,
	"arguments" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_summary" text NOT NULL,
	"site_count" integer NOT NULL,
	"risk_tier" text NOT NULL,
	"high_risk" boolean DEFAULT false NOT NULL,
	"requires_preview" boolean DEFAULT false NOT NULL,
	"requires_canary" boolean DEFAULT false NOT NULL,
	"approval_mode" text NOT NULL,
	"required_approvals" integer DEFAULT 1 NOT NULL,
	"plan_hash" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending_approval' NOT NULL,
	"drafted_by" text NOT NULL,
	"drafted_via" text NOT NULL,
	"grant_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"cooling_off_until" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"canary_confirmed_by" text,
	"canary_confirmed_at" timestamp with time zone,
	"execution_id" text,
	"execution_started_at" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "batch_plans_status" CHECK ("lumibase_batch_plans"."status" IN ('pending_approval', 'cooling_off', 'approved', 'running', 'canary_review', 'completed', 'cancelled', 'rejected', 'expired')),
	CONSTRAINT "batch_plans_tier" CHECK ("lumibase_batch_plans"."risk_tier" IN ('low', 'preview', 'canary', 'highest')),
	CONSTRAINT "batch_plans_mode" CHECK ("lumibase_batch_plans"."approval_mode" IN ('solo', 'team')),
	CONSTRAINT "batch_plans_scope_kind" CHECK ("lumibase_batch_plans"."scope_kind" IN ('siteIds', 'instance')),
	CONSTRAINT "batch_plans_via" CHECK ("lumibase_batch_plans"."drafted_via" IN ('oauth', 'pat'))
);
--> statement-breakpoint
ALTER TABLE "lumibase_batch_plan_approvals" ADD CONSTRAINT "lumibase_batch_plan_approvals_plan_id_lumibase_batch_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."lumibase_batch_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_batch_plan_approvals" ADD CONSTRAINT "lumibase_batch_plan_approvals_approver_id_lumibase_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_batch_plan_items" ADD CONSTRAINT "lumibase_batch_plan_items_plan_id_lumibase_batch_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."lumibase_batch_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_batch_plans" ADD CONSTRAINT "lumibase_batch_plans_drafted_by_lumibase_users_id_fk" FOREIGN KEY ("drafted_by") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "batch_plan_approvals_once" ON "lumibase_batch_plan_approvals" USING btree ("plan_id","plan_hash","approver_id");--> statement-breakpoint
CREATE INDEX "batch_plans_drafted_by_idx" ON "lumibase_batch_plans" USING btree ("drafted_by","created_at");--> statement-breakpoint
CREATE INDEX "batch_plans_status_idx" ON "lumibase_batch_plans" USING btree ("status");