CREATE TABLE "lumibase_maintenance_acks" (
	"process_id" text PRIMARY KEY NOT NULL,
	"process_role" text NOT NULL,
	"epoch" bigint NOT NULL,
	"frozen" boolean NOT NULL,
	"inflight" integer NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lumibase_maintenance" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"epoch" bigint DEFAULT 0 NOT NULL,
	"reason" text,
	"upgrade_id" text,
	"from_version" text,
	"to_version" text,
	"step" text,
	"started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "maintenance_singleton" CHECK ("lumibase_maintenance"."id" = 1)
);
--> statement-breakpoint
INSERT INTO "lumibase_maintenance" ("id") VALUES (1) ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
-- The maintenance switch is the owner's (the upgrade command): every other role, the application role included
-- (granted writes by default privileges), may only read it. `ensureAppRole` keeps it that way.
DO $$ DECLARE r text; BEGIN
  FOR r IN SELECT DISTINCT a.grantee::regrole::text FROM pg_class c, aclexplode(c.relacl) a
            WHERE c.oid = 'public.lumibase_maintenance'::regclass AND a.grantee <> c.relowner AND a.grantee <> 0 LOOP
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.lumibase_maintenance FROM %s', r);
  END LOOP;
END $$;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.lumibase_maintenance FROM PUBLIC;
