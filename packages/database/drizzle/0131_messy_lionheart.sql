CREATE TABLE "lumibase_plugin_secrets" (
	"site_id" text NOT NULL,
	"extension_name" text NOT NULL,
	"name" text NOT NULL,
	"secret_ciphertext" text NOT NULL,
	"key_id" text NOT NULL,
	"set_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lumibase_plugin_secrets_site_id_extension_name_name_pk" PRIMARY KEY("site_id","extension_name","name")
);
--> statement-breakpoint
ALTER TABLE "lumibase_plugin_secrets" ADD CONSTRAINT "lumibase_plugin_secrets_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_plugin_secrets" ADD CONSTRAINT "lumibase_plugin_secrets_set_by_user_id_lumibase_users_id_fk" FOREIGN KEY ("set_by_user_id") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;