ALTER TABLE "lumibase_items" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_items" ADD COLUMN "hold" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_revisions" ADD COLUMN "item_version" integer;