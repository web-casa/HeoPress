CREATE TABLE "lumibase_git_snapshot_files" (
	"site_id" text NOT NULL,
	"path" text NOT NULL,
	"item_id" text,
	"content_hash" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_git_snapshot_files_site_id_path_pk" PRIMARY KEY("site_id","path")
);
--> statement-breakpoint
CREATE TABLE "lumibase_git_snapshot_queue" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"event_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"leased_until" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_git_snapshot_repos" (
	"site_id" text PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"remote_url" text NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"username" text,
	"credential_encrypted" text,
	"credential_hint" text,
	"author_name" text DEFAULT 'HeoPress' NOT NULL,
	"author_email" text DEFAULT 'snapshots@heopress.invalid' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"leased_until" timestamp with time zone,
	"lease_token" text,
	"last_commit_sha" text,
	"last_pushed_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_error" text,
	"last_reconciled_at" timestamp with time zone,
	"last_report" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_git_snapshot_files" ADD CONSTRAINT "lumibase_git_snapshot_files_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_git_snapshot_queue" ADD CONSTRAINT "lumibase_git_snapshot_queue_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_git_snapshot_repos" ADD CONSTRAINT "lumibase_git_snapshot_repos_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "git_snapshot_queue_event" ON "lumibase_git_snapshot_queue" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "git_snapshot_queue_due" ON "lumibase_git_snapshot_queue" USING btree ("due_at");