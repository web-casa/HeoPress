-- HeoPress P13 task 3.2: targeted page-cache invalidation. A rendered answer is kept under its address and the render
-- versions it was made under; an article's page depends on its own item's version and the site's structure version, not
-- on every other article. Existing rows were keyed by version: they are dropped (a cache; the renderers make them anew).
DELETE FROM "lumibase_render_cache";--> statement-breakpoint
ALTER TABLE "lumibase_public_items" ADD COLUMN "render_version" bigint DEFAULT nextval('heopress_render_version_seq') NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_render_cache" ADD COLUMN "structure_version" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_render_cache" ADD COLUMN "theme_version" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_render_cache" ADD COLUMN "item_id" text;--> statement-breakpoint
ALTER TABLE "lumibase_render_cache" ADD COLUMN "item_version" bigint;--> statement-breakpoint
ALTER TABLE "lumibase_site_render_versions" ADD COLUMN "structure_version" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE "lumibase_site_render_versions" SET "structure_version" = "version";
