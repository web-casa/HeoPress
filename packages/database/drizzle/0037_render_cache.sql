CREATE TABLE "lumibase_render_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"site_version" bigint NOT NULL,
	"status" integer NOT NULL,
	"body" text NOT NULL,
	"etag" text NOT NULL,
	"location" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_render_cache" ADD CONSTRAINT "lumibase_render_cache_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "render_cache_site_version" ON "lumibase_render_cache" USING btree ("site_id","site_version");--> statement-breakpoint
CREATE INDEX "render_cache_expires" ON "lumibase_render_cache" USING btree ("expires_at");