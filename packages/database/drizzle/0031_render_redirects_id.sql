ALTER TABLE "lumibase_public_items" ADD COLUMN "rich_fields" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
-- The rendering service's resolver needs each redirect's id (HeoPress P06 task 1.3). Appended as the
-- last column, so the view is replaced in place and keeps its grants (the rendering role's included).
CREATE OR REPLACE VIEW lumibase_render_redirects WITH (security_barrier) AS
  SELECT site_id, scope, locale, from_path, match, to_path, to_locale, status, id FROM lumibase_redirects
  WHERE site_id = NULLIF(current_setting('app.site_id', true), '');
--> statement-breakpoint
-- Rows written before rich_fields existed list none (every value escaped on output): rebuild every built site.
INSERT INTO lumibase_projection_rebuilds (site_id, reason)
  SELECT site_id, 'migration 0031: rich_fields' FROM lumibase_public_sites;
