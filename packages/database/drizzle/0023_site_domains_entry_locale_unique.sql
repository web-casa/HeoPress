-- Before P05 a site could name the same language on several domains (in any letter case: `zh-CN`, `zh-cn`).
-- One entry per language stays — an active domain before a pending one, then the oldest —; the others lose
-- their language (they become plain aliases) and say why in status_reason, for the operator to review.
UPDATE "lumibase_site_domains" AS d
SET "entry_locale" = NULL,
    "status_reason" = concat_ws(' ', d."status_reason", '[P05] Language entry "' || d."entry_locale" || '" cleared: another domain of this site is the entry for that language.'),
    "updated_at" = now()
WHERE d."entry_locale" IS NOT NULL AND d."status" <> 'disabled'
  AND EXISTS (
    SELECT 1 FROM "lumibase_site_domains" AS o
    WHERE o."site_id" = d."site_id" AND lower(o."entry_locale") = lower(d."entry_locale") AND o."status" <> 'disabled' AND o."id" <> d."id"
      AND ((o."status" = 'active') > (d."status" = 'active')
        OR ((o."status" = 'active') = (d."status" = 'active') AND (o."created_at", o."id") < (d."created_at", d."id")))
  );--> statement-breakpoint
CREATE UNIQUE INDEX "site_domains_site_entry_locale_unique" ON "lumibase_site_domains" USING btree ("site_id",lower("entry_locale")) WHERE "lumibase_site_domains"."entry_locale" IS NOT NULL AND "lumibase_site_domains"."status" <> 'disabled';
