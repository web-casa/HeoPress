-- HeoPress P06 batch 5 review: render versions never repeat. They key the page cache; a site deleted and
-- created again under the same id would otherwise start over at 1 and meet cache entries of its former
-- self (a renderer process's memory outlives the rows). Every version comes from one sequence: unique
-- across sites and time. Existing versions move above every value used so far.
CREATE SEQUENCE IF NOT EXISTS heopress_render_version_seq AS bigint;
--> statement-breakpoint
SELECT setval('heopress_render_version_seq', greatest((SELECT coalesce(max(version), 0) FROM lumibase_site_render_versions), 1));
--> statement-breakpoint
UPDATE lumibase_site_render_versions SET version = nextval('heopress_render_version_seq');
