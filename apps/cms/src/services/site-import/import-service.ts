import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  collections,
  contentRoutes,
  fields,
  importBatches,
  importBatchItems,
  importExternalIds,
  items,
  siteContentSettings,
  sites,
  translationGroupMembers,
  type Database,
} from '@heopress/database';
import { findCredentialFields, type ImportItem, type ImportMedia } from '@heopress/contracts/schemas';
import { AuditLogger } from '../../modules/audit/logger';
import type { ItemService } from '../item-service';
import { itemServiceForSystem } from '../item-service-factory';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import { importRedirectsInTransaction } from '../site-network/redirect-import';
import { TranslationGroupService } from '../site-network/translation-group-service';
import { prepareRichText, resolveMediaRefs, unsafeMarkup } from './body';
import type { LoadedBundle } from './bundle-reader';

/**
 * Site import (HeoPress P12 tasks 6.2, 6.3; spec migration/import-bundle "预演与幂等导入", "导入批次激活";
 * design decision 8).
 *
 * **Dry run** — the import is run for real inside a transaction that is then rolled back: items created or updated
 * as drafts, translation groups formed, routes computed, and every outcome recorded (new, updated, unchanged,
 * conflicts, failures, what could not be converted, path changes, safety issues). Nothing stays, and no media is
 * stored. The report and its hash are kept as a `planned` batch.
 *
 * **Import** — the same run, committed, but only when it reports exactly what the dry run did (same hash: otherwise
 * the site or the bundle changed — 409, dry-run again). External IDs are namespaced `<source>:<sourceSite>`: a
 * record imported before is updated only when it changed, and never over a person's edit (the item's version moved
 * since the last import: a conflict, left alone) or over a live item. Importing the same bundle twice adds nothing.
 * Every item is written as a **draft**: nothing reaches the public site, the discovery files or IndexNow.
 *
 * **Activation** — the items the old site had published make up the batch. One transaction re-checks each against
 * what was pinned (the item version the import left; the safety issues found then), and again against the item as it
 * is: not held, not internal only, no unsafe markup, unchanged since the import, and the activating person may
 * publish it. Any failure blocks the whole batch and lists the reasons; SEO gaps are only noted. Then every item is
 * published with that person's permissions, the bundle's redirects (and redirects for paths that changed) are
 * written, and the batch rows stay as the items' "historical import" marking.
 */

type Tx = SiteTransaction;

interface ImportActor {
  userId: string | null;
  email?: string | null;
}

/** Where imported media goes (object storage in production; a memory store in tests). */
export interface ImportMediaStore {
  put(input: { key: string; bytes: Buffer; mimeType: string; sha256: string }): Promise<{ url: string }>;
}

class SiteImportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 422,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'SiteImportError';
  }
}

type ItemAction = 'create' | 'update' | 'unchanged' | 'conflict' | 'failed';

export interface ImportReport {
  namespace: string;
  bundleHash: string;
  summary: Record<ItemAction, number> & { media: number; redirects: number; groups: number; batch: number };
  items: Array<{ externalId: string; collection: string; locale: string; action: ItemAction; reason?: string; path?: string | null }>;
  /** Content that could not be converted as is (unknown collections and fields, terms not on the site, missing media). */
  unconverted: Array<{ externalId?: string; what: string; detail: string }>;
  /** Old path → the path on this site, where they differ (a redirect is written on activation). */
  pathChanges: Array<{ externalId: string; from: string; to: string }>;
  /** Unsafe markup removed from an item: its batch cannot be activated until the item was reviewed. */
  safety: Array<{ externalId: string; issues: string[] }>;
  /** How the bundle's site settings differ from the site's. */
  settings: string[];
  redirects: Array<{ from: string; to: string }>;
  revisions: number;
}

interface CollectionInfo {
  id: string;
  name: string;
  fields: Map<string, string>;
}

interface RunState {
  report: ImportReport;
  /** externalId → item id, version, publish target, safety issues. */
  written: Map<string, { itemId: string; version: number; collection: string; issues: string[]; internalOnly: boolean; publish: boolean }>;
  afterCommit: Array<() => Promise<void>>;
  externalRows: Array<typeof importExternalIds.$inferInsert>;
}

class DryRunRollback extends Error {
  constructor(readonly state: RunState) {
    super('dry run');
  }
}

class ActivationBlocked extends Error {
  constructor(readonly result: ActivationResult) {
    super('activation blocked');
  }
}

export interface ActivationResult {
  activated: boolean;
  items: number;
  /** Why it cannot be activated, per item. */
  blocked: Array<{ itemId: string; externalId: string; code: string; message: string }>;
  /** SEO gaps: noted, never blocking. */
  seo: Array<{ itemId: string; externalId: string; message: string }>;
  redirects?: number;
}

/** Stable JSON: keys sorted at every level. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');

const MEDIA_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'application/pdf': 'pdf',
};

export interface SiteImportDeps {
  db: Database;
  siteId: string;
  actor: ImportActor;
  /** Required to import (not to dry-run) a bundle with media. */
  media?: ImportMediaStore;
}

export class SiteImportService {
  constructor(private readonly deps: SiteImportDeps) {}

  /** Dry run: the report, kept as a `planned` batch. */
  async dryRun(bundle: LoadedBundle): Promise<{ batchId: string; report: ImportReport; reportHash: string }> {
    let state: RunState;
    try {
      await runSiteTransaction(
        this.deps.db,
        this.deps.siteId,
        async (tx) => {
          const s = await this.run(tx, bundle, 'dry');
          throw new DryRunRollback(s);
        },
        { retry: false },
      );
      throw new Error('unreachable');
    } catch (err) {
      if (!(err instanceof DryRunRollback)) throw err;
      state = err.state;
    }
    const reportHash = sha256(canonicalJson(state.report));
    const batchId = await runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      const [row] = await tx
        .insert(importBatches)
        .values({ siteId: this.deps.siteId, namespace: bundle.namespace, bundleHash: bundle.hash, reportHash, report: state.report as unknown as Record<string, unknown>, createdBy: this.deps.actor.userId })
        .returning({ id: importBatches.id });
      return row!.id;
    });
    return { batchId, report: state.report, reportHash };
  }

  /** Import a dry run's batch: the same bundle, and the same report now, or a 409. */
  async import(batchId: string, bundle: LoadedBundle, reportHash: string): Promise<{ report: ImportReport }> {
    const state = await runSiteTransaction(
      this.deps.db,
      this.deps.siteId,
      async (tx) => {
        const [batch] = await tx
          .select()
          .from(importBatches)
          .where(and(eq(importBatches.siteId, this.deps.siteId), eq(importBatches.id, batchId)))
          .for('update');
        if (!batch) throw new SiteImportError('NOT_FOUND', 'No such import batch.', 404);
        if (batch.status !== 'planned') throw new SiteImportError('BATCH_NOT_PLANNED', `The batch is ${batch.status}; run a new dry run.`, 409);
        if (batch.bundleHash !== bundle.hash || batch.namespace !== bundle.namespace) throw new SiteImportError('BUNDLE_DIFFERS', 'This is not the bundle the dry run read.', 409);
        if (batch.reportHash !== reportHash) throw new SiteImportError('REPORT_STALE', 'This is not the report of the dry run.', 409);
        // One import of a namespace at a time.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`site-import:${this.deps.siteId}:${bundle.namespace}`}))`);
        const s = await this.run(tx, bundle, 'real');
        if (sha256(canonicalJson(s.report)) !== reportHash) {
          throw new SiteImportError('REPORT_STALE', 'The site changed since the dry run; run the dry run again.', 409, s.report);
        }
        for (const row of s.externalRows) {
          await tx
            .insert(importExternalIds)
            .values({ ...row, batchId })
            .onConflictDoUpdate({
              target: [importExternalIds.siteId, importExternalIds.namespace, importExternalIds.kind, importExternalIds.externalId],
              set: { targetId: row.targetId, recordHash: row.recordHash, targetVersion: row.targetVersion ?? null, batchId, updatedAt: new Date() },
            });
        }
        // Earlier batches of this namespace not yet activated are replaced by this one.
        await tx
          .update(importBatches)
          .set({ status: 'superseded' })
          .where(and(eq(importBatches.siteId, this.deps.siteId), eq(importBatches.namespace, bundle.namespace), inArray(importBatches.status, ['planned', 'imported'])));
        const members = [...s.written.entries()].filter(([, w]) => w.publish);
        if (members.length > 0) {
          await tx.insert(importBatchItems).values(
            members.map(([externalId, w]) => ({
              batchId,
              siteId: this.deps.siteId,
              itemId: w.itemId,
              externalId,
              collection: w.collection,
              pinnedVersion: w.version,
              safetyIssues: w.issues,
              internalOnly: w.internalOnly,
            })),
          );
        }
        await tx.update(importBatches).set({ status: 'imported', importedAt: new Date() }).where(eq(importBatches.id, batchId));
        await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).writeInTransaction(tx, {
          siteId: this.deps.siteId,
          event: 'site_import_imported',
          actorEmail: this.deps.actor.email ?? null,
          metadata: { operator: this.deps.actor.userId, batchId, namespace: bundle.namespace, summary: s.report.summary },
        });
        return s;
      },
      { retry: false },
    );
    for (const work of state.afterCommit) await work().catch(() => undefined);
    return { report: state.report };
  }

  // ------------------------------------------------------------------ the run

  private async run(tx: Tx, bundle: LoadedBundle, mode: 'dry' | 'real'): Promise<RunState> {
    const siteId = this.deps.siteId;
    const report: ImportReport = {
      namespace: bundle.namespace,
      bundleHash: bundle.hash,
      summary: { create: 0, update: 0, unchanged: 0, conflict: 0, failed: 0, media: 0, redirects: 0, groups: 0, batch: 0 },
      items: [],
      unconverted: [],
      pathChanges: [],
      safety: [],
      settings: [],
      redirects: bundle.redirects.map((r) => ({ from: r.from, to: r.to })),
      revisions: bundle.revisions.length,
    };
    const state: RunState = { report, written: new Map(), afterCommit: [], externalRows: [] };
    const known = await this.externalIds(tx, bundle.namespace);

    // Site settings: compared, never changed by an import.
    const [settings] = await tx.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    const [site] = await tx.select({ defaultLanguage: sites.defaultLanguage }).from(sites).where(eq(sites.id, siteId));
    const available = new Set(settings?.availableLocales ?? []);
    if (bundle.site) {
      const s = bundle.site.settings;
      for (const l of s.locales) if (!available.has(l)) report.settings.push(`Language ${l} is not one of the site's languages.`);
      if (s.trailingSlash && settings && s.trailingSlash !== settings.trailingSlash) report.settings.push(`Trailing slash: the bundle has "${s.trailingSlash}", the site "${settings.trailingSlash}".`);
      for (const [coll, pattern] of Object.entries(s.permalinks ?? {})) {
        const mine = settings?.permalinks?.[coll];
        if (mine !== pattern) report.settings.push(`Permalink of ${coll}: the bundle has "${pattern}", the site ${mine ? `"${mine}"` : 'none'}.`);
      }
    }

    // Collections and their fields.
    const colls = new Map<string, CollectionInfo>();
    for (const c of await tx.select({ id: collections.id, name: collections.name }).from(collections).where(eq(collections.siteId, siteId))) {
      colls.set(c.name, { id: c.id, name: c.name, fields: new Map() });
    }
    for (const f of await tx.select({ collectionId: fields.collectionId, name: fields.name, interface: fields.interface }).from(fields).where(eq(fields.siteId, siteId))) {
      for (const c of colls.values()) if (c.id === f.collectionId) c.fields.set(f.name, f.interface);
    }
    for (const m of bundle.collections) {
      const c = colls.get(m.collection);
      if (!c) report.unconverted.push({ what: 'collection', detail: `Collection "${m.collection}" (from "${m.source}") is not on this site.` });
      else for (const target of Object.values(m.fields ?? {})) if (!c.fields.has(target)) report.unconverted.push({ what: 'field', detail: `Field "${target}" of "${m.collection}" is not on this site.` });
    }

    // Media: content-addressed; a file imported before with the same hash is not stored again.
    const mediaUrl = new Map<string, string>();
    for (const m of bundle.media) {
      const prior = known.get(`media\u0000${m.id}`);
      if (prior && prior.recordHash === m.sha256) {
        mediaUrl.set(m.id, prior.targetId);
        continue;
      }
      report.summary.media++;
      const url = mode === 'dry' ? `/_import-media/${m.sha256}` : await this.storeMedia(bundle, m);
      mediaUrl.set(m.id, url);
      state.externalRows.push({ siteId, namespace: bundle.namespace, kind: 'media', externalId: m.id, targetId: url, recordHash: m.sha256 });
    }
    const resolveMedia = (id: string) => mediaUrl.get(id) ?? null;

    const licences = new Map(bundle.licences.map((l) => [l.subject, l]));
    const lookup = await this.termLookup(tx, colls);

    for (const it of bundle.items) {
      const coll = colls.get(it.collection);
      const entry = (action: ItemAction, extra: { reason?: string; path?: string | null } = {}) => {
        report.summary[action]++;
        report.items.push({ externalId: it.externalId, collection: it.collection, locale: it.locale, action, ...extra });
      };
      if (!coll) {
        entry('failed', { reason: `Collection "${it.collection}" is not on this site.` });
        continue;
      }
      for (const note of it.notes ?? []) report.unconverted.push({ externalId: it.externalId, what: 'conversion', detail: note });
      const recordHash = sha256(canonicalJson({ it, licence: licences.get(it.externalId) ?? null }));
      const { data, issues } = this.itemData(it, coll, report, resolveMedia, lookup, licences.get(it.externalId));
      const prior = known.get(`item\u0000${it.externalId}`);
      const publish = it.status === 'published' && !it.internalOnly;
      try {
        if (!prior) {
          const created = await tx.transaction(async (sp) =>
            this.systemItems(sp as unknown as Tx).createInTransaction(
              coll.name,
              { data, status: 'draft', ...(it.publishedAt ? { publishedAt: new Date(it.publishedAt) } : {}) },
              state.afterCommit,
            ),
          );
          state.written.set(it.externalId, { itemId: created.id, version: created.version, collection: coll.name, issues, internalOnly: !!it.internalOnly, publish });
          state.externalRows.push({ siteId, namespace: bundle.namespace, kind: 'item', externalId: it.externalId, targetId: created.id, recordHash, targetVersion: created.version });
          entry('create', { path: await this.pathOf(tx, created.id) });
        } else {
          const [row] = await tx
            .select({ id: items.id, version: items.version, status: items.status, deletedAt: items.deletedAt, data: items.data })
            .from(items)
            .where(and(eq(items.siteId, siteId), eq(items.id, prior.targetId)));
          if (!row || row.deletedAt) {
            entry('conflict', { reason: 'Deleted on this site since the last import; not imported again.' });
            continue;
          }
          const keep = (version: number, why: string | null) => {
            // Still waiting to go live: it stays in the batch, as it is now.
            if (publish && row.status !== 'published') {
              const current = this.currentIssues(row.data as Record<string, unknown>, coll);
              state.written.set(it.externalId, { itemId: row.id, version, collection: coll.name, issues: why === null && version === prior.targetVersion ? [...issues, ...current].filter((x, i, a) => a.indexOf(x) === i) : current, internalOnly: !!it.internalOnly, publish });
            }
          };
          if (prior.recordHash === recordHash) {
            keep(row.version, null);
            entry('unchanged', { path: await this.pathOf(tx, row.id) });
          } else if (row.status === 'published') {
            entry('conflict', { reason: 'Live on this site: change it there, the import does not overwrite published content.' });
          } else if (row.version !== prior.targetVersion) {
            keep(row.version, 'edited');
            entry('conflict', { reason: 'Edited on this site since the last import: kept as edited.' });
          } else {
            const updated = await tx.transaction(async (sp) =>
              this.systemItems(sp as unknown as Tx).patchInTransaction(coll.name, row.id, { data, expectedVersion: row.version }, state.afterCommit),
            );
            state.written.set(it.externalId, { itemId: row.id, version: updated.version, collection: coll.name, issues, internalOnly: !!it.internalOnly, publish });
            state.externalRows.push({ siteId, namespace: bundle.namespace, kind: 'item', externalId: it.externalId, targetId: row.id, recordHash, targetVersion: updated.version });
            entry('update', { path: await this.pathOf(tx, row.id) });
          }
        }
      } catch (err) {
        entry('failed', { reason: errorText(err) });
        continue;
      }
      if (issues.length > 0) report.safety.push({ externalId: it.externalId, issues });
      const w = state.written.get(it.externalId);
      if (w && it.legacyPath) {
        const now = await this.publicPathOf(tx, w.itemId, settings, site?.defaultLanguage ?? 'en');
        if (now && normalisePath(now) !== normalisePath(it.legacyPath)) report.pathChanges.push({ externalId: it.externalId, from: it.legacyPath, to: now });
      }
    }

    await this.groups(tx, bundle, state, known);
    // Group membership may have changed versions: pin what the items are now.
    for (const [externalId, w] of state.written) {
      const [row] = await tx.select({ version: items.version }).from(items).where(and(eq(items.siteId, siteId), eq(items.id, w.itemId)));
      if (row) {
        w.version = row.version;
        const ext = state.externalRows.find((r) => r.kind === 'item' && r.externalId === externalId);
        if (ext) ext.targetVersion = row.version;
      }
    }
    report.summary.redirects = bundle.redirects.length + report.pathChanges.length;
    report.summary.batch = [...state.written.values()].filter((w) => w.publish).length;
    return state;
  }

  private async externalIds(tx: Tx, namespace: string) {
    const rows = await tx.select().from(importExternalIds).where(and(eq(importExternalIds.siteId, this.deps.siteId), eq(importExternalIds.namespace, namespace)));
    return new Map(rows.map((r) => [`${r.kind}\u0000${r.externalId}`, r]));
  }

  private systemItems(tx: Tx): ItemService {
    return itemServiceForSystem({ db: tx as unknown as Database, rootDb: this.deps.db, siteId: this.deps.siteId, userId: this.deps.actor.userId, provenance: { authorType: 'integration', sources: [{ type: 'site_import' }] } }, 'site-import');
  }

  private async storeMedia(bundle: LoadedBundle, m: ImportMedia): Promise<string> {
    if (!this.deps.media) throw new SiteImportError('MEDIA_STORE_MISSING', 'This bundle has media but no media storage is configured.', 422);
    const bytes = await bundle.readMedia(m);
    if (sha256(bytes) !== m.sha256) throw new SiteImportError('MEDIA_HASH', `Media "${m.path}" changed since it was checked.`, 409);
    const { url } = await this.deps.media.put({ key: `import/${m.sha256}.${MEDIA_EXT[m.mimeType] ?? 'bin'}`, bytes, mimeType: m.mimeType, sha256: m.sha256 });
    return url;
  }

  /** Taxonomy and author items of the site, by slug and by name. */
  private async termLookup(tx: Tx, colls: Map<string, CollectionInfo>) {
    const out = new Map<string, Map<string, string>>();
    for (const name of ['categories', 'tags', 'authors']) {
      const c = colls.get(name);
      const m = new Map<string, string>();
      if (c) {
        const rows = await tx.select({ id: items.id, data: items.data }).from(items).where(and(eq(items.siteId, this.deps.siteId), eq(items.collectionId, c.id), isNull(items.deletedAt)));
        for (const r of rows) {
          const d = r.data as Record<string, unknown>;
          if (typeof d.slug === 'string') m.set(d.slug.toLowerCase(), r.id);
          if (typeof d.name === 'string') m.set(d.name.toLowerCase(), r.id);
        }
      }
      out.set(name, m);
    }
    return (collection: string, term: string) => out.get(collection)?.get(term.toLowerCase()) ?? out.get(collection)?.get(slugify(term)) ?? null;
  }

  /** The item's field values on this site, and the unsafe markup removed from them. */
  private itemData(
    it: ImportItem,
    coll: CollectionInfo,
    report: ImportReport,
    resolveMedia: (id: string) => string | null,
    term: (collection: string, term: string) => string | null,
    licence: { licence: string; attribution?: string; sourceUrl?: string } | undefined,
  ): { data: Record<string, unknown>; issues: string[] } {
    const data: Record<string, unknown> = {};
    const issues: string[] = [];
    const unconverted = (what: string, detail: string) => report.unconverted.push({ externalId: it.externalId, what, detail });
    for (const [name, value] of Object.entries(it.data)) {
      const iface = coll.fields.get(name);
      if (iface === undefined) {
        unconverted('field', `Field "${name}" is not in "${coll.name}" on this site; left out.`);
        continue;
      }
      if (iface === 'wysiwyg' && typeof value === 'string') {
        const prepared = prepareRichText(value, resolveMedia);
        issues.push(...prepared.issues);
        for (const id of prepared.missingMedia) unconverted('media', `Media "${id}" in "${name}" is not in the bundle.`);
        data[name] = prepared.html;
      } else if (typeof value === 'string') {
        const r = resolveMediaRefs(value, resolveMedia);
        for (const id of r.missing) unconverted('media', `Media "${id}" in "${name}" is not in the bundle.`);
        data[name] = r.text;
      } else {
        data[name] = value;
      }
    }
    const setIf = (name: string, value: unknown) => {
      if (value === undefined) return;
      if (coll.fields.has(name)) data[name] = value;
      else unconverted('field', `Field "${name}" is not in "${coll.name}" on this site; left out.`);
    };
    setIf('locale', it.locale);
    if (it.sponsored !== undefined) setIf('sponsored', it.sponsored);
    if (it.sponsorName !== undefined) setIf('sponsor_name', it.sponsorName);
    const relate = (field: string, collection: string, terms: string[] | undefined, many: boolean) => {
      if (!terms || terms.length === 0) return;
      if (!coll.fields.has(field)) return unconverted('field', `Field "${field}" is not in "${coll.name}" on this site; left out.`);
      const ids: string[] = [];
      for (const t of terms) {
        const id = term(collection, t);
        if (id) ids.push(id);
        else unconverted(collection, `"${t}" is not one of the site's ${collection}; left out.`);
      }
      if (ids.length > 0) data[field] = many ? ids : ids[0];
    };
    relate('categories', 'categories', it.categories, true);
    relate('tags', 'tags', it.tags, true);
    relate('author', 'authors', it.author ? [it.author] : undefined, false);
    if (licence) {
      if (coll.fields.has('source_license')) data.source_license = licence.licence;
      if (licence.attribution && coll.fields.has('source_attribution')) data.source_attribution = licence.attribution;
      if (licence.sourceUrl && coll.fields.has('source_url')) data.source_url = licence.sourceUrl;
    }
    return { data, issues: [...new Set(issues)] };
  }

  /** Unsafe markup and credential-looking fields in an item as it is. */
  private currentIssues(data: Record<string, unknown>, coll: { fields: Map<string, string> }): string[] {
    const out: string[] = [];
    for (const [name, iface] of coll.fields) {
      const v = data[name];
      if (iface === 'wysiwyg' && typeof v === 'string') out.push(...unsafeMarkup(v));
    }
    if (findCredentialFields(data).length > 0) out.push('credential-looking field');
    return [...new Set(out)];
  }

  private async pathOf(tx: Tx, itemId: string): Promise<string | null> {
    const [r] = await tx.select({ path: contentRoutes.path }).from(contentRoutes).where(and(eq(contentRoutes.siteId, this.deps.siteId), eq(contentRoutes.itemId, itemId)));
    return r?.path ?? null;
  }

  /** The item's public path: language prefix, route path, trailing slash as the site has them. */
  private async publicPathOf(tx: Tx, itemId: string, settings: typeof siteContentSettings.$inferSelect | undefined, defaultLanguage: string): Promise<string | null> {
    const [r] = await tx.select({ path: contentRoutes.path, locale: contentRoutes.locale }).from(contentRoutes).where(and(eq(contentRoutes.siteId, this.deps.siteId), eq(contentRoutes.itemId, itemId)));
    if (!r) return null;
    return publicPath(r.path, r.locale, settings, defaultLanguage);
  }

  /** Translation groups: by key, explicit records first; the source is named, or the member in the default language. */
  private async groups(tx: Tx, bundle: LoadedBundle, state: RunState, known: Map<string, typeof importExternalIds.$inferSelect>): Promise<void> {
    const byKey = new Map<string, { members: string[]; source?: string }>();
    for (const g of bundle.groups) byKey.set(g.key, { members: [...g.members], source: g.source });
    for (const it of bundle.items) {
      if (!it.translationKey) continue;
      const g = byKey.get(it.translationKey) ?? { members: [] };
      if (!g.members.includes(it.externalId)) g.members.push(it.externalId);
      byKey.set(it.translationKey, g);
    }
    const defaultLocale = bundle.site?.settings.defaultLocale;
    const itemsById = new Map(bundle.items.map((i) => [i.externalId, i]));
    const groupsOn = (db: Tx) => new TranslationGroupService({
      db: db as unknown as Database,
      siteId: this.deps.siteId,
      actor: this.deps.actor.userId ? { type: 'user', id: this.deps.actor.userId } : undefined,
      userId: this.deps.actor.userId,
      itemsOn: (site, inner) => (site === this.deps.siteId ? this.systemItems(inner) : null),
    });
    const idOf = async (externalId: string): Promise<string | null> => {
      const w = state.written.get(externalId);
      if (w) return w.itemId;
      const prior = known.get(`item\u0000${externalId}`);
      return prior?.targetId ?? null;
    };
    for (const [key, g] of byKey) {
      const source = g.source ?? g.members.find((m) => itemsById.get(m)?.locale === defaultLocale) ?? g.members[0]!;
      const sourceId = await idOf(source);
      if (!sourceId) continue;
      try {
        await tx.transaction(async (sp) => {
          const svc = groupsOn(sp as unknown as Tx);
          const [membership] = await sp.select({ groupId: translationGroupMembers.groupId }).from(translationGroupMembers).where(eq(translationGroupMembers.itemId, sourceId));
          let view = membership ? await svc.get(membership.groupId) : await svc.create(sourceId);
          if (!membership) {
            state.report.summary.groups++;
            state.externalRows.push({ siteId: this.deps.siteId, namespace: bundle.namespace, kind: 'group', externalId: key, targetId: view.id, recordHash: sha256(canonicalJson(g)) });
          }
          for (const m of g.members) {
            if (m === source) continue;
            const id = await idOf(m);
            if (!id || view.members.some((x) => x.itemId === id)) continue;
            view = await svc.addMember(view.id, { itemId: id, expectedVersion: view.version });
          }
          if (itemsById.get(source)?.internalOnly && !view.members.find((x) => x.itemId === sourceId)?.internalOnly) {
            view = await svc.setInternalOnly(view.id, sourceId, true, view.version);
          }
        });
      } catch (err) {
        state.report.unconverted.push({ what: 'translation group', detail: `Group "${key}": ${errorText(err)}` });
      }
    }
  }

  // ------------------------------------------------------------------ activation

  /**
   * Activate an imported batch: everything re-checked in one transaction, then published together as `publisher`
   * (the activating person's own ItemService on the transaction, permissions enforced) — or nothing, with the reasons.
   */
  async activate(batchId: string, publisher: (tx: Tx) => ItemService): Promise<ActivationResult> {
    const siteId = this.deps.siteId;
    const afterCommit: Array<() => Promise<void>> = [];
    let result: ActivationResult;
    try {
      result = await runSiteTransaction(
        this.deps.db,
        siteId,
        async (tx) => {
          const [batch] = await tx.select().from(importBatches).where(and(eq(importBatches.siteId, siteId), eq(importBatches.id, batchId))).for('update');
          if (!batch) throw new SiteImportError('NOT_FOUND', 'No such import batch.', 404);
          if (batch.status !== 'imported') throw new SiteImportError('BATCH_NOT_IMPORTED', `The batch is ${batch.status}.`, 409);
          const members = await tx.select().from(importBatchItems).where(and(eq(importBatchItems.siteId, siteId), eq(importBatchItems.batchId, batchId)));
          const out: ActivationResult = { activated: false, items: members.length, blocked: [], seo: [] };
          const block = (m: (typeof members)[number], code: string, message: string) => out.blocked.push({ itemId: m.itemId, externalId: m.externalId, code, message });
          const colls = new Map<string, Map<string, string>>();
          for (const f of await tx
            .select({ collection: collections.name, name: fields.name, interface: fields.interface })
            .from(fields)
            .innerJoin(collections, eq(collections.id, fields.collectionId))
            .where(eq(fields.siteId, siteId))) {
            const m = colls.get(f.collection) ?? new Map<string, string>();
            m.set(f.name, f.interface);
            colls.set(f.collection, m);
          }
          const ids = members.map((m) => m.itemId);
          const rows = ids.length
            ? await tx.select().from(items).where(and(eq(items.siteId, siteId), inArray(items.id, ids))).orderBy(items.id).for('update')
            : [];
          const internal = ids.length
            ? new Set((await tx.select({ itemId: translationGroupMembers.itemId }).from(translationGroupMembers).where(and(inArray(translationGroupMembers.itemId, ids), eq(translationGroupMembers.internalOnly, true)))).map((r) => r.itemId))
            : new Set<string>();
          const byId = new Map(rows.map((r) => [r.id, r]));
          for (const m of members) {
            const row = byId.get(m.itemId);
            if (!row || row.deletedAt) {
              block(m, 'ITEM_DELETED', 'The item was deleted.');
              continue;
            }
            if (row.version !== m.pinnedVersion) block(m, 'CHANGED_SINCE_DRY_RUN', 'The item changed after the import: run the dry run and import again.');
            if (row.hold) block(m, 'ITEM_HELD', 'The item is on hold.');
            if (m.internalOnly || internal.has(m.itemId)) block(m, 'INTERNAL_ONLY', 'The item is internal only and is never published.');
            const fieldsOf = colls.get(m.collection) ?? new Map<string, string>();
            const issues = [...new Set([...(m.safetyIssues ?? []), ...this.currentIssues(row.data as Record<string, unknown>, { fields: fieldsOf })])];
            if (issues.length > 0) block(m, 'SAFETY_CHECK_FAILED', `Unsafe content: ${issues.join(', ')}.`);
            const d = row.data as Record<string, unknown>;
            if (!d.title) out.seo.push({ itemId: m.itemId, externalId: m.externalId, message: 'No title.' });
            if (!d.seo_description && !d.excerpt) out.seo.push({ itemId: m.itemId, externalId: m.externalId, message: 'No description (SEO description or excerpt).' });
          }
          // Publish each with the activating person's permissions; a refusal blocks the batch (all of it is undone).
          if (out.blocked.length === 0) {
            const svc = publisher(tx);
            for (const m of members) {
              const row = byId.get(m.itemId)!;
              if (row.status === 'published') continue;
              try {
                await tx.transaction(async () => {
                  await svc.patchInTransaction(m.collection, m.itemId, { status: 'published', expectedVersion: row.version }, afterCommit);
                });
              } catch (err) {
                const code = (err as { code?: string }).code ?? 'PUBLISH_FAILED';
                block(m, code === 'FORBIDDEN' || code === 'PERMISSION_DENIED' ? 'NO_PUBLISH_PERMISSION' : code, errorText(err));
              }
            }
          }
          if (out.blocked.length > 0) throw new ActivationBlocked(out);

          // Redirects: the bundle's, and the old paths that changed.
          const report = batch.report as unknown as ImportReport;
          const rules = [...(report.redirects ?? []), ...(report.pathChanges ?? []).map((p) => ({ from: p.from, to: p.to }))];
          if (rules.length > 0) {
            const csv = rules.map((r) => `${csvCell(r.from)},${csvCell(r.to)}`).join('\n');
            const r = await importRedirectsInTransaction(tx, this.deps.db, siteId, csv, { format: 'csv', actor: this.deps.actor });
            out.redirects = r.report.summary.import + r.report.summary.replaced;
          }
          await tx.update(importBatchItems).set({ activatedAt: new Date() }).where(and(eq(importBatchItems.siteId, siteId), eq(importBatchItems.batchId, batchId)));
          await tx
            .update(importBatches)
            .set({ status: 'activated', activatedBy: this.deps.actor.userId, activatedAt: new Date(), activationReport: out as unknown as Record<string, unknown> })
            .where(eq(importBatches.id, batchId));
          await new AuditLogger({ db: this.deps.db, siteId }).writeInTransaction(tx, {
            siteId,
            event: 'site_import_activated',
            actorEmail: this.deps.actor.email ?? null,
            metadata: { operator: this.deps.actor.userId, batchId, items: members.length, redirects: out.redirects ?? 0, seoNotes: out.seo.length },
          });
          out.activated = true;
          return out;
        },
        { retry: false },
      );
    } catch (err) {
      if (!(err instanceof ActivationBlocked)) throw err;
      result = err.result;
      await runSiteTransaction(this.deps.db, siteId, (tx) =>
        tx.update(importBatches).set({ activationReport: result as unknown as Record<string, unknown> }).where(and(eq(importBatches.siteId, siteId), eq(importBatches.id, batchId))),
      );
      return result;
    }
    for (const work of afterCommit) await work().catch(() => undefined);
    return result;
  }

  /** The batches of the site, newest first. */
  async list(limit = 50) {
    return runSiteTransaction(this.deps.db, this.deps.siteId, (tx) =>
      tx
        .select({ id: importBatches.id, namespace: importBatches.namespace, status: importBatches.status, createdAt: importBatches.createdAt, activatedAt: importBatches.activatedAt })
        .from(importBatches)
        .where(eq(importBatches.siteId, this.deps.siteId))
        .orderBy(desc(importBatches.createdAt))
        .limit(limit),
    );
  }

  /** Whether an item came in through an import (its "historical import" marking), and from which batch. */
  async historicalImport(itemId: string): Promise<{ batchId: string; externalId: string; activatedAt: Date | null } | null> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      const [row] = await tx
        .select({ batchId: importBatchItems.batchId, externalId: importBatchItems.externalId, activatedAt: importBatchItems.activatedAt })
        .from(importBatchItems)
        .where(and(eq(importBatchItems.siteId, this.deps.siteId), eq(importBatchItems.itemId, itemId)))
        .orderBy(desc(importBatchItems.activatedAt))
        .limit(1);
      return row ?? null;
    });
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function csvCell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A path compared without its trailing slash. */
function normalisePath(p: string): string {
  const path = p.split(/[?#]/)[0] ?? p;
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** The public form of an internal route path (language prefix, trailing slash). */
function publicPath(
  path: string,
  locale: string,
  settings: Pick<typeof siteContentSettings.$inferSelect, 'localePrefixes' | 'localePrefixMode' | 'trailingSlash' | 'localeStrategy'> | undefined,
  defaultLanguage: string,
): string {
  let prefix = '';
  if (!settings || settings.localeStrategy === 'subdirectory') {
    const isDefault = locale.toLowerCase() === defaultLanguage.toLowerCase();
    if (!isDefault || settings?.localePrefixMode === 'all_prefixed') prefix = `/${settings?.localePrefixes?.[locale] ?? locale.toLowerCase()}`;
  }
  const joined = `${prefix}${path === '/' ? '' : path}` || '/';
  if (joined === '/') return '/';
  return settings?.trailingSlash === 'never' ? joined : `${joined}/`;
}

/**
 * Imported media into the site's media storage (its bound storage profile, or the instance default), recorded like an
 * upload. The storage must have a public base URL — rich text links to the file there, as the editor's uploads do.
 */
export function storageMediaStore(storage: {
  writeLocation(key: string): Promise<{ storage: { put(key: string, data: Buffer, metadata?: Record<string, string>): Promise<void> }; objectKey: string; publicBaseUrl: string | null; profileId: string | null; driver: 'local' | 's3' | null }>;
  recordWrite(key: string, at: never, meta: { contentType: string; size: number }): Promise<void>;
}): ImportMediaStore {
  return {
    async put({ key, bytes, mimeType, sha256: hash }) {
      const at = await storage.writeLocation(key);
      if (!at.publicBaseUrl) throw new SiteImportError('MEDIA_NOT_PUBLIC', 'The site\'s media storage has no public base URL: imported images could not be shown. Bind a storage profile with one.', 422);
      await at.storage.put(at.objectKey, bytes, { contentType: mimeType, sha256: hash });
      await storage.recordWrite(key, at as never, { contentType: mimeType, size: bytes.length });
      return { url: `${at.publicBaseUrl}/${at.objectKey}` };
    },
  };
}
