import { and, eq } from 'drizzle-orm';
import {
  autoPublishSettings,
  collections,
  fields,
  importBatchItems,
  importExternalIds,
  items,
  relations,
  siteContentSettings,
  sites,
  type Database,
} from '@heopress/database';
import type { KeyProvider, StorageProvider } from '@heopress/runtime';
import { StorageProfileCreateSchema } from '@heopress/contracts/schemas';
import { itemServiceForSystem } from '../item-service-factory';
import { IngestSourceService } from '../ingest/source-service';
import { runSiteTransaction } from '../rls-transaction';
import { SchemaService, type CollectionInput, type FieldInput } from '../schema-service';
import { canCreateSite, provisionSite } from '../sites/site-provisioning';
import { StorageProfileService } from '../storage/storage-profile-service';
import { SiteImportService, storageMediaStore, type ImportReport } from '../site-import/import-service';
import { ThemeService } from '../themes/theme-service';
import { loadSiteBundle, themeAssetPath, themeTemplatePath, withoutBlockIds, type SiteBundle } from './site-bundle';

/**
 * "Import as new site" (HeoPress P13 tasks 1.2, 1.6; spec ops/backup-restore "单站点导出与导入", "单站导出安全范围").
 *
 * A single-site export becomes a new site: a new site ID, no domain. In order —
 *
 *   1. the bundle is read and checked whole (P12 checks, and the new-site records) before anything is written;
 *   2. the site is created (instance administrator only, as any new site), its settings and schema set from the bundle;
 *   3. the content goes in through the P12 importer — a dry run, then the import of exactly that report — so every
 *      item is a **draft** in an import batch, rich text sanitised (its block IDs assigned anew), media stored on the
 *      new site; then each relation is remapped from the exported item IDs to the new ones, and the batch pinned on
 *      the versions that leaves;
 *   4. the theme version is created and, when it was the active one and passes the checks, activated;
 *   5. sources are created and **paused** (terms at the defaults), auto-publish thresholds set without any trust tier
 *      (auto-publishing stays off), no domain, host, credential or storage secret is created.
 *
 * Going live is a person's step: activating the batch (publishes what the old site had published), resuming sources,
 * binding a domain, granting trust tiers.
 */

export class SiteImportNewError extends Error {
  constructor(
    readonly code: 'FORBIDDEN' | 'MEDIA_STORAGE_REQUIRED',
    message: string,
    readonly status: 403 | 422,
  ) {
    super(message);
    this.name = 'SiteImportNewError';
  }
}

export interface NewSiteImportDeps {
  db: Database;
  keys: KeyProvider;
  defaultStorage: StorageProvider;
  storageDir?: string;
}

export interface NewSiteImportInput {
  dir: string;
  siteId: string;
  name: string;
  actor: { userId: string; email?: string | null };
  /**
   * Imported media need storage with a public base URL. When given, a local storage profile with this base URL is
   * created on the new site and bound (no credential is involved).
   */
  mediaPublicBaseUrl?: string;
}

export interface NewSiteImportReport {
  siteId: string;
  batchId: string;
  /** Items the batch publishes when a person activates it. */
  toActivate: number;
  import: ImportReport;
  schema: { collectionsCreated: string[]; fieldsCreated: string[]; relationsCreated: number };
  relations: { remapped: number; failed: Array<{ externalId: string; field: string; reason: string }> };
  theme: { name: string; versionId: string; activated: boolean; note?: string } | null;
  sources: { created: string[]; skipped: Array<{ name: string; reason: string }> };
  autoPublish: 'thresholds set; no trust tier granted (off)' | 'not in the bundle';
  settings: string[];
  disabled: string[];
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

async function applySchema(db: Database, siteId: string, bundle: SiteBundle, report: NewSiteImportReport['schema']): Promise<void> {
  await runSiteTransaction(db, siteId, async (tx) => {
    const schema = new SchemaService({ db: tx as unknown as Database, siteId });
    const have = new Map((await tx.select({ id: collections.id, name: collections.name }).from(collections).where(eq(collections.siteId, siteId))).map((c) => [c.name, c.id]));
    for (const c of bundle.schemas) {
      if (!have.has(c.collection)) {
        await schema.createCollection({ ...(c.meta as Partial<CollectionInput>), name: c.collection });
        report.collectionsCreated.push(c.collection);
        const [row] = await tx.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, c.collection)));
        have.set(c.collection, row!.id);
      }
      const collId = have.get(c.collection)!;
      const existing = new Set((await tx.select({ name: fields.name }).from(fields).where(and(eq(fields.siteId, siteId), eq(fields.collectionId, collId)))).map((f) => f.name));
      for (const f of c.fields) {
        if (existing.has(f.name)) continue;
        await schema.createField(c.collection, { ...(f.definition as Partial<FieldInput>), name: f.name, type: f.type, interface: f.interface });
        report.fieldsCreated.push(`${c.collection}.${f.name}`);
      }
    }
    const rels = await tx.select({ manyCollection: relations.manyCollection, manyField: relations.manyField }).from(relations).where(eq(relations.siteId, siteId));
    const known = new Set(rels.map((r) => `${r.manyCollection}.${r.manyField}`));
    for (const c of bundle.schemas) {
      for (const r of c.relations ?? []) {
        if (known.has(`${c.collection}.${r.field}`) || !have.has(r.collection)) continue;
        await schema.createRelation({ manyCollection: c.collection, manyField: r.field, oneCollection: r.collection });
        report.relationsCreated++;
      }
    }
  });
}

async function applySettings(db: Database, siteId: string, bundle: SiteBundle, notes: string[]): Promise<void> {
  const s = bundle.base.site?.settings;
  const content = (bundle.siteConfig?.content ?? {}) as Record<string, unknown>;
  const presentation = (bundle.siteConfig?.site ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
  await runSiteTransaction(db, siteId, async (tx) => {
    const [current] = await tx.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId)).for('update');
    const set: Partial<typeof siteContentSettings.$inferInsert> = {};
    if (s) {
      set.availableLocales = [...new Set([s.defaultLocale, ...s.locales])];
      if (s.timezone) set.timezone = s.timezone;
      if (s.trailingSlash) set.trailingSlash = s.trailingSlash;
      if (s.permalinks) set.permalinks = { ...(current?.permalinks ?? {}), ...s.permalinks };
      if (s.localePrefixes) set.localePrefixes = s.localePrefixes;
    }
    for (const k of ['siteType', 'localeStrategy', 'localePrefixMode'] as const) if (str(content[k])) set[k] = str(content[k]);
    for (const k of ['sponsorDisclosure', 'sponsorRel'] as const) if (bool(content[k]) !== undefined) set[k] = bool(content[k]);
    if (Object.keys(set).length) {
      await tx
        .update(siteContentSettings)
        .set({ ...set, version: (current?.version ?? 1) + 1, updatedAt: new Date() })
        .where(eq(siteContentSettings.siteId, siteId));
      notes.push(`Content settings set from the bundle: ${Object.keys(set).join(', ')}.`);
    }
    const site: Partial<typeof sites.$inferInsert> = {};
    for (const k of ['displayTitle', 'descriptor', 'defaultAppearance', 'customCss'] as const) if (str(presentation[k]) !== undefined) site[k] = str(presentation[k]);
    for (const k of ['branding', 'themeOverrides'] as const) if (obj(presentation[k])) site[k] = obj(presentation[k]);
    if (Object.keys(site).length) await tx.update(sites).set(site).where(eq(sites.id, siteId));
  });
}

/** Set each relation field to the new site's item IDs; re-pin the batch and the external IDs on the versions it leaves. */
async function remapRelations(db: Database, siteId: string, namespace: string, batchId: string, bundle: SiteBundle, actor: { userId: string }, out: NewSiteImportReport['relations']): Promise<void> {
  if (bundle.relations.length === 0) return;
  const afterCommit: Array<() => Promise<void>> = [];
  await runSiteTransaction(
    db,
    siteId,
    async (tx) => {
      const ext = await tx.select().from(importExternalIds).where(and(eq(importExternalIds.siteId, siteId), eq(importExternalIds.namespace, namespace), eq(importExternalIds.kind, 'item')));
      const newId = new Map(ext.map((r) => [r.externalId, r.targetId]));
      const collName = new Map((await tx.select({ id: collections.id, name: collections.name }).from(collections).where(eq(collections.siteId, siteId))).map((c) => [c.id, c.name]));
      const byItem = new Map<string, typeof bundle.relations>();
      for (const r of bundle.relations) byItem.set(r.externalId, [...(byItem.get(r.externalId) ?? []), r]);
      for (const [externalId, rels] of byItem) {
        const itemId = newId.get(externalId);
        if (!itemId) {
          for (const r of rels) out.failed.push({ externalId, field: r.field, reason: 'The item was not imported.' });
          continue;
        }
        const data: Record<string, unknown> = {};
        for (const r of rels) {
          const targets = r.targets.map((t) => newId.get(t)).filter((x): x is string => !!x);
          if (targets.length < r.targets.length) out.failed.push({ externalId, field: r.field, reason: `${r.targets.length - targets.length} target(s) were not imported.` });
          if (targets.length) data[r.field] = r.many ? targets : targets[0];
        }
        if (Object.keys(data).length === 0) continue;
        const [row] = await tx.select({ version: items.version, collectionId: items.collectionId }).from(items).where(and(eq(items.siteId, siteId), eq(items.id, itemId)));
        if (!row) continue;
        try {
          const updated = await tx.transaction(async (sp) =>
            itemServiceForSystem({ db: sp as unknown as Database, rootDb: db, siteId, userId: actor.userId, provenance: { authorType: 'integration', sources: [{ type: 'site_import' }] } }, 'site-import').patchInTransaction(
              collName.get(row.collectionId)!,
              itemId,
              { data, expectedVersion: row.version },
              afterCommit,
            ),
          );
          await tx.update(importBatchItems).set({ pinnedVersion: updated.version }).where(and(eq(importBatchItems.batchId, batchId), eq(importBatchItems.itemId, itemId)));
          await tx
            .update(importExternalIds)
            .set({ targetVersion: updated.version, updatedAt: new Date() })
            .where(and(eq(importExternalIds.siteId, siteId), eq(importExternalIds.namespace, namespace), eq(importExternalIds.kind, 'item'), eq(importExternalIds.externalId, externalId)));
          out.remapped += Object.keys(data).length;
        } catch (err) {
          for (const f of Object.keys(data)) out.failed.push({ externalId, field: f, reason: errText(err) });
        }
      }
    },
    { retry: false },
  );
  for (const work of afterCommit) await work().catch(() => undefined);
}

export async function importAsNewSite(deps: NewSiteImportDeps, input: NewSiteImportInput): Promise<NewSiteImportReport> {
  const { db } = deps;
  if (!(await canCreateSite(db, input.actor.userId))) throw new SiteImportNewError('FORBIDDEN', 'Importing as a new site needs the instance administrator.', 403);
  const bundle = await loadSiteBundle(input.dir);
  if (bundle.base.media.length > 0 && !input.mediaPublicBaseUrl) {
    throw new SiteImportNewError('MEDIA_STORAGE_REQUIRED', `The bundle has ${bundle.base.media.length} media file(s): give the public base URL of the new site's media storage.`, 422);
  }
  const defaultLanguage = bundle.base.site?.settings.defaultLocale;
  await provisionSite(db, { id: input.siteId, name: input.name, ...(defaultLanguage ? { defaultLanguage } : {}) }, input.actor.userId);
  const siteId = input.siteId;
  const report: NewSiteImportReport = {
    siteId,
    batchId: '',
    toActivate: 0,
    import: undefined as unknown as ImportReport,
    schema: { collectionsCreated: [], fieldsCreated: [], relationsCreated: 0 },
    relations: { remapped: 0, failed: [] },
    theme: null,
    sources: { created: [], skipped: [] },
    autoPublish: bundle.autoPublish ? 'thresholds set; no trust tier granted (off)' : 'not in the bundle',
    settings: [],
    disabled: ['No domain or host is bound.', 'Every item is a draft until the import batch is activated.', 'Sources are paused.', 'Auto-publishing is off (no trust tier granted).'],
  };

  await applySettings(db, siteId, bundle, report.settings);
  await applySchema(db, siteId, bundle, report.schema);

  // The profile service works within the new site's own transaction (RLS), constructed on it.
  const withProfiles = <T>(fn: (p: StorageProfileService) => Promise<T>) =>
    runSiteTransaction(db, siteId, (tx) => fn(new StorageProfileService({ db: tx as unknown as Database, siteId, keys: deps.keys, defaultStorage: deps.defaultStorage, storageDir: deps.storageDir })));
  if (input.mediaPublicBaseUrl) {
    const created = StorageProfileCreateSchema.parse({ name: 'imported-media', driver: 'local', publicBaseUrl: input.mediaPublicBaseUrl });
    await withProfiles(async (profiles) => profiles.bind((await profiles.create(created)).id));
  }

  const importer = new SiteImportService({
    db,
    siteId,
    actor: { userId: input.actor.userId, email: input.actor.email ?? null },
    media: storageMediaStore({
      writeLocation: (key) => withProfiles((p) => p.writeLocation(key)),
      recordWrite: (key, at, meta) => withProfiles((p) => p.recordWrite(key, at, meta)),
    }),
  });
  // Block IDs are the new site's own: whatever a bundle carries is dropped, the item service assigns new ones.
  for (const it of bundle.base.items) for (const [k, v] of Object.entries(it.data)) it.data[k] = withoutBlockIds(v);
  const plan = await importer.dryRun(bundle.base);
  const done = await importer.import(plan.batchId, bundle.base, plan.reportHash);
  report.batchId = plan.batchId;
  report.import = done.report;
  report.toActivate = done.report.summary.batch;

  await remapRelations(db, siteId, bundle.base.namespace, plan.batchId, bundle, input.actor, report.relations);

  if (bundle.theme) {
    const t = bundle.theme;
    const themes = new ThemeService({ db, siteId, actor: { userId: input.actor.userId, email: input.actor.email ?? null } });
    try {
      const templates: Record<string, string> = {};
      for (const tpl of t.templates) templates[tpl.name] = (await bundle.readThemeFile(themeTemplatePath(tpl.name))).toString('utf8');
      const assets = [];
      for (const a of t.assets) assets.push({ path: a.path, contentType: a.contentType, base64: (await bundle.readThemeFile(themeAssetPath(a.path))).toString('base64') });
      const version = await themes.createVersion({ name: t.name, templates, assets });
      report.theme = { name: t.name, versionId: version.id, activated: false };
      if (t.active) {
        try {
          await themes.activate(version.id);
          report.theme.activated = true;
        } catch (err) {
          report.theme.note = `Not activated: ${errText(err)}`;
        }
      }
    } catch (err) {
      report.theme = { name: t.name, versionId: '', activated: false, note: `Not imported: ${errText(err)}` };
    }
  }

  const sources = new IngestSourceService({ db, siteId, actor: { userId: input.actor.userId, isAdmin: true } });
  for (const s of bundle.sources) {
    if (s.sourceType === 'plugin') {
      report.sources.skipped.push({ name: s.name, reason: 'A plugin source needs its plugin enabled on the new site; add it again there.' });
      continue;
    }
    try {
      const created = await sources.create({
        name: s.name,
        type: s.sourceType,
        url: s.url,
        ...(s.listSelectors ? { listSelectors: s.listSelectors } : {}),
        scheduleTimes: s.scheduleTimes,
        timezone: s.timezone,
        ...(s.maxItemsPerRun ? { maxItemsPerRun: s.maxItemsPerRun } : {}),
      });
      await sources.pause(created.id);
      report.sources.created.push(s.name);
    } catch (err) {
      report.sources.skipped.push({ name: s.name, reason: errText(err) });
    }
  }

  if (bundle.autoPublish) {
    const a = bundle.autoPublish.settings as Record<string, unknown>;
    const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined);
    const list = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined);
    const values = {
      ...(typeof a.agentRole === 'string' ? { agentRole: a.agentRole } : {}),
      ...(int(a.vetoWindowMinutes) !== undefined ? { vetoWindowMinutes: int(a.vetoWindowMinutes) } : {}),
      ...(a.dailyLimit === null || int(a.dailyLimit) !== undefined ? { dailyLimit: (a.dailyLimit as number | null) ?? null } : {}),
      ...(int(a.minIntervalMinutes) !== undefined ? { minIntervalMinutes: int(a.minIntervalMinutes) } : {}),
      ...(int(a.sourceMaxAgeDays) !== undefined ? { sourceMaxAgeDays: int(a.sourceMaxAgeDays) } : {}),
      ...(list(a.freshnessExemptCollections) ? { freshnessExemptCollections: list(a.freshnessExemptCollections) } : {}),
      ...(list(a.requiredLocales) ? { requiredLocales: list(a.requiredLocales) } : {}),
    };
    await runSiteTransaction(db, siteId, (tx) =>
      tx
        .insert(autoPublishSettings)
        .values({ siteId, ...values, updatedBy: input.actor.userId })
        .onConflictDoUpdate({ target: autoPublishSettings.siteId, set: { ...values, updatedBy: input.actor.userId, updatedAt: new Date() } }),
    );
  }
  return report;
}
