ALTER TABLE "lumibase_ingest_sources" ADD COLUMN "adapter" text;--> statement-breakpoint
ALTER TABLE "lumibase_astro_builds" ADD COLUMN "steps" jsonb DEFAULT '[]'::jsonb NOT NULL;