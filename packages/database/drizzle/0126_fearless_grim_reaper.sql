ALTER TABLE "lumibase_items" ADD COLUMN "needs_update_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lumibase_items" ADD COLUMN "needs_update_reason" text;--> statement-breakpoint
ALTER TABLE "lumibase_items" ADD COLUMN "needs_update_due_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "items_needs_update_idx" ON "lumibase_items" USING btree ("site_id","collection_id","updated_at") WHERE "lumibase_items"."needs_update_since" is not null;