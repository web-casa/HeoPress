CREATE TABLE "lumibase_media_objects" (
	"site_id" text NOT NULL,
	"key" text NOT NULL,
	"storage_profile_id" text,
	"object_key" text NOT NULL,
	"content_type" text,
	"size" bigint,
	"previous_storage_profile_id" text,
	"previous_on_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_media_objects_site_id_key_pk" PRIMARY KEY("site_id","key")
);
--> statement-breakpoint
CREATE TABLE "lumibase_site_storage" (
	"site_id" text PRIMARY KEY NOT NULL,
	"storage_profile_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_storage_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"site_id" text NOT NULL,
	"name" text NOT NULL,
	"driver" text NOT NULL,
	"bucket" text,
	"endpoint" text,
	"region" text,
	"force_path_style" boolean,
	"access_key_id" text,
	"secret_ciphertext" text,
	"public_base_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_profiles_site_id_unique" UNIQUE("site_id","id")
);
--> statement-breakpoint
ALTER TABLE "lumibase_media_objects" ADD CONSTRAINT "lumibase_media_objects_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_media_objects" ADD CONSTRAINT "media_objects_profile_fk" FOREIGN KEY ("site_id","storage_profile_id") REFERENCES "public"."lumibase_storage_profiles"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_media_objects" ADD CONSTRAINT "media_objects_previous_profile_fk" FOREIGN KEY ("site_id","previous_storage_profile_id") REFERENCES "public"."lumibase_storage_profiles"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_site_storage" ADD CONSTRAINT "lumibase_site_storage_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_site_storage" ADD CONSTRAINT "site_storage_profile_fk" FOREIGN KEY ("site_id","storage_profile_id") REFERENCES "public"."lumibase_storage_profiles"("site_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_storage_profiles" ADD CONSTRAINT "lumibase_storage_profiles_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "media_objects_profile_idx" ON "lumibase_media_objects" USING btree ("storage_profile_id") WHERE "lumibase_media_objects"."storage_profile_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_profiles_site_name_unique" ON "lumibase_storage_profiles" USING btree ("site_id","name");