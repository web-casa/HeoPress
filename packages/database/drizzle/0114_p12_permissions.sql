ALTER TABLE "lumibase_extensions" ADD COLUMN "requested_capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN "permissions_status" text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN "permissions_approved_at" timestamp;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN "permissions_approved_by" text;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN "pending_upgrade" jsonb;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD COLUMN "provenance" jsonb;--> statement-breakpoint
ALTER TABLE "lumibase_publisher_keys" ADD COLUMN "repository" text;--> statement-breakpoint
ALTER TABLE "lumibase_extensions" ADD CONSTRAINT "lumibase_extensions_permissions_approved_by_lumibase_users_id_fk" FOREIGN KEY ("permissions_approved_by") REFERENCES "public"."lumibase_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- HeoPress P12 task 1.3: move installed plugins to the fine-grained capability model. Mirrors
-- `migrateLegacyCapabilities` (@heopress/contracts/extensions): items:read/items:write become items:<access>:*,
-- db:*, service-account, env:read, queue:enqueue, a host-less http:fetch and anything outside the grammar are
-- dropped, and the extension point the old slot type implied is added. Nothing is widened. Installed rows must be
-- confirmed again by an admin (`reconfirm`); they keep running with the narrowed set meanwhile.
WITH mapped AS (
  SELECT x.id,
         COALESCE(jsonb_agg(DISTINCT m.cap ORDER BY m.cap) FILTER (WHERE m.cap IS NOT NULL), '[]'::jsonb) AS caps
  FROM "lumibase_extensions" x
  LEFT JOIN LATERAL (
    SELECT CASE
             WHEN c IN ('items:read', 'items:write') THEN c || ':*'
             WHEN c ~ '^http:fetch:(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' THEN c
             WHEN c ~ '^(items:(read|write|publish)|cdc:subscribe):(\*|[a-z0-9][a-z0-9_.-]{0,127})$' THEN c
             WHEN c ~ '^secrets:[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' THEN c
             WHEN c IN ('media:read', 'media:write', 'kv:read', 'kv:write', 'seo:structured-data') THEN c
             WHEN c ~ '^ext:(collections|routes|source-adapters|gate-checks|jobs|endpoints|events|admin-panels|build-steps)$' THEN c
             ELSE NULL
           END AS cap
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(x.capabilities) = 'array' THEN x.capabilities ELSE '[]'::jsonb END) AS c
    UNION ALL
    SELECT CASE x.type
             WHEN 'hook' THEN 'ext:events'
             WHEN 'endpoint' THEN 'ext:endpoints'
             WHEN 'panel' THEN 'ext:admin-panels'
             WHEN 'module' THEN 'ext:admin-panels'
           END
  ) m ON true
  GROUP BY x.id
)
UPDATE "lumibase_extensions" x
SET "capabilities" = mapped.caps,
    "requested_capabilities" = mapped.caps,
    "permissions_status" = CASE WHEN x."site_id" IS NULL THEN 'approved' ELSE 'reconfirm' END
FROM mapped
WHERE mapped.id = x.id;
