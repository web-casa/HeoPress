CREATE TABLE "lumibase_static_deploys" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"target_id" text,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"generation" integer NOT NULL,
	"revision" bigint,
	"status" text DEFAULT 'requested' NOT NULL,
	"marker" text NOT NULL,
	"provider_deployment_id" text,
	"url" text,
	"error" text,
	"log" text,
	"warnings" jsonb,
	"reachability" jsonb,
	"rollback_of" text,
	"requested_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "lumibase_astro_sites" ADD COLUMN "deploy_target_id" text;--> statement-breakpoint
ALTER TABLE "lumibase_astro_sites" ADD COLUMN "deployed_generation" integer;--> statement-breakpoint
ALTER TABLE "lumibase_astro_sites" ADD COLUMN "deployed_revision" bigint;--> statement-breakpoint
ALTER TABLE "lumibase_static_deploys" ADD CONSTRAINT "lumibase_static_deploys_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_static_deploys" ADD CONSTRAINT "lumibase_static_deploys_target_id_lumibase_deployment_targets_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."lumibase_deployment_targets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "static_deploys_site_created_idx" ON "lumibase_static_deploys" USING btree ("site_id","created_at");--> statement-breakpoint
CREATE INDEX "static_deploys_status_idx" ON "lumibase_static_deploys" USING btree ("status");--> statement-breakpoint
ALTER TABLE "lumibase_astro_sites" ADD CONSTRAINT "lumibase_astro_sites_deploy_target_id_lumibase_deployment_targets_id_fk" FOREIGN KEY ("deploy_target_id") REFERENCES "public"."lumibase_deployment_targets"("id") ON DELETE set null ON UPDATE no action;