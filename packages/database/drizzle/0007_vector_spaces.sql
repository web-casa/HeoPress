CREATE TABLE "lumibase_access_generations" (
	"site_id" text PRIMARY KEY NOT NULL,
	"generation" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_vector_site_models" (
	"site_id" text PRIMARY KEY NOT NULL,
	"active_space_id" text,
	"previous_space_id" text,
	"building_space_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_vector_spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"model" text NOT NULL,
	"dimension" integer NOT NULL,
	"column_type" text NOT NULL,
	"table_name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vector_spaces_dimension_range" CHECK ("lumibase_vector_spaces"."dimension" BETWEEN 1 AND 4000)
);
--> statement-breakpoint
ALTER TABLE "lumibase_access_generations" ADD CONSTRAINT "lumibase_access_generations_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_vector_site_models" ADD CONSTRAINT "lumibase_vector_site_models_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_vector_site_models" ADD CONSTRAINT "lumibase_vector_site_models_active_space_id_lumibase_vector_spaces_id_fk" FOREIGN KEY ("active_space_id") REFERENCES "public"."lumibase_vector_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_vector_site_models" ADD CONSTRAINT "lumibase_vector_site_models_previous_space_id_lumibase_vector_spaces_id_fk" FOREIGN KEY ("previous_space_id") REFERENCES "public"."lumibase_vector_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_vector_site_models" ADD CONSTRAINT "lumibase_vector_site_models_building_space_id_lumibase_vector_spaces_id_fk" FOREIGN KEY ("building_space_id") REFERENCES "public"."lumibase_vector_spaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "vector_spaces_model_dimension_idx" ON "lumibase_vector_spaces" USING btree ("model","dimension");--> statement-breakpoint
CREATE UNIQUE INDEX "vector_spaces_table_name_idx" ON "lumibase_vector_spaces" USING btree ("table_name");