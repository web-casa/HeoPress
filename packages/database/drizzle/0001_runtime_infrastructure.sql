CREATE TABLE "lumibase_cache_entries" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"tag_generations" bigint[] DEFAULT '{}'::bigint[] NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "lumibase_cache_tags" (
	"tag" text PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_cache_unique_members" (
	"key" text NOT NULL,
	"member" text NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "lumibase_cache_unique_members_key_member_pk" PRIMARY KEY("key","member")
);
--> statement-breakpoint
CREATE TABLE "lumibase_rate_limit_windows" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_seconds" integer NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cache_entries_tags_idx" ON "lumibase_cache_entries" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "cache_entries_expires_idx" ON "lumibase_cache_entries" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "rate_limit_windows_start_idx" ON "lumibase_rate_limit_windows" USING btree ("window_start");