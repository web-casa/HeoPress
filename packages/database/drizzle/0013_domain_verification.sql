DROP INDEX "site_domains_hostname_unique";--> statement-breakpoint
ALTER TABLE "lumibase_site_domains" ALTER COLUMN "status" SET DEFAULT 'pending';--> statement-breakpoint
ALTER TABLE "lumibase_site_domains" ADD COLUMN "verification_method" text DEFAULT 'dns_txt' NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_site_domains" ADD COLUMN "verification_token" text;--> statement-breakpoint
ALTER TABLE "lumibase_site_domains" ADD COLUMN "verification_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lumibase_site_domains" ADD COLUMN "entry_locale" text;--> statement-breakpoint
CREATE UNIQUE INDEX "site_domains_active_hostname_unique" ON "lumibase_site_domains" USING btree ("hostname") WHERE "lumibase_site_domains"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "site_domains_site_hostname_unique" ON "lumibase_site_domains" USING btree ("site_id","hostname");--> statement-breakpoint
-- HeoPress P04: the Cloudflare-era pending states become "pending".
UPDATE "lumibase_site_domains" SET "status" = 'pending' WHERE "status" IN ('pending_dns', 'verifying');
