import { and, asc, desc, eq, getTableColumns, gt, gte, inArray, lte, notInArray, or, sql, type SQL } from 'drizzle-orm';
import {
  BACKGROUND_REFRESH_REASONS,
  projectionRebuilds,
  publicAlternates,
  publicHosts,
  publicItems,
  publicSites,
  renderRedirects,
  renderRootFiles,
  renderThemeAssets,
  renderThemes,
  routeTombstones,
  siteRenderVersions,
  type Database,
} from '@heopress/database';
import { effectiveSeoSettings, effectiveSiteIdentity, type SiteIdentity, type SiteSeoSettings } from '@heopress/contracts/schemas';
import { materializedNodes, type MaterializedNode } from '@heopress/seo-geo';
import { readStored, type CachedPage } from './cache';
import type { CrawlHit } from './ai-traffic';
import { spaceOf, type PublicReadPort, type SiteReader, type SpaceSettings, type ThemeAsset } from '@heopress/public-site';

/**
 * The rendering service's reads (HeoPress P06 tasks 1.1–1.3; design R1, R20): the public projection and
 * the redirects view, nothing else — the rendering role cannot read anything else. Every site read runs
 * in one transaction with `app.site_id` set, so the optional row-level security policies (and the
 * redirects view's own filter) keep it to that site.
 */

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

export type PublicItemRow = typeof publicItems.$inferSelect;

/** One site's reads in its scope: the resolver's `SiteReader` and the pages' data. */
export interface SiteReads extends SiteReader {
  /**
   * The site's public row: content settings and (P07 task 1.4) the public part of its SEO / GEO settings,
   * with the defaults of what the snapshot lacks (a snapshot from before P07 is empty); its identity (task 2.12), null when none is set;
   * the site nodes its extensions contribute to the structured data (task 2.9).
   */
  site(): Promise<{
    name: string;
    defaultLanguage: string;
    settings: Record<string, unknown>;
    seo: SiteSeoSettings;
    identity: SiteIdentity | null;
    contributed: MaterializedNode[];
  } | null>;
  /** Whether the site waits for a projection rebuild (its pages are not served meanwhile). */
  rebuilding(): Promise<boolean>;
  item(itemId: string): Promise<PublicItemRow | null>;
  alternates(itemId: string): Promise<Array<{ locale: string; url: string }>>;
  /** Articles of a language, newest first; `term` keeps those naming the item as a category, tag or author. */
  articles(locale: string, opts: { term?: { collection: string; itemId: string }; offset: number; limit: number }): Promise<PublicItemRow[]>;
  /** The site's active theme version (null: the built-in theme). */
  theme(): Promise<{ versionId: string; templates: Record<string, string>; assets: ThemeAsset[] } | null>;
  /** An asset of one of the site's published theme versions, by digest and extension (the URL's). */
  asset(versionId: string, sha256: string, ext: string): Promise<{ contentType: string; bytes: Buffer } | null>;
  /** The site's render version (raised with every change of its public output). */
  renderVersion(): Promise<number>;
  /** A stored rendered answer (page cache, level 2). */
  stored(key: string): Promise<CachedPage | null>;
  /** The site's own hosts (links elsewhere are external). */
  hosts(): Promise<string[]>;
  /** The site's primary host, if it has one. */
  primaryHost(): Promise<string | null>;
  /** Articles of a language whose title contains `q` (case-insensitive). */
  search(locale: string, q: string, opts: { offset: number; limit: number }): Promise<PublicItemRow[]>;
  /**
   * Every public item of the site for the sitemaps (P07 task 3.1), by language and path: the rows without their rich
   * text (the sitemap needs none of it; `richFields` lists what was left out).
   */
  sitemapItems(): Promise<PublicItemRow[]>;
  /** The collections the site has public items in (P07 task 4.1): one probe of the collection index per collection. */
  publicCollections(): Promise<string[]>;
  /**
   * Candidates for `llms.txt` (P07 task 4.1), in one statement (Codex review of batch 9, round 7): the newest `limit` items
   * across `streams` — each a collection, of one language or of every language (`locale` null; the streams are all one or
   * the other), past its first `skip` items — newest first (undated first), ties by id in code-point order (`COLLATE "C"`),
   * then by stream; `stream` is the row's stream (its index). Each stream's keys are read backwards from its recency index
   * alone, at most `perStream`; the database merges the keys; the whole rows (without the body only: a description may be
   * rich text) are read for the `limit` chosen.
   */
  llmsNewest(opts: { streams: Array<{ collection: string; locale: string | null; skip: number; listable: Listable }>; perStream: number; limit: number }): Promise<Array<PublicItemRow & { stream: number }>>;
  /** Every language alternate of the site's items, by item (the sitemaps' `xhtml:link`). */
  allAlternates(): Promise<Map<string, Array<{ locale: string; url: string }>>>;
  /** A root file of the site, by its exact name (P07 task 3.8). */
  rootFile(filename: string): Promise<{ contentType: string; content: string } | null>;
  /** The names of the site's root files (P11 task 3.1: a static build writes each). */
  rootFileNames(): Promise<string[]>;
  /**
   * The addresses that may answer without a page (P11 task 4.4: the static response contract): the redirect rules' source
   * paths (`url` scope: a URL path; `content` scope: a language's content path) and the withdrawn items' paths.
   */
  routeCandidates(): Promise<{ urlPaths: string[]; content: Array<{ locale: string; path: string }> }>;
  /** How many public items the site has (an upper bound of its sitemap entries). */
  publicItemCount(): Promise<number>;
  /**
   * The newest items of a collection in a language (the feeds, P07 task 3.3), a page at a time, without their rich text —
   * only those whose own setting can let them be indexed (`listable`; the page's own decision is still made on each).
   */
  latest(locale: string, collection: string, opts: { offset: number; limit: number; listable: Listable }): Promise<PublicItemRow[]>;
  /** Items of the site, whole, in the order of `itemIds` (those still public). */
  itemsByIds(itemIds: string[]): Promise<PublicItemRow[]>;
  /**
   * Articles on `host` first published in `[since, until]`, newest first, a page at a time, without their rich text (the
   * news sitemap's window, P07 task 3.7); only those whose own setting can let them be indexed.
   */
  articlesBetween(since: Date, until: Date, opts: { host: string; offset: number; limit: number; listable: Listable }): Promise<PublicItemRow[]>;
  /** When the next article on `host` is first published after `after` (one still ahead of this clock), if any. */
  nextPublication(after: Date, opts: { host: string; listable: Listable }): Promise<Date | null>;
}

export interface RenderPort {
  /** An active host (read before the site is known: the hosts table is not site-scoped). */
  host: PublicReadPort['host'];
  /**
   * One request's reads of one site: a read-only, repeatable-read transaction with `app.site_id` set — the
   * rebuild check, the path resolution and the page data all see the same snapshot. `port` is the
   * resolver's view of it (only this site).
   */
  request<T>(siteId: string, fn: (port: PublicReadPort, reads: SiteReads) => Promise<T>): Promise<T>;
  /**
   * An AI traffic hit (P07 tasks 6.1, 6.4), through the database's checked entry (the role's only write), in a short
   * transaction of its own — never in a request's read-only snapshot.
   */
  recordCrawlHit(hit: CrawlHit): Promise<void>;
}

/** The article field naming a term of each collection. */
const TERM_FIELDS: Record<string, { list?: string; single?: string }> = {
  categories: { list: 'categories', single: 'primary_category' },
  tags: { list: 'tags' },
  authors: { single: 'author' },
};

/**
 * Which items' own setting (`seo_robots`, `@heopress/seo-geo` `parseItemRobots`) can let them be indexed, for a
 * collection whose default is `defaultIndexable`: when it is, those not saying `noindex`; when it is not, those whose
 * setting is an own `index` — not the preset's `index,follow`, which sets nothing (Codex review of batch 12: every page
 * created with the preset's value would otherwise be read, and a bounded scan could stop before the one page indexed on
 * its own). Read in the database as `parseItemRobots` reads it (`lumibase_robots_noindex`, `lumibase_robots_own_index`,
 * migration 0090); the own-`index` rows have their own index (migration 0091).
 */
export interface Listable {
  defaultIndexable: boolean;
}

function listableCondition(l: Listable, robots: SQL = sql`${publicItems.seoRobots}`) {
  return l.defaultIndexable ? sql`NOT public.lumibase_robots_noindex(${robots})` : sql`public.lumibase_robots_own_index(${robots})`;
}

/** Items whose public address is on `host` (`https://<host>/…`). */
function onHost(host: string) {
  const prefix = `https://${host.toLowerCase()}/`;
  return sql`lower(${publicItems.card} ->> 'url') LIKE ${`${prefix.replace(/[\\%_]/g, (m) => `\\${m}`)}%`}`;
}

function termCondition(term: { collection: string; itemId: string }) {
  const f = TERM_FIELDS[term.collection];
  if (!f) return sql`false`;
  const parts = [];
  if (f.list) parts.push(sql`${publicItems.data} -> ${f.list} @> ${JSON.stringify([term.itemId])}::jsonb`);
  if (f.single) parts.push(sql`${publicItems.data} ->> ${f.single} = ${term.itemId}`);
  return or(...parts)!;
}

function reads(tx: Tx, siteId: string, now: () => number = Date.now): SiteReads {
  const articlesOf = (locale: string) => and(eq(publicItems.siteId, siteId), eq(publicItems.collection, 'articles'), eq(publicItems.locale, locale));
  return {
    space: async (primaryHost) => {
      const [site] = await tx.select().from(publicSites).where(eq(publicSites.siteId, siteId));
      const domains = await tx
        .select({ hostname: publicHosts.hostname, locale: publicHosts.entryLocale, isPrimary: publicHosts.isPrimary })
        .from(publicHosts)
        .where(eq(publicHosts.siteId, siteId));
      return spaceOf(siteId, site?.defaultLanguage ?? 'en', (site?.settings ?? {}) as SpaceSettings, domains, primaryHost);
    },
    ruleStats: async () => {
      const [row] = (await tx.execute(sql`
        SELECT count(*)::int AS n, coalesce(max(cardinality(string_to_array(trim(both '/' from to_path), '/'))), 0)::int AS m
        FROM ${renderRedirects} WHERE site_id = ${siteId}`)) as unknown as Array<{ n: number; m: number }>;
      return { ruleCount: row?.n ?? 0, maxTarget: row?.m ?? 0 };
    },
    redirectsFrom: (urlPaths, content) => {
      const urlScope = and(eq(renderRedirects.scope, 'url'), inArray(renderRedirects.fromPath, urlPaths));
      const contentScope = content
        ? and(eq(renderRedirects.scope, 'content'), eq(renderRedirects.locale, content.locale), inArray(renderRedirects.fromPath, content.paths))
        : undefined;
      return tx
        .select()
        .from(renderRedirects)
        .where(and(eq(renderRedirects.siteId, siteId), contentScope ? or(urlScope, contentScope) : urlScope));
    },
    liveItemAt: async (locale, contentPath) => {
      const [row] = await tx
        .select({ itemId: publicItems.itemId, locale: publicItems.locale, collection: publicItems.collection })
        .from(publicItems)
        .where(and(eq(publicItems.siteId, siteId), eq(publicItems.locale, locale), eq(publicItems.path, contentPath)));
      return row ?? null;
    },
    goneAt: async (locale, contentPath) => {
      const [row] = await tx
        .select({ itemId: routeTombstones.itemId })
        .from(routeTombstones)
        .where(and(eq(routeTombstones.siteId, siteId), eq(routeTombstones.locale, locale), eq(routeTombstones.path, contentPath)));
      return !!row;
    },
    site: async () => {
      const [row] = await tx.select().from(publicSites).where(eq(publicSites.siteId, siteId));
      return row
        ? {
            name: row.name,
            defaultLanguage: row.defaultLanguage,
            settings: row.settings,
            seo: effectiveSeoSettings(row.seo),
            identity: effectiveSiteIdentity(row.identity),
            contributed: materializedNodes((row.structured as { nodes?: unknown } | null)?.nodes),
          }
        : null;
    },
    rebuilding: async () => {
      // A background refresh (P07: one of the exact known reasons) leaves the projection consistent meanwhile: no maintenance for it.
      const [mark] = await tx
        .select({ seq: projectionRebuilds.seq })
        .from(projectionRebuilds)
        .where(and(eq(projectionRebuilds.siteId, siteId), notInArray(projectionRebuilds.reason, [...BACKGROUND_REFRESH_REASONS])))
        .limit(1);
      if (mark) return true;
      const [site] = await tx.select({ builtAt: publicSites.builtAt }).from(publicSites).where(eq(publicSites.siteId, siteId));
      return !site?.builtAt;
    },
    theme: async () => {
      const [row] = await tx.select().from(renderThemes).where(eq(renderThemes.siteId, siteId));
      return row ? { versionId: row.versionId, templates: row.templates, assets: row.assets } : null;
    },
    asset: async (versionId, sha256, ext) => {
      // Same bytes under two names (a.css, b.js) are two assets: the extension picks the one the URL names.
      const [row] = await tx
        .select({ contentType: renderThemeAssets.contentType, bytes: renderThemeAssets.bytes })
        .from(renderThemeAssets)
        .where(and(eq(renderThemeAssets.versionId, versionId), eq(renderThemeAssets.sha256, sha256), sql`${renderThemeAssets.path} LIKE ${`%.${ext}`}`))
        .orderBy(renderThemeAssets.path)
        .limit(1);
      return row ?? null;
    },
    renderVersion: async () => {
      const [row] = await tx.select({ v: siteRenderVersions.version }).from(siteRenderVersions).where(eq(siteRenderVersions.siteId, siteId));
      return row?.v ?? 0;
    },
    stored: (key) => readStored(tx, key, siteId, new Date(now())),
    hosts: async () => (await tx.select({ h: publicHosts.hostname }).from(publicHosts).where(eq(publicHosts.siteId, siteId))).map((r) => r.h),
    primaryHost: async () => {
      const [row] = await tx.select({ h: publicHosts.hostname }).from(publicHosts).where(and(eq(publicHosts.siteId, siteId), eq(publicHosts.isPrimary, true))).limit(1);
      return row?.h ?? null;
    },
    item: async (itemId) => {
      const [row] = await tx.select().from(publicItems).where(and(eq(publicItems.siteId, siteId), eq(publicItems.itemId, itemId)));
      return row ?? null;
    },
    alternates: (itemId) =>
      tx
        .select({ locale: publicAlternates.locale, url: publicAlternates.url })
        .from(publicAlternates)
        .where(and(eq(publicAlternates.siteId, siteId), eq(publicAlternates.itemId, itemId)))
        .orderBy(asc(publicAlternates.locale)),
    articles: (locale, opts) =>
      tx
        .select()
        .from(publicItems)
        .where(opts.term ? and(articlesOf(locale), termCondition(opts.term)) : articlesOf(locale))
        .orderBy(sql`${publicItems.publishedAt} DESC NULLS LAST`, desc(publicItems.itemId))
        .offset(opts.offset)
        .limit(opts.limit),
    sitemapItems: () =>
      tx
        .select({ ...getTableColumns(publicItems), data: sql<Record<string, unknown>>`${publicItems.data} - ${publicItems.richFields}` })
        .from(publicItems)
        .where(eq(publicItems.siteId, siteId))
        .orderBy(asc(publicItems.locale), asc(publicItems.path), asc(publicItems.itemId)),
    publicCollections: async () => {
      // A skip over the index: the next collection after the last one found, until none (never a scan of the items).
      const rows = (await tx.execute(sql`
        WITH RECURSIVE c(collection) AS (
          (SELECT ${publicItems.collection} FROM ${publicItems} WHERE ${publicItems.siteId} = ${siteId} ORDER BY ${publicItems.collection} LIMIT 1)
          UNION ALL
          SELECT (SELECT p.collection FROM ${publicItems} p WHERE p.site_id = ${siteId} AND p.collection > c.collection ORDER BY p.collection LIMIT 1)
          FROM c WHERE c.collection IS NOT NULL
        )
        SELECT collection FROM c WHERE collection IS NOT NULL`)) as unknown as Array<{ collection: string }>;
      return rows.map((r) => r.collection);
    },
    llmsNewest: async (opts) => {
      if (opts.streams.length === 0 || opts.limit <= 0) return [];
      const list = <T>(values: T[], type: string) => sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::${sql.raw(type)}`;
      const byLocale = opts.streams[0]!.locale !== null;
      // The merge over keys only (Codex review of batch 9, round 8): each stream's next keys from its index, the newest
      // `limit` of them; the whole rows are read for those only. Only rows the stream can list (Codex review of batch 12):
      // of a collection indexed by default, those not saying `noindex`; of one that is not, those indexed by their own
      // setting, from their own index (migration 0091) — never a scan past the others.
      const stream = (own: boolean) => sql`
          SELECT i.published_at, i.item_id
          FROM ${publicItems} i
          WHERE i.site_id = ${siteId} AND i.collection = s.collection ${byLocale ? sql`AND i.locale = s.locale` : sql``}
            AND ${own ? sql`NOT s.def AND ${listableCondition({ defaultIndexable: false }, sql`i.seo_robots`)}` : sql`s.def AND ${listableCondition({ defaultIndexable: true }, sql`i.seo_robots`)}`}
          ORDER BY i.published_at DESC NULLS FIRST, i.item_id COLLATE "C" DESC
          OFFSET s.skip LIMIT ${opts.perStream}`;
      const keys = (await tx.execute(sql`
        SELECT k.item_id AS "itemId", s.ord - 1 AS stream
        FROM unnest(${list(opts.streams.map((x) => x.collection), 'text[]')}, ${list(opts.streams.map((x) => x.locale ?? ''), 'text[]')},
                    ${list(opts.streams.map((x) => x.skip), 'int[]')}, ${list(opts.streams.map((x) => x.listable.defaultIndexable), 'boolean[]')})
             WITH ORDINALITY AS s(collection, locale, skip, def, ord)
        CROSS JOIN LATERAL ((${stream(false)}) UNION ALL (${stream(true)})) k
        ORDER BY k.published_at DESC NULLS FIRST, k.item_id COLLATE "C" DESC, s.ord
        LIMIT ${opts.limit}`)) as unknown as Array<{ itemId: string; stream: number }>;
      if (keys.length === 0) return [];
      const rows = await tx
        .select({ ...getTableColumns(publicItems), data: sql<Record<string, unknown>>`${publicItems.data} - 'body'` })
        .from(publicItems)
        .where(and(eq(publicItems.siteId, siteId), inArray(publicItems.itemId, keys.map((k) => k.itemId))));
      const byId = new Map(rows.map((r) => [r.itemId, r]));
      return keys.flatMap((k) => {
        const row = byId.get(k.itemId);
        return row ? [{ ...row, stream: Number(k.stream) }] : [];
      });
    },
    allAlternates: async () => {
      const rows = await tx
        .select({ itemId: publicAlternates.itemId, locale: publicAlternates.locale, url: publicAlternates.url })
        .from(publicAlternates)
        .where(eq(publicAlternates.siteId, siteId))
        .orderBy(asc(publicAlternates.itemId), asc(publicAlternates.locale));
      const out = new Map<string, Array<{ locale: string; url: string }>>();
      for (const r of rows) out.set(r.itemId, [...(out.get(r.itemId) ?? []), { locale: r.locale, url: r.url }]);
      return out;
    },
    rootFile: async (filename) => {
      const [row] = await tx
        .select({ contentType: renderRootFiles.contentType, content: renderRootFiles.content })
        .from(renderRootFiles)
        .where(and(eq(renderRootFiles.siteId, siteId), eq(renderRootFiles.filename, filename)));
      return row ?? null;
    },
    rootFileNames: async () =>
      (
        await tx.select({ filename: renderRootFiles.filename }).from(renderRootFiles).where(eq(renderRootFiles.siteId, siteId)).orderBy(asc(renderRootFiles.filename))
      ).map((r) => r.filename),
    routeCandidates: async () => {
      const rules = await tx
        .select({ scope: renderRedirects.scope, locale: renderRedirects.locale, fromPath: renderRedirects.fromPath })
        .from(renderRedirects)
        .where(eq(renderRedirects.siteId, siteId))
        .limit(5000);
      const gone = await tx
        .select({ locale: routeTombstones.locale, path: routeTombstones.path })
        .from(routeTombstones)
        .where(eq(routeTombstones.siteId, siteId))
        .limit(5000);
      return {
        urlPaths: rules.filter((r) => r.scope === 'url').map((r) => r.fromPath),
        content: [...rules.filter((r) => r.scope === 'content' && r.locale).map((r) => ({ locale: r.locale!, path: r.fromPath })), ...gone],
      };
    },
    publicItemCount: async () => {
      const [row] = await tx.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(publicItems).where(eq(publicItems.siteId, siteId));
      return row?.n ?? 0;
    },
    latest: (locale, collection, opts) =>
      tx
        .select({ ...getTableColumns(publicItems), data: sql<Record<string, unknown>>`${publicItems.data} - ${publicItems.richFields}` })
        .from(publicItems)
        .where(and(eq(publicItems.siteId, siteId), eq(publicItems.collection, collection), eq(publicItems.locale, locale), listableCondition(opts.listable)))
        .orderBy(sql`${publicItems.publishedAt} DESC NULLS LAST`, desc(publicItems.itemId))
        .offset(opts.offset)
        .limit(opts.limit),
    itemsByIds: async (itemIds) => {
      if (itemIds.length === 0) return [];
      const rows = await tx.select().from(publicItems).where(and(eq(publicItems.siteId, siteId), inArray(publicItems.itemId, itemIds)));
      const byId = new Map(rows.map((r) => [r.itemId, r]));
      return itemIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    },
    articlesBetween: (since, until, opts) =>
      tx
        .select({ ...getTableColumns(publicItems), data: sql<Record<string, unknown>>`${publicItems.data} - ${publicItems.richFields}` })
        .from(publicItems)
        .where(
          and(
            eq(publicItems.siteId, siteId),
            eq(publicItems.collection, 'articles'),
            gte(publicItems.publishedAt, since),
            lte(publicItems.publishedAt, until),
            onHost(opts.host),
            listableCondition(opts.listable),
          ),
        )
        .orderBy(desc(publicItems.publishedAt), desc(publicItems.itemId))
        .offset(opts.offset)
        .limit(opts.limit),
    nextPublication: async (after, opts) => {
      const [row] = await tx
        .select({ at: sql<Date | null>`min(${publicItems.publishedAt})`.mapWith((v: unknown) => (v ? new Date(v as string) : null)) })
        .from(publicItems)
        .where(and(eq(publicItems.siteId, siteId), eq(publicItems.collection, 'articles'), gt(publicItems.publishedAt, after), onHost(opts.host), listableCondition(opts.listable)));
      return row?.at ?? null;
    },
    search: (locale, q, opts) => {
      const pattern = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      return tx
        .select()
        .from(publicItems)
        .where(and(articlesOf(locale), sql`${publicItems.data} ->> 'title' ILIKE ${pattern}`))
        .orderBy(sql`${publicItems.publishedAt} DESC NULLS LAST`, desc(publicItems.itemId))
        .offset(opts.offset)
        .limit(opts.limit);
    },
  };
}

async function hostRow(db: Database | Tx, hostname: string) {
  const [row] = await db.select().from(publicHosts).where(eq(publicHosts.hostname, hostname));
  return row ? { siteId: row.siteId, hostname: row.hostname, isPrimary: row.isPrimary, entryLocale: row.entryLocale, primaryHostname: row.primaryHostname } : null;
}

/** `now`: the clock (tests set it; expired shared entries are misses by it). */
export function renderPort(db: Database, now: () => number = Date.now): RenderPort {
  return {
    host: (hostname) => hostRow(db, hostname),
    recordCrawlHit: async (h) => {
      // Bounded: a write that waits on a lock or a slow database gives up (the hit is dropped, the answer long gone).
      await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL statement_timeout = 2000`);
        await tx.execute(sql`SET LOCAL lock_timeout = 1000`);
        await tx.execute(
          sql`SELECT public.lumibase_record_crawl_hit(${h.host}, ${h.kind}, ${h.agent}, ${h.operator}, ${h.purpose}, ${h.resource}, ${h.path}, ${h.ipHash}, ${h.status})`,
        );
      });
    },
    request: (siteId, fn) =>
      db.transaction(
        async (tx) => {
          await tx.execute(sql`SELECT set_config('app.site_id', ${siteId}, true)`);
          const r = reads(tx, siteId, now);
          const port: PublicReadPort = {
            host: (hostname) => hostRow(tx, hostname),
            inSite: (id, f) => (id === siteId ? f(r) : Promise.reject(new Error('site-classic: one site per request'))),
          };
          return fn(port, r);
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      ),
  };
}
