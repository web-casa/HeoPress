import { createHash } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  autoPublishSettings,
  collections,
  fields,
  ingestSources,
  items,
  mediaObjects,
  relations,
  siteContentSettings,
  sites,
  siteThemes,
  themeAssets,
  themes,
  themeVersions,
  translationGroupMembers,
  translationGroups,
  type Database,
} from '@heopress/database';
import type { KeyProvider, StorageProvider } from '@heopress/runtime';
import {
  findCredentialFields,
  IMPORT_BUNDLE_FORMAT,
  IMPORT_BUNDLE_MEDIA_DIR,
  IMPORT_BUNDLE_RECORDS_FILE,
  IMPORT_BUNDLE_THEME_DIR,
  IMPORT_BUNDLE_VERSION,
  IMPORT_MEDIA_REF_PREFIX,
  IMPORT_MEDIA_TYPES,
  isCredentialKey,
  type ImportRecord,
} from '@heopress/contracts/schemas';
import { PermissionService } from '../permission-service';
import { runSiteTransaction } from '../rls-transaction';
import { canCreateSite } from '../sites/site-provisioning';
import { StorageProfileService } from '../storage/storage-profile-service';
import { isSafeRelativePath, sniffMatches } from '../site-import/bundle-reader';
import { loadSiteBundle, themeAssetPath, themeTemplatePath, withoutBlockIds } from './site-bundle';

/**
 * Single-site logical export (HeoPress P13 tasks 1.2, 1.6; spec ops/backup-restore "单站点导出与导入", "单站导出安全范围").
 *
 * The site's content, settings, theme version and media, as a P12 import bundle (source `heopress`) with the records
 * only "import as new site" reads. Only someone who administers the site may export it. What it never carries:
 *
 *   - another site's content: every read is in the site's own transaction (RLS) and names the site; a translation
 *     group's members on other sites are left out (counted in the report), and a relation to an item that is not in
 *     the export is dropped;
 *   - secrets and credentials: storage profiles, API keys, webhooks, model keys, Git and deployment settings are not
 *     read at all; encrypted fields keep their definition but not their values; a field or setting whose name or
 *     value looks like a credential is dropped (`findCredentialFields`) and listed;
 *   - domains, the site URL and hosts: a new site is bound to its domain by a person;
 *   - autonomy: the trust tiers that turn auto-publishing on are not exported; sources are exported with their
 *     schedule but are imported paused, their terms back at the defaults.
 *
 * Media files are referenced from content as `heopress-media:<id>` (the importer stores them on the new site and
 * links there); a file of a type an import does not take (SVG, for one) stays out and is listed.
 */

export class SiteExportError extends Error {
  constructor(
    readonly code: 'FORBIDDEN' | 'NOT_FOUND' | 'TARGET_NOT_EMPTY',
    message: string,
    readonly status: 403 | 404 | 409,
  ) {
    super(message);
    this.name = 'SiteExportError';
  }
}

export interface SiteExportDeps {
  db: Database;
  keys: KeyProvider;
  /** The instance default storage (`runtime.storage`). */
  defaultStorage: StorageProvider;
  storageDir?: string;
}

export interface SiteExportReport {
  siteId: string;
  bundleHash: string;
  items: number;
  media: number;
  collections: number;
  relations: number;
  theme: string | null;
  sources: number;
  /** What was left out, and why. */
  dropped: Array<{ what: string; detail: string }>;
  /** Members of the site's translation groups that are on other sites (not exported). */
  otherSiteMembers: number;
}

const NAME = /^[a-z][a-z0-9_]*$/;
const MEDIA_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'application/pdf': 'pdf' };
const MEDIA_MAX_BYTES = 50 * 1024 * 1024;
const FIELD_DEFINITION_KEYS = [
  'display',
  'label',
  'note',
  'defaultValue',
  'nullable',
  'unique',
  'indexed',
  'searchable',
  'length',
  'precision',
  'scale',
  'special',
  'options',
  'displayOptions',
  'validation',
  'conditions',
  'required',
  'readonly',
  'hidden',
  'encrypted',
  'classification',
  'versioned',
  'rawEnabled',
  'width',
  'group',
  'sortOrder',
] as const;
const COLLECTION_META_KEYS = ['label', 'pluralLabel', 'hidden', 'singleton', 'icon', 'color', 'note', 'displayTemplate', 'sortField', 'archiveField', 'archiveValue', 'unarchiveValue', 'versioning', 'accountability'] as const;

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const isoOf = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);
const slugOf = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'site';

/** Whether `userId` administers `siteId` (or is the instance administrator). */
async function isSiteAdministrator(db: Database, siteId: string, userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false;
  if (await canCreateSite(db, userId)) return true;
  const bundle = await new PermissionService({ db, ctx: { userId, siteId, roleId: null, ip: null, headers: {}, user: { id: userId } } }).bundle();
  return bundle.admin === true;
}

/** Drop the keys of `value` that name or carry a credential; the dropped paths are returned. */
function withoutCredentials(value: Record<string, unknown>): { clean: Record<string, unknown>; dropped: string[] } {
  const clean: Record<string, unknown> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (v === null || v === undefined) continue;
    if (isCredentialKey(k) || findCredentialFields(v, k).length > 0) dropped.push(k);
    else clean[k] = v;
  }
  return { clean, dropped };
}

/**
 * Export `siteId` into the empty (or new) directory `dir`. Resolves with the report; the bundle is read back with the
 * importer's own checks before this returns.
 */
export async function exportSite(deps: SiteExportDeps, input: { siteId: string; actor: { userId: string | null }; dir: string }): Promise<SiteExportReport> {
  const { db } = deps;
  const { siteId } = input;
  if (!(await isSiteAdministrator(db, siteId, input.actor.userId))) throw new SiteExportError('FORBIDDEN', 'Exporting a site needs administrator access to that site.', 403);
  const existing = await readdir(input.dir).catch(() => null);
  if (existing && existing.length > 0) throw new SiteExportError('TARGET_NOT_EMPTY', 'The export directory is not empty.', 409);
  await mkdir(path.join(input.dir, IMPORT_BUNDLE_MEDIA_DIR), { recursive: true, mode: 0o700 });

  const dropped: SiteExportReport['dropped'] = [];
  const records: ImportRecord[] = [];
  const snapshot = await runSiteTransaction(db, siteId, async (tx) => {
    const [site] = await tx.select().from(sites).where(eq(sites.id, siteId));
    if (!site) throw new SiteExportError('NOT_FOUND', `No site "${siteId}".`, 404);
    const [settings] = await tx.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    const colls = await tx.select().from(collections).where(eq(collections.siteId, siteId));
    const fieldRows = await tx.select().from(fields).where(eq(fields.siteId, siteId));
    const relationRows = await tx.select().from(relations).where(eq(relations.siteId, siteId));
    const itemRows = await tx.select().from(items).where(and(eq(items.siteId, siteId), isNull(items.deletedAt)));
    const members = await tx.select().from(translationGroupMembers).where(eq(translationGroupMembers.siteId, siteId));
    const media = await tx.select().from(mediaObjects).where(eq(mediaObjects.siteId, siteId));
    const [pointer] = await tx.select().from(siteThemes).where(eq(siteThemes.siteId, siteId));
    let theme: { name: string; version: typeof themeVersions.$inferSelect; assets: Array<typeof themeAssets.$inferSelect> } | null = null;
    if (pointer) {
      const [v] = await tx
        .select({ version: themeVersions, name: themes.name })
        .from(themeVersions)
        .innerJoin(themes, and(eq(themes.id, themeVersions.themeId), eq(themes.siteId, themeVersions.siteId)))
        .where(and(eq(themeVersions.siteId, siteId), eq(themeVersions.id, pointer.themeVersionId)));
      if (v) theme = { name: v.name, version: v.version, assets: await tx.select().from(themeAssets).where(and(eq(themeAssets.siteId, siteId), eq(themeAssets.versionId, v.version.id))) };
    }
    const sources = await tx.select().from(ingestSources).where(and(eq(ingestSources.siteId, siteId), isNull(ingestSources.managedBy)));
    const [autoPublish] = await tx.select().from(autoPublishSettings).where(eq(autoPublishSettings.siteId, siteId));
    // Members of this site's groups elsewhere: counted, never read.
    const groupIds = [...new Set(members.map((m) => m.groupId))];
    const groupSites = groupIds.length ? await tx.select({ siteIds: translationGroups.siteIds }).from(translationGroups).where(inArray(translationGroups.id, groupIds)) : [];
    return { site, settings, colls, fieldRows, relationRows, itemRows, members, media, theme, sources, autoPublish, groupIds, groupSites };
  });
  const { site, settings } = snapshot;

  // Header and site settings.
  records.push({ type: 'header', format: IMPORT_BUNDLE_FORMAT, version: IMPORT_BUNDLE_VERSION, source: 'heopress', sourceSite: slugOf(siteId), generatedAt: new Date().toISOString(), generator: 'heopress site export' });
  const locales = [...new Set([site.defaultLanguage, ...(settings?.availableLocales ?? [])])];
  records.push({
    type: 'site',
    settings: {
      name: site.name,
      defaultLocale: site.defaultLanguage,
      locales,
      ...(settings ? { trailingSlash: settings.trailingSlash as 'always' | 'never', timezone: settings.timezone } : {}),
      ...(settings && Object.keys(settings.permalinks ?? {}).length ? { permalinks: Object.fromEntries(Object.entries(settings.permalinks).filter(([k]) => NAME.test(k))) } : {}),
      ...(settings && Object.keys(settings.localePrefixes ?? {}).length ? { localePrefixes: settings.localePrefixes } : {}),
    },
  });
  if (settings) {
    const content = { siteType: settings.siteType, localeStrategy: settings.localeStrategy, localePrefixMode: settings.localePrefixMode, sponsorDisclosure: settings.sponsorDisclosure, sponsorRel: settings.sponsorRel };
    const presentation = withoutCredentials({ displayTitle: site.displayTitle, descriptor: site.descriptor, defaultAppearance: site.defaultAppearance, branding: site.branding, themeOverrides: site.themeOverrides, customCss: site.customCss });
    for (const k of presentation.dropped) dropped.push({ what: 'setting', detail: `Site setting "${k}" looks like a credential; left out.` });
    records.push({ type: 'siteConfig', content, site: presentation.clean });
  }

  // Schema: every collection that is not a system one, its fields and many-to-one relations.
  const collById = new Map(snapshot.colls.map((c) => [c.id, c]));
  const exported = new Map<string, { relationFields: Map<string, boolean>; encrypted: Set<string>; known: Set<string> }>();
  for (const c of snapshot.colls) {
    if (c.system || !NAME.test(c.name)) continue;
    const relationFields = new Map<string, boolean>();
    const encrypted = new Set<string>();
    const known = new Set<string>();
    const fieldRecords = [];
    for (const f of snapshot.fieldRows.filter((x) => x.collectionId === c.id).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))) {
      if (!NAME.test(f.name)) continue;
      known.add(f.name);
      if (f.encrypted) encrypted.add(f.name);
      const options = (f.options ?? {}) as Record<string, unknown>;
      if (f.interface === 'tags' && typeof options.itemsOf === 'string') relationFields.set(f.name, true);
      const def = withoutCredentials(Object.fromEntries(FIELD_DEFINITION_KEYS.map((k) => [k, (f as Record<string, unknown>)[k]])));
      for (const k of def.dropped) dropped.push({ what: 'field', detail: `"${k}" of field ${c.name}.${f.name} looks like a credential; left out.` });
      fieldRecords.push({ name: f.name, type: f.type, interface: f.interface, ...(Object.keys(def.clean).length ? { definition: def.clean } : {}) });
    }
    const rels = snapshot.relationRows
      .filter((r) => r.manyCollection === c.name && r.oneCollection && !r.junctionCollection && NAME.test(r.manyField) && NAME.test(r.oneCollection))
      .map((r) => ({ field: r.manyField, collection: r.oneCollection! }));
    for (const r of rels) relationFields.set(r.field, false);
    const meta = withoutCredentials(Object.fromEntries(COLLECTION_META_KEYS.map((k) => [k, (c as Record<string, unknown>)[k]])));
    records.push({ type: 'collectionSchema', collection: c.name, ...(Object.keys(meta.clean).length ? { meta: meta.clean } : {}), fields: fieldRecords, ...(rels.length ? { relations: rels } : {}) });
    records.push({ type: 'collection', source: c.name, collection: c.name });
    exported.set(c.name, { relationFields, encrypted, known });
  }

  // Media: files of types an import takes, under media/; content references rewritten to `heopress-media:<id>`.
  const locate = (key: string) =>
    runSiteTransaction(db, siteId, (tx) => new StorageProfileService({ db: tx as unknown as Database, siteId, keys: deps.keys, defaultStorage: deps.defaultStorage, storageDir: deps.storageDir }).readLocation(key));
  const mediaIdByKey = new Map<string, string>();
  let mediaCount = 0;
  for (const m of snapshot.media) {
    const type = (m.contentType ?? '').split(';')[0]!.trim().toLowerCase();
    if (!(IMPORT_MEDIA_TYPES as readonly string[]).includes(type)) {
      dropped.push({ what: 'media', detail: `"${m.key}" (${type || 'unknown type'}) is not a type an import takes; left out.` });
      continue;
    }
    let bytes: Buffer;
    try {
      const at = await locate(m.key);
      const obj = await at.storage.get(at.objectKey);
      if (!obj) throw new Error('missing from its storage');
      bytes = Buffer.isBuffer(obj.body) ? obj.body : Buffer.from(await new Response(obj.body as BodyInit).arrayBuffer());
    } catch (err) {
      dropped.push({ what: 'media', detail: `"${m.key}" could not be read: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }
    if (bytes.length > MEDIA_MAX_BYTES || !sniffMatches(type, bytes.subarray(0, 16))) {
      dropped.push({ what: 'media', detail: `"${m.key}" is larger than an import takes, or not the type it is recorded as; left out.` });
      continue;
    }
    const hash = sha256(bytes);
    const id = `m-${sha256(m.key).slice(0, 24)}`;
    const rel = `${hash.slice(0, 2)}/${hash}.${MEDIA_EXT[type]}`;
    await mkdir(path.join(input.dir, IMPORT_BUNDLE_MEDIA_DIR, hash.slice(0, 2)), { recursive: true });
    await writeFile(path.join(input.dir, IMPORT_BUNDLE_MEDIA_DIR, ...rel.split('/')), bytes, { mode: 0o600 });
    records.push({ type: 'media', id, path: rel, size: bytes.length, sha256: hash, mimeType: type as (typeof IMPORT_MEDIA_TYPES)[number] });
    mediaIdByKey.set(m.key, id);
    mediaCount++;
  }
  const mediaUrl = new RegExp(`(?:https?://[^\\s"'<>()]*?)?/sites/${siteId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/media/([^\\s"'<>()?#]+)`, 'g');
  const rewriteMedia = (s: string) =>
    s.replace(mediaUrl, (whole, key: string) => {
      const id = mediaIdByKey.get(decodeURIComponent(key)) ?? mediaIdByKey.get(key);
      return id ? `${IMPORT_MEDIA_REF_PREFIX}${id}` : whole;
    });

  // Items, their relations and translation groups.
  const itemIds = new Set(snapshot.itemRows.filter((i) => exported.has(collById.get(i.collectionId)?.name ?? '')).map((i) => i.id));
  const memberOf = new Map(snapshot.members.map((m) => [m.itemId, m]));
  let relationCount = 0;
  let itemCount = 0;
  for (const it of snapshot.itemRows) {
    const coll = collById.get(it.collectionId);
    const info = coll ? exported.get(coll.name) : undefined;
    if (!coll || !info) continue;
    const data: Record<string, unknown> = {};
    const src = (it.data ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue;
      if (!NAME.test(k) || !info.known.has(k)) continue;
      if (info.encrypted.has(k)) {
        if (v !== null) dropped.push({ what: 'field', detail: `${coll.name}.${k} of ${it.id} is encrypted; its value is not exported.` });
        continue;
      }
      if (info.relationFields.has(k)) {
        const many = info.relationFields.get(k)!;
        const ids = (Array.isArray(v) ? v : v === null ? [] : [v]).filter((x): x is string => typeof x === 'string');
        const targets = ids.filter((x) => itemIds.has(x));
        if (targets.length < ids.length) dropped.push({ what: 'relation', detail: `${coll.name}.${k} of ${it.id}: ${ids.length - targets.length} target(s) not in this export (another site, or deleted); left out.` });
        if (targets.length) {
          records.push({ type: 'relation', externalId: it.id, field: k, targets, many });
          relationCount++;
        }
        continue;
      }
      if (isCredentialKey(k) || findCredentialFields(v, k).length > 0) {
        dropped.push({ what: 'field', detail: `${coll.name}.${k} of ${it.id} looks like a credential; left out.` });
        continue;
      }
      const value = withoutBlockIds(v);
      data[k] = typeof value === 'string' ? rewriteMedia(value) : value;
    }
    const member = memberOf.get(it.id);
    const localeValue = typeof src.locale === 'string' && src.locale ? src.locale : (member?.locale ?? site.defaultLanguage);
    records.push({
      type: 'item',
      externalId: it.id,
      collection: coll.name,
      locale: localeValue,
      status: it.status === 'published' ? 'published' : 'draft',
      ...(member ? { translationKey: `tg-${member.groupId}` } : {}),
      ...(member?.internalOnly ? { internalOnly: true } : {}),
      ...(it.publishedAt ? { publishedAt: isoOf(it.publishedAt) } : {}),
      ...(it.status === 'archived' ? { notes: ['Archived on the source site; imported as a draft.'] } : {}),
      data,
    });
    itemCount++;
  }
  let otherSiteMembers = 0;
  for (const groupId of snapshot.groupIds) {
    const here = snapshot.members.filter((m) => m.groupId === groupId && itemIds.has(m.itemId));
    if (here.length === 0) continue;
    const source = here.find((m) => m.role === 'source');
    records.push({ type: 'translationGroup', key: `tg-${groupId}`, members: here.map((m) => m.itemId), ...(source ? { source: source.itemId } : {}) });
  }
  // Groups that span sites: how many other sites they name (from the group rows this site can see; no row of another
  // site is read).
  for (const g of snapshot.groupSites) otherSiteMembers += g.siteIds.filter((x) => x !== siteId).length;
  if (otherSiteMembers > 0) dropped.push({ what: 'translation', detail: `Translation groups of this site also have members on ${otherSiteMembers} other site(s); those members are not exported.` });

  // Theme: the active version, its templates and assets as files.
  let themeName: string | null = null;
  if (snapshot.theme) {
    const t = snapshot.theme;
    const templates = Object.entries(t.version.templates ?? {});
    const unsafe = templates.filter(([name]) => !isSafeRelativePath(themeTemplatePath(name))).map(([n]) => n);
    if (unsafe.length) dropped.push({ what: 'theme', detail: `Theme "${t.name}" has template names that are not plain paths (${unsafe.join(', ')}); the theme is not exported.` });
    else {
      const themeRoot = path.join(input.dir, IMPORT_BUNDLE_THEME_DIR);
      const write = async (rel: string, bytes: Buffer) => {
        const file = path.join(themeRoot, ...rel.split('/'));
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, bytes, { mode: 0o600 });
      };
      const tplRecords = [];
      for (const [name, text] of templates) {
        const bytes = Buffer.from(text, 'utf8');
        await write(themeTemplatePath(name), bytes);
        tplRecords.push({ name, size: bytes.length, sha256: sha256(bytes) });
      }
      const assetRecords = [];
      for (const a of t.assets) {
        await write(themeAssetPath(a.path), a.bytes);
        assetRecords.push({ path: a.path, contentType: a.contentType, size: a.bytes.length, sha256: sha256(a.bytes) });
      }
      records.push({ type: 'theme', name: t.name, active: true, templates: tplRecords, assets: assetRecords });
      themeName = t.name;
    }
  }

  // Sources (imported paused, terms reset) and the auto-publish thresholds (never the trust tiers).
  let sourceCount = 0;
  for (const s of snapshot.sources) {
    const rec = {
      type: 'ingestSource' as const,
      name: s.name,
      sourceType: s.type,
      url: s.url,
      ...(s.adapter ? { adapter: s.adapter } : {}),
      ...(s.listSelectors ? { listSelectors: Object.fromEntries(Object.entries(s.listSelectors).filter(([, v]) => typeof v === 'string')) as Record<string, string> } : {}),
      scheduleTimes: s.scheduleTimes,
      timezone: s.timezone,
      maxItemsPerRun: s.maxItemsPerRun,
    };
    if (findCredentialFields(rec).length > 0 || !/^https?:\/\//.test(s.url)) {
      dropped.push({ what: 'source', detail: `Source "${s.name}" carries a credential in its address (or is not http/https); left out.` });
      continue;
    }
    records.push(rec);
    sourceCount++;
  }
  if (snapshot.autoPublish) {
    const a = snapshot.autoPublish;
    records.push({
      type: 'autoPublish',
      settings: { agentRole: a.agentRole, vetoWindowMinutes: a.vetoWindowMinutes, dailyLimit: a.dailyLimit, minIntervalMinutes: a.minIntervalMinutes, sourceMaxAgeDays: a.sourceMaxAgeDays, freshnessExemptCollections: a.freshnessExemptCollections, requiredLocales: a.requiredLocales },
    });
  }

  await writeFile(path.join(input.dir, IMPORT_BUNDLE_RECORDS_FILE), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`, { mode: 0o600 });
  // Read back with the importer's checks: an export that would not import is a failure here, not on the new site.
  const loaded = await loadSiteBundle(input.dir);
  return {
    siteId,
    bundleHash: loaded.base.hash,
    items: itemCount,
    media: mediaCount,
    collections: exported.size,
    relations: relationCount,
    theme: themeName,
    sources: sourceCount,
    dropped,
    otherSiteMembers,
  };
}
