CREATE TABLE "lumibase_site_static_mounts" (
	"site_id" text PRIMARY KEY NOT NULL,
	"directory" text DEFAULT '' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_public_static_mounts" (
	"site_id" text PRIMARY KEY NOT NULL,
	"directory" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
ALTER TABLE "lumibase_site_static_mounts" ADD CONSTRAINT "lumibase_site_static_mounts_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lumibase_public_static_mounts" ADD CONSTRAINT "lumibase_public_static_mounts_site_id_lumibase_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."lumibase_sites"("id") ON DELETE cascade ON UPDATE no action;

-- v1.5 (spec rendering/static-directory-mount): the two tables are site-isolated like every other site table, and the
-- settings row is part of the public projection's gate — a mount saved (or cleared) refreshes the site's projection and
-- raises its render version in the same transaction, so the page cache and the sitemap memory never serve stale output.
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_site_static_mounts' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_site_static_mounts', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_site_static_mounts ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_site_static_mounts FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DO $$ DECLARE p name; BEGIN
  FOR p IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'lumibase_public_static_mounts' LOOP
    EXECUTE format('DROP POLICY %I ON public.lumibase_public_static_mounts', p);
  END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE public.lumibase_public_static_mounts ENABLE ROW LEVEL SECURITY, NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY site_isolation ON public.lumibase_public_static_mounts FOR ALL USING (site_id = app_site_id()) WITH CHECK (site_id = app_site_id());--> statement-breakpoint
DROP TRIGGER IF EXISTS projection_insert ON lumibase_site_static_mounts;--> statement-breakpoint
CREATE TRIGGER projection_insert AFTER INSERT ON lumibase_site_static_mounts REFERENCING NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION heopress_projection_mark('site_id', 'site_id', 'directory');--> statement-breakpoint
DROP TRIGGER IF EXISTS projection_update ON lumibase_site_static_mounts;--> statement-breakpoint
CREATE TRIGGER projection_update AFTER UPDATE ON lumibase_site_static_mounts REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows FOR EACH STATEMENT EXECUTE FUNCTION heopress_projection_mark('site_id', 'site_id', 'directory');--> statement-breakpoint
DROP TRIGGER IF EXISTS projection_delete ON lumibase_site_static_mounts;--> statement-breakpoint
CREATE TRIGGER projection_delete AFTER DELETE ON lumibase_site_static_mounts REFERENCING OLD TABLE AS old_rows FOR EACH STATEMENT EXECUTE FUNCTION heopress_projection_mark('site_id', 'site_id', 'directory');
