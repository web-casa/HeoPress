CREATE TABLE "lumibase_cdc_prune_marks" (
	"site_id" text PRIMARY KEY NOT NULL,
	"txid" "xid8" NOT NULL,
	"seq" bigint NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_cdc_prune_marks" ADD CONSTRAINT "lumibase_cdc_prune_marks_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;