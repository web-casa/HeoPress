ALTER TABLE "lumibase_public_items" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "lumibase_public_items" ADD COLUMN "content_modified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lumibase_public_path_memory" ADD COLUMN "content_hash" text;--> statement-breakpoint
ALTER TABLE "lumibase_public_path_memory" ADD COLUMN "content_modified_at" timestamp with time zone;