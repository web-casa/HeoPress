import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { collections, fields, items, relations, siteContentSettings, sitePresets, sites, type Database } from '@heopress/database';
import type { CacheProvider } from '@heopress/runtime';
import { runSiteTransaction, withSiteScope } from '../rls-transaction';
import { SchemaService } from '../schema-service';
import { PRESET_CHOICE_UPGRADES, SITE_NETWORK_COLLECTIONS, SITE_NETWORK_PRESET, presetMarker, type PresetCollection } from './preset';

/**
 * Installing and upgrading the site network preset (HeoPress P05 tasks 1.1,
 * 1.4; design A).
 *
 * `installSiteNetworkPreset` runs in the caller's transaction (a new site,
 * its preset and its content settings commit or roll back together), in the
 * target site's RLS scope, and is idempotent. It only ever ADDS: a missing
 * preset collection, field, relation or default permalink is created;
 * anything that exists — a preset field the site changed or renamed, a
 * field the site added itself (no `options.preset`) — is left exactly as it
 * is, and the report says why. A site field that merely has a preset
 * field's name is never taken over (no relation is added to it either).
 *
 * `upgradeSitePreset` is the one entry point for an existing site (CLI
 * `heopress preset upgrade`): its own site transaction, then — after commit
 * — the shared schema caches of the preset's collections are dropped, so a
 * running CMS sees the new fields at once.
 *
 * The report also lists the items whose first publish date is estimated or
 * unknown (spec "历史发布日期未知"; design R25, R28), for an administrator
 * to confirm or correct.
 */

/** Default permalink patterns (paths are unique per site and language, so collections differ). */
const DEFAULT_PERMALINKS: Record<string, string> = {
  articles: '/:year/:month/:slug',
  pages: '/:slug',
  categories: '/category/:slug',
  tags: '/tag/:slug',
  authors: '/author/:slug',
};

type SkipReason = 'exists' | 'site_field_with_same_name' | 'renamed_by_site' | 'field_not_from_preset' | 'choices_changed_by_site';

interface DatedItem {
  collection: string;
  id: string;
  title: string | null;
  slug: string | null;
  publishedAt: string | null;
}

export interface PresetReport {
  preset: string;
  version: number;
  added: Array<{ collection: string; field?: string; relation?: string; permalink?: string; choices?: string[] }>;
  skipped: Array<{ collection: string; field?: string; relation?: string; reason: SkipReason }>;
  /** Items of the preset's content collections whose first publish date needs a person (estimated, or history unknown). */
  publishDates: { estimated: DatedItem[]; unknown: DatedItem[] };
}

type Tx = Database;

export async function installSiteNetworkPreset(tx: Tx, siteId: string): Promise<PresetReport> {
  return withSiteScope(tx as never, siteId, async () => {
    const report: PresetReport = {
      preset: SITE_NETWORK_PRESET.name,
      version: SITE_NETWORK_PRESET.version,
      added: [],
      skipped: [],
      publishDates: { estimated: [], unknown: [] },
    };
    await ensureContentSettings(tx, siteId);
    // The settings row first (design §0 lock order): the permalinks below are written under it.
    const [settings] = await tx.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId)).for('update');
    const schema = new SchemaService({ db: tx, siteId, presetInstaller: true });

    for (const preset of SITE_NETWORK_COLLECTIONS) await ensureCollection(tx, schema, siteId, preset, report);
    for (const preset of SITE_NETWORK_COLLECTIONS) await ensureRelations(tx, schema, siteId, preset, report);

    // Default permalinks for the preset's collections the site has not configured: a real change bumps the version,
    // so a form read before the upgrade cannot silently undo it.
    const current = settings!.permalinks ?? {};
    const missing = Object.fromEntries(Object.entries(DEFAULT_PERMALINKS).filter(([collection]) => !(collection in current)));
    if (Object.keys(missing).length > 0) {
      await tx
        .update(siteContentSettings)
        .set({ permalinks: { ...current, ...missing }, version: sql`${siteContentSettings.version} + 1`, updatedAt: new Date() })
        .where(eq(siteContentSettings.siteId, siteId));
      for (const [collection, permalink] of Object.entries(missing)) report.added.push({ collection, permalink });
    }

    report.publishDates = await datesToConfirm(tx, siteId);
    // What was added and skipped (and why), kept with the version (P07 task 2.4): the site-wide upgrade's skips stay visible.
    // `cachesPending`: the shared schema caches still to drop after the commit (cleared once dropped; a later run retries);
    // `cachesGeneration` names this install, so a drop that finishes after a newer install cannot clear the newer one's.
    const kept = {
      version: report.version,
      added: report.added,
      skipped: report.skipped,
      at: new Date().toISOString(),
      cachesPending: true,
      cachesGeneration: randomUUID(),
    };
    await tx
      .insert(sitePresets)
      .values({ siteId, preset: SITE_NETWORK_PRESET.name, version: SITE_NETWORK_PRESET.version, report: kept })
      .onConflictDoUpdate({
        target: [sitePresets.siteId, sitePresets.preset],
        set: { version: sql`greatest(${sitePresets.version}, ${SITE_NETWORK_PRESET.version})`, upgradedAt: new Date(), report: kept },
      });
    return report;
  });
}

/** Upgrade an existing site: its own transaction, then drop the shared schema caches after commit. */
export async function upgradeSitePreset(db: Database, siteId: string, cache?: CacheProvider): Promise<PresetReport> {
  const report = await runSiteTransaction(db, siteId, (tx) => installSiteNetworkPreset(tx as unknown as Database, siteId));
  await dropPresetCaches(db, siteId, cache);
  return report;
}

/**
 * Drop the shared schema caches after a committed install, then note it done — for the install read before dropping only
 * (its `cachesGeneration`): a newer install committed meanwhile stays pending until its own drop. A failure leaves it
 * pending for the next run.
 */
export async function dropPresetCaches(db: Database, siteId: string, cache?: CacheProvider): Promise<void> {
  const thisPreset = and(eq(sitePresets.siteId, siteId), eq(sitePresets.preset, SITE_NETWORK_PRESET.name));
  const [row] = await runSiteTransaction(db, siteId, (tx) => tx.select({ report: sitePresets.report }).from(sitePresets).where(thisPreset));
  const generation = (row?.report as { cachesGeneration?: unknown } | null | undefined)?.cachesGeneration;
  await invalidatePresetCaches(db, siteId, cache);
  await runSiteTransaction(db, siteId, (tx) =>
    tx
      .update(sitePresets)
      // A record without a report gets a complete one (the API's shape: version, at, added, skipped).
      .set({
        report: sql`jsonb_set(coalesce(${sitePresets.report}, jsonb_build_object('version', ${sitePresets.version}, 'at', to_jsonb(now()), 'added', '[]'::jsonb, 'skipped', '[]'::jsonb)), '{cachesPending}', 'false'::jsonb)`,
      })
      .where(
        and(
          thisPreset,
          typeof generation === 'string'
            ? sql`${sitePresets.report} ->> 'cachesGeneration' = ${generation}`
            : sql`(${sitePresets.report} IS NULL OR NOT (${sitePresets.report} ? 'cachesGeneration'))`,
        ),
      ),
  );
}

/**
 * Upgrade every site whose installed preset is older than this one (HeoPress P07 task 2.4: the worker's job; preset
 * version 3 adds the questions-and-answers field). Each site in its own transaction, so a stopped run resumes where it
 * stopped (the sites still below the version); running it again changes nothing (the installer only adds). A site field
 * of the same name is never overwritten: the skip is in the site's kept report. Sites without the preset are left alone.
 */
export async function upgradeAllSitePresets(db: Database, cache?: CacheProvider): Promise<{ upgraded: string[]; failed: string[] }> {
  const out = { upgraded: [] as string[], failed: [] as string[] };
  // Site by site (the presets table is read in each site's scope, under row-level security).
  for (const { id: siteId } of await db.select({ id: sites.id }).from(sites).orderBy(sites.id)) {
    try {
      const [installed] = await runSiteTransaction(db, siteId, (tx) =>
        tx
          .select({ version: sitePresets.version, report: sitePresets.report })
          .from(sitePresets)
          .where(and(eq(sitePresets.siteId, siteId), eq(sitePresets.preset, SITE_NETWORK_PRESET.name))),
      );
      if (!installed) continue;
      if (installed.version >= SITE_NETWORK_PRESET.version) {
        // Up to date, but the caches of its last upgrade were not dropped (it failed after the commit): drop them now.
        // A report from before the flag existed (or none) counts as pending once (Codex review of batch 5b-2).
        if ((installed.report as { cachesPending?: unknown } | null)?.cachesPending !== false) {
          await dropPresetCaches(db, siteId, cache);
          out.upgraded.push(siteId);
        }
        continue;
      }
      await upgradeSitePreset(db, siteId, cache);
      out.upgraded.push(siteId);
    } catch (err) {
      // One site's failure never holds the others back; the next run tries it again.
      out.failed.push(siteId);
      console.error(`[preset-upgrade] site ${siteId} failed:`, err instanceof Error ? err.message : String(err));
    }
  }
  return out;
}

export interface SitePresetView {
  preset: string;
  version: number;
  installedAt: Date;
  upgradedAt: Date | null;
  /** What the last install or upgrade added and skipped (and why); null before P07 kept it. */
  report: { version: number; added: unknown[]; skipped: unknown[]; at: string; cachesPending?: boolean } | null;
}

/** The site's installed preset and its kept report (P07 task 2.4: the site-wide upgrade's skips stay visible); null without one. */
export async function sitePresetOf(db: Database, siteId: string): Promise<SitePresetView | null> {
  const [row] = await runSiteTransaction(db, siteId, (tx) =>
    tx.select().from(sitePresets).where(and(eq(sitePresets.siteId, siteId), eq(sitePresets.preset, SITE_NETWORK_PRESET.name))),
  );
  if (!row) return null;
  return { preset: row.preset, version: row.version, installedAt: row.installedAt, upgradedAt: row.upgradedAt, report: (row.report as SitePresetView['report']) ?? null };
}

/** The site's content settings row: created with the site, its default language as its only language. */
export async function ensureContentSettings(tx: Tx, siteId: string): Promise<void> {
  const [site] = await tx.select({ defaultLanguage: sites.defaultLanguage }).from(sites).where(eq(sites.id, siteId));
  if (!site) throw new Error(`Site ${siteId} does not exist.`);
  await tx
    .insert(siteContentSettings)
    .values({ siteId, availableLocales: [site.defaultLanguage] })
    .onConflictDoNothing({ target: siteContentSettings.siteId });
}

const presetKeyOf = (options: unknown): string | undefined => (options as { preset?: { key?: string } } | null)?.preset?.key;

async function ensureCollection(tx: Tx, schema: SchemaService, siteId: string, preset: PresetCollection, report: PresetReport): Promise<void> {
  const name = preset.collection.name;
  const [existing] = await tx
    .select({ id: collections.id })
    .from(collections)
    .where(and(eq(collections.siteId, siteId), eq(collections.name, name)));
  let collectionId: string;
  if (!existing) {
    const created = (await schema.createCollection({ ...preset.collection, meta: { ...(preset.collection.meta ?? {}), preset: presetMarker(preset.key) } })) as { id: string };
    collectionId = created.id;
    report.added.push({ collection: name });
  } else {
    collectionId = existing.id;
    report.skipped.push({ collection: name, reason: 'exists' });
  }

  const present = await tx
    .select({ name: fields.name, options: fields.options })
    .from(fields)
    .where(and(eq(fields.siteId, siteId), eq(fields.collectionId, collectionId)));
  const byName = new Map(present.map((f) => [f.name, f]));
  // The preset's own fields by their stable key: found under whatever name the site gave them.
  const byKey = new Map(present.flatMap((f) => (presetKeyOf(f.options) ? [[presetKeyOf(f.options)!, f] as const] : [])));

  let sortOrder = present.length;
  for (const field of preset.fields) {
    const { key, ...input } = field;
    const same = byName.get(field.name);
    const own = byKey.get(key);
    if (same && presetKeyOf(same.options) !== key) report.skipped.push({ collection: name, field: field.name, reason: 'site_field_with_same_name' });
    if (own) {
      if (own.name !== field.name) {
        // The site renamed the preset's field: it is still there, under its new name — and still upgraded.
        report.skipped.push({ collection: name, field: field.name, reason: 'renamed_by_site' });
        if (PRESET_CHOICE_UPGRADES[key]) await upgradeChoices(schema, name, own.name, key, own.options, report);
      } else {
        await upgradeChoices(schema, name, own.name, key, own.options, report);
      }
      continue;
    }
    if (same) continue;
    await schema.createField(name, { ...input, sortOrder: sortOrder++, options: { ...(input.options ?? {}), preset: presetMarker(key) } });
    report.added.push({ collection: name, field: field.name });
  }
}

/** Append the choices a later preset version added, to a field still exactly as an earlier version installed it. */
async function upgradeChoices(schema: SchemaService, collection: string, fieldName: string, key: string, options: unknown, report: PresetReport): Promise<void> {
  const upgrade = PRESET_CHOICE_UPGRADES[key];
  const current = (options as { choices?: unknown } | null)?.choices;
  const choices = Array.isArray(current) ? current.map(String) : null;
  if (!upgrade || !choices || upgrade.add.every((c) => choices.includes(c))) {
    report.skipped.push({ collection, field: fieldName, reason: 'exists' });
    return;
  }
  if (choices.length !== upgrade.from.length || choices.some((c, i) => c !== upgrade.from[i])) {
    report.skipped.push({ collection, field: fieldName, reason: 'choices_changed_by_site' });
    return;
  }
  const next = [...choices, ...upgrade.add.filter((c) => !choices.includes(c))];
  await schema.updateField(collection, fieldName, { options: { ...(options as Record<string, unknown>), choices: next } });
  report.added.push({ collection, field: fieldName, choices: upgrade.add.filter((c) => !choices.includes(c)) });
}

/** A preset relation is only ever added to the preset's own field (followed through a rename), never to a site field of the same name. */
async function ensureRelations(tx: Tx, schema: SchemaService, siteId: string, preset: PresetCollection, report: PresetReport): Promise<void> {
  for (const [fieldKey, targetKey] of Object.entries(preset.relations ?? {})) {
    const collection = preset.collection.name;
    const target = SITE_NETWORK_COLLECTIONS.find((c) => c.key === targetKey)!.collection.name;
    const rows = await tx
      .select({ name: fields.name, options: fields.options })
      .from(fields)
      .innerJoin(collections, eq(collections.id, fields.collectionId))
      .where(and(eq(fields.siteId, siteId), eq(collections.name, collection)));
    const own = rows.find((f) => presetKeyOf(f.options) === fieldKey);
    if (!own) {
      // Removed by the site, or a field of the same name the site made itself: leave it.
      if (rows.some((f) => f.name === fieldKey)) report.skipped.push({ collection, relation: fieldKey, reason: 'field_not_from_preset' });
      continue;
    }
    const [existing] = await tx
      .select({ id: relations.id })
      .from(relations)
      .where(and(eq(relations.siteId, siteId), eq(relations.manyCollection, collection), eq(relations.manyField, own.name)));
    if (existing) continue;
    await schema.createRelation({ manyCollection: collection, manyField: own.name, oneCollection: target, type: 'm2o', onDelete: 'set null' });
    report.added.push({ collection, relation: own.name });
  }
}

/** Items of the preset's content collections whose first publish date a person should confirm. */
async function datesToConfirm(tx: Tx, siteId: string): Promise<PresetReport['publishDates']> {
  const rows = await tx
    .select({
      collection: collections.name,
      id: items.id,
      data: items.data,
      publishedAt: items.publishedAt,
      source: items.publishedAtSource,
    })
    .from(items)
    .innerJoin(collections, eq(collections.id, items.collectionId))
    .where(
      and(
        eq(items.siteId, siteId),
        inArray(collections.name, ['articles', 'pages']),
        inArray(items.publishedAtSource, ['estimated', 'unknown']),
        sql`${items.deletedAt} IS NULL`,
      ),
    )
    .orderBy(collections.name, items.createdAt);
  const out: PresetReport['publishDates'] = { estimated: [], unknown: [] };
  for (const r of rows) {
    const data = (r.data ?? {}) as Record<string, unknown>;
    const entry: DatedItem = {
      collection: r.collection,
      id: r.id,
      title: typeof data.title === 'string' ? data.title : null,
      slug: typeof data.slug === 'string' ? data.slug : null,
      publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
    };
    (r.source === 'estimated' ? out.estimated : out.unknown).push(entry);
  }
  return out;
}

/** After the install's transaction committed: drop cached schemas (and "no such collection" tombstones) of the preset's collections. */
async function invalidatePresetCaches(db: Database, siteId: string, cache: CacheProvider | undefined): Promise<void> {
  if (!cache) return;
  const schema = new SchemaService({ db, siteId, cache });
  const { forgetNegative, negativeCollectionKey } = await import('../negative-cache');
  for (const preset of SITE_NETWORK_COLLECTIONS) {
    await schema.invalidate(preset.collection.name);
    await forgetNegative(cache, negativeCollectionKey(siteId, preset.collection.name));
  }
}
