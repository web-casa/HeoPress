CREATE TABLE "lumibase_item_idempotency_keys" (
	"site_id" text NOT NULL,
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"collection" text NOT NULL,
	"item_id" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_item_idempotency_keys_site_id_scope_key_pk" PRIMARY KEY("site_id","scope","key")
);
--> statement-breakpoint
ALTER TABLE "lumibase_item_idempotency_keys" ADD CONSTRAINT "lumibase_item_idempotency_keys_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "item_idempotency_keys_created_idx" ON "lumibase_item_idempotency_keys" USING btree ("created_at");