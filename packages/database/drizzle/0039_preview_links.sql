CREATE TABLE "lumibase_preview_links" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"kind" text NOT NULL,
	"collection" text,
	"target_id" text NOT NULL,
	"created_by" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_preview_links" ADD CONSTRAINT "lumibase_preview_links_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_preview_links" ADD CONSTRAINT "lumibase_preview_links_created_by_lumibase_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."lumibase_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "preview_links_token_hash_unique" ON "lumibase_preview_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "preview_links_site_expiry_idx" ON "lumibase_preview_links" USING btree ("site_id","expires_at");