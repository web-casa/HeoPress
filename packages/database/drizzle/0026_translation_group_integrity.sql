-- Translation group integrity (HeoPress P05, design R39, R44): the database keeps a group's sites
-- honest whatever writes it, so a site cannot hand a group to another site or slip a member into a
-- group that does not list it. Every check reads in the scope of the site concerned (`app.site_id`,
-- restored afterwards), so the row-level security policies see what that site sees.

-- The site that created a group never changes.
CREATE OR REPLACE FUNCTION heopress_translation_group_owner_fixed() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.site_id IS DISTINCT FROM OLD.site_id THEN
    RAISE EXCEPTION 'translation group % cannot change its creating site', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS translation_group_owner_fixed ON lumibase_translation_groups;
--> statement-breakpoint
CREATE TRIGGER translation_group_owner_fixed BEFORE UPDATE ON lumibase_translation_groups
  FOR EACH ROW EXECUTE FUNCTION heopress_translation_group_owner_fixed();
--> statement-breakpoint

-- Whether site `site` has a member in group `gid` (read in that site's scope).
CREATE OR REPLACE FUNCTION heopress_translation_group_has_member(gid text, site text) RETURNS boolean
  LANGUAGE plpgsql AS $$
DECLARE
  prev text := current_setting('app.site_id', true);
  found boolean;
BEGIN
  PERFORM set_config('app.site_id', site, true);
  SELECT EXISTS (SELECT 1 FROM lumibase_translation_group_members m WHERE m.group_id = gid AND m.site_id = site) INTO found;
  PERFORM set_config('app.site_id', coalesce(prev, ''), true);
  RETURN found;
END $$;
--> statement-breakpoint

-- Whether group `gid` lists site `site` among its sites (read in that site's scope).
CREATE OR REPLACE FUNCTION heopress_translation_group_lists(gid text, site text) RETURNS boolean
  LANGUAGE plpgsql AS $$
DECLARE
  prev text := current_setting('app.site_id', true);
  found boolean;
BEGIN
  PERFORM set_config('app.site_id', site, true);
  SELECT EXISTS (SELECT 1 FROM lumibase_translation_groups g WHERE g.id = gid AND site = ANY (g.site_ids)) INTO found;
  PERFORM set_config('app.site_id', coalesce(prev, ''), true);
  RETURN found;
END $$;
--> statement-breakpoint

-- Whether group `gid` is consistent as site `site` sees it: when the site sees the group, every listed
-- site has a member and the site, if it has a member, is listed; when it does not see it (not listed,
-- not the creator, or the group is gone), the site has no member left in it.
CREATE OR REPLACE FUNCTION heopress_translation_group_assert(gid text, site text) RETURNS void
  LANGUAGE plpgsql AS $$
DECLARE
  prev text := current_setting('app.site_id', true);
  listed text[];
  seen boolean;
  s text;
BEGIN
  PERFORM set_config('app.site_id', site, true);
  SELECT g.site_ids INTO listed FROM lumibase_translation_groups g WHERE g.id = gid;
  seen := FOUND; -- saved first: PERFORM below resets FOUND
  PERFORM set_config('app.site_id', coalesce(prev, ''), true);
  IF NOT seen THEN
    IF heopress_translation_group_has_member(gid, site) THEN
      RAISE EXCEPTION 'site % has members in translation group % that does not list it', site, gid USING ERRCODE = 'check_violation';
    END IF;
    RETURN;
  END IF;
  FOREACH s IN ARRAY listed LOOP
    IF NOT heopress_translation_group_has_member(gid, s) THEN
      RAISE EXCEPTION 'translation group % lists site % without a member there', gid, s USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  IF NOT (site = ANY (listed)) AND heopress_translation_group_has_member(gid, site) THEN
    RAISE EXCEPTION 'site % has members in translation group % that does not list it', site, gid USING ERRCODE = 'check_violation';
  END IF;
END $$;
--> statement-breakpoint

-- At commit, after any change of a group: consistent as its creating site sees it, and every site it
-- dropped has no member left.
CREATE OR REPLACE FUNCTION heopress_translation_group_sites_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  s text;
BEGIN
  PERFORM heopress_translation_group_assert(NEW.id, NEW.site_id);
  IF TG_OP = 'UPDATE' THEN
    FOREACH s IN ARRAY OLD.site_ids LOOP
      IF NOT (s = ANY (NEW.site_ids)) THEN
        PERFORM heopress_translation_group_assert(NEW.id, s);
      END IF;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS translation_group_sites_check ON lumibase_translation_groups;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER translation_group_sites_check AFTER INSERT OR UPDATE ON lumibase_translation_groups
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION heopress_translation_group_sites_check();
--> statement-breakpoint

-- At commit, after any change of a member (cascades included): the group it left and the group it is
-- in are both consistent as the member's site sees them.
CREATE OR REPLACE FUNCTION heopress_translation_member_sites_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM heopress_translation_group_assert(OLD.group_id, OLD.site_id);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    PERFORM heopress_translation_group_assert(NEW.group_id, NEW.site_id);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS translation_member_sites_check ON lumibase_translation_group_members;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER translation_member_sites_check AFTER INSERT OR UPDATE OR DELETE ON lumibase_translation_group_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION heopress_translation_member_sites_check();
--> statement-breakpoint

-- A member joins only a group that already lists its site (the group is changed first, under its lock).
CREATE OR REPLACE FUNCTION heopress_translation_member_group_check() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT heopress_translation_group_lists(NEW.group_id, NEW.site_id) THEN
    RAISE EXCEPTION 'translation group % does not list site %', NEW.group_id, NEW.site_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS translation_member_group_check ON lumibase_translation_group_members;
--> statement-breakpoint
CREATE TRIGGER translation_member_group_check BEFORE INSERT OR UPDATE OF group_id, site_id ON lumibase_translation_group_members
  FOR EACH ROW EXECUTE FUNCTION heopress_translation_member_group_check();
