-- Permission generation per site (HeoPress P03 task 5.5): any change to who
-- may read what on a site bumps lumibase_access_generations.generation.
-- Statement-level triggers with transition tables: one bump per site per
-- statement, however many rows it touched.
CREATE FUNCTION heopress_bump_access_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO lumibase_access_generations AS g (site_id, generation, updated_at)
  SELECT s.site_id, 1, now()
    FROM (
      SELECT to_jsonb(r) ->> 'site_id' AS site_id FROM changed_rows r
    ) s
    JOIN lumibase_sites ON lumibase_sites.id = s.site_id
   GROUP BY s.site_id
  ON CONFLICT (site_id) DO UPDATE SET generation = g.generation + 1, updated_at = now();
  RETURN NULL;
END;
$$;
--> statement-breakpoint
-- role–policy links carry no site: resolve it through the role.
CREATE FUNCTION heopress_bump_access_generation_by_role() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO lumibase_access_generations AS g (site_id, generation, updated_at)
  SELECT ro.site_id, 1, now()
    FROM (SELECT DISTINCT to_jsonb(r) ->> 'role_id' AS role_id FROM changed_rows r) s
    JOIN lumibase_roles ro ON ro.id = s.role_id
   GROUP BY ro.site_id
  ON CONFLICT (site_id) DO UPDATE SET generation = g.generation + 1, updated_at = now();
  RETURN NULL;
END;
$$;
--> statement-breakpoint
DO $$
DECLARE
  t text;
  fn text;
  op text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'lumibase_roles', 'lumibase_policies', 'lumibase_user_policies', 'lumibase_user_roles',
    'lumibase_user_sites', 'lumibase_permissions', 'lumibase_api_key_roles',
    'lumibase_api_key_policies', 'lumibase_role_policies'
  ] LOOP
    fn := CASE WHEN t = 'lumibase_role_policies' THEN 'heopress_bump_access_generation_by_role' ELSE 'heopress_bump_access_generation' END;
    -- An UPDATE bumps the sites of the old rows and of the new rows (a row
    -- moved to another site changes access on both).
    FOREACH op IN ARRAY ARRAY['INSERT:NEW', 'UPDATE:NEW', 'UPDATE:OLD', 'DELETE:OLD'] LOOP
      EXECUTE format(
        'CREATE TRIGGER %I AFTER %s ON %I REFERENCING %s TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION %I()',
        t || '_access_gen_' || lower(replace(op, ':', '_')), split_part(op, ':', 1), t, split_part(op, ':', 2), fn
      );
    END LOOP;
  END LOOP;
END;
$$;
