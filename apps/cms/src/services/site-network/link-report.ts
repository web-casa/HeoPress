import { and, eq, inArray, sql } from 'drizzle-orm';
import { linkEdges, linkScans, publicItems, publicPathMemory, routeTombstones, type Database } from '@heopress/database';
import { TAXONOMY_COLLECTIONS } from '@heopress/seo-geo';
import { runSiteTransaction } from '../rls-transaction';
import { resolvePublicPath, type PublicPathResult } from './public-path';
import type { ReadableScope } from './readable-items';

/**
 * Broken links and orphan content (HeoPress P07 task 5.4; spec seo/link-graph "失效链接与孤立内容报告"), from the link graph
 * (`link-graph.ts`) and what the site serves now:
 *
 *   - a link whose target is a public item at that address is fine; otherwise its address is resolved as a request would be
 *     (redirects followed): an item at the end is fine (reached through a redirect); the site's own pages (a language's
 *     home, its search page) and files (a last segment with a dot: feeds, sitemaps, root files) at the end are not judged;
 *     anything else is broken — `deleted` (a deleted item's address), `unpublished` (the last address of an item no longer
 *     public) or `missing`. Registered (navigation) links are judged the same way, shown to administrators;
 *   - an orphan is a public item page no other public item's text links to (directly or through a redirect); what still
 *     reaches it is said apart: the lists (`listing`: articles are on the home page and their terms' pages) and the
 *     registered links (`navigation`).
 *
 * The database picks the candidates (links not at a public item, pages without a direct link in) through the graph's
 * indexes; the work after that is bounded (Codex review of batch 10, round 1): at most `candidates` of each, `resolve`
 * distinct addresses resolved (the rest counted as not checked), `rows` shown; `truncated` says a limit was reached.
 * What a caller is shown is limited to the items it may read (`readable`): a broken link by its source, an orphan by itself.
 */

const LIMITS = { resolve: 500, candidates: 20_000, rows: 1000 };

type BrokenReason = 'missing' | 'unpublished' | 'deleted';

type LinkSource =
  | { kind: 'item'; itemId: string; collection: string; title: string; url: string | null }
  | { kind: 'navigation'; linkId: string; label: string };

interface BrokenLink {
  source: LinkSource;
  field: string | null;
  position: number;
  href: string;
  anchorText: string;
  targetUrl: string;
  reason: BrokenReason;
}

interface OrphanItem {
  itemId: string;
  collection: string;
  locale: string;
  title: string;
  url: string | null;
  /** Reached from the site's lists (the home page, its terms' pages). */
  listing: boolean;
  /** Registered links to it (navigation the content does not hold). */
  navigation: number;
}

export interface LinkReport {
  scan: { status: string; startedAt: string; finishedAt: string | null; processed: number; lastError: string | null } | null;
  broken: BrokenLink[];
  brokenTotal: number;
  orphans: OrphanItem[];
  orphansTotal: number;
  /** Links whose address was not resolved (past the per-report limit): neither fine nor broken. */
  unchecked: number;
  /** A limit was reached: the lists may be incomplete. */
  truncated: boolean;
}

export interface LinkReportOptions {
  /** The items the caller may read, as an SQL condition on an item's id and collection (`readableScope`). */
  readable: ReadableScope;
  /** Whether the caller sees the registered (navigation) links: administrators. */
  navigation: boolean;
  /** Test hook: smaller limits. */
  limits?: Partial<typeof LIMITS>;
}

/** What one address leads to now: an item (directly or through redirects), nothing to judge, or why it is broken. */
type Outcome = { kind: 'item'; itemId: string } | { kind: 'skip' } | { kind: 'broken'; reason: BrokenReason };

/** The taxonomies' collections (fixed names) as an SQL list. */
const TAXONOMY_SQL = sql.raw([...TAXONOMY_COLLECTIONS].map((c) => `'${c.replace(/'/g, "''")}'`).join(', '));

const keyOf = (locale: string, path: string) => `${locale}\u0000${path}`;
const titleOf = (alias: string) =>
  sql.raw(`coalesce(nullif(${alias}.data ->> 'title', ''), nullif(${alias}.data ->> 'name', ''), ${alias}.data ->> 'slug', '')`);

interface Unmatched {
  id: string;
  origin: string;
  sourceItemId: string | null;
  sourceLabel: string | null;
  field: string | null;
  position: number;
  href: string;
  anchorText: string;
  targetUrl: string;
  targetLocale: string | null;
  targetPath: string | null;
  sourceCollection: string | null;
  sourceTitle: string | null;
  sourceUrl: string | null;
}

interface OrphanRow {
  itemId: string;
  collection: string;
  locale: string;
  title: string;
  url: string | null;
  navigation: number;
}

/**
 * The candidates, in the site's scope, limited to what the caller may see as they are chosen (Codex review of batch 10,
 * round 2): links not at a public item from sources it may read (and registered links, for administrators); pages it may
 * read with no direct link in; and the addresses not at a public item linked from any public page (whether a page is
 * reached through a redirect does not depend on who asks).
 */
async function candidatesOf(db: Database, siteId: string, limit: number, opts: LinkReportOptions) {
  return runSiteTransaction(db, siteId, async (tx) => {
    const unmatched = (await tx.execute(sql`
      SELECT e.id, e.origin, e.source_item_id AS "sourceItemId", e.source_label AS "sourceLabel", e.field, e.position, e.href,
             e.anchor_text AS "anchorText", e.target_url AS "targetUrl", e.target_locale AS "targetLocale", e.target_path AS "targetPath",
             s.collection AS "sourceCollection", ${titleOf('s')} AS "sourceTitle", s.card ->> 'url' AS "sourceUrl"
      FROM ${linkEdges} e
      LEFT JOIN ${publicItems} s ON s.site_id = e.site_id AND s.item_id = e.source_item_id
      WHERE e.site_id = ${siteId}
        AND (${opts.navigation ? sql`e.origin = 'manual' OR ` : sql``}(s.item_id IS NOT NULL AND ${opts.readable(sql`s.item_id`, sql`s.collection`)}))
        AND NOT EXISTS (SELECT 1 FROM ${publicItems} t WHERE t.site_id = e.site_id AND t.locale = e.target_locale AND t.path = e.target_path)
      ORDER BY e.target_url, e.id
      LIMIT ${limit + 1}`)) as unknown as Unmatched[];
    const elsewhere = (await tx.execute(sql`
      SELECT e.target_url AS "url", min(e.target_locale) AS "locale", min(e.target_path) AS "path",
             array_agg(DISTINCT e.source_item_id) AS "sources"
      FROM ${linkEdges} e JOIN ${publicItems} s ON s.site_id = e.site_id AND s.item_id = e.source_item_id
      WHERE e.site_id = ${siteId} AND e.origin = 'auto'
        AND NOT EXISTS (SELECT 1 FROM ${publicItems} t WHERE t.site_id = e.site_id AND t.locale = e.target_locale AND t.path = e.target_path)
      GROUP BY e.target_url
      ORDER BY 1
      LIMIT ${limit + 1}`)) as unknown as Array<{ url: string; locale: string | null; path: string | null; sources: string[] }>;
    const orphans = (await tx.execute(sql`
      SELECT i.item_id AS "itemId", i.collection, i.locale, ${titleOf('i')} AS title, i.card ->> 'url' AS url,
             (SELECT count(*)::int FROM ${linkEdges} m
               WHERE m.site_id = i.site_id AND m.origin = 'manual' AND m.target_locale = i.locale AND m.target_path = i.path) AS navigation
      FROM ${publicItems} i
      WHERE i.site_id = ${siteId}
        AND i.collection NOT IN (${TAXONOMY_SQL})
        AND ${opts.readable(sql`i.item_id`, sql`i.collection`)}
        AND NOT EXISTS (
          SELECT 1 FROM ${linkEdges} e JOIN ${publicItems} s ON s.site_id = e.site_id AND s.item_id = e.source_item_id
          WHERE e.site_id = i.site_id AND e.origin = 'auto' AND e.target_locale = i.locale AND e.target_path = i.path AND e.source_item_id <> i.item_id)
      ORDER BY 4, i.item_id
      LIMIT ${limit + 1}`)) as unknown as OrphanRow[];
    const [scan] = await tx.select().from(linkScans).where(eq(linkScans.siteId, siteId));
    return { unmatched, elsewhere, orphans, scan };
  });
}

/** Why an address that answers with nothing is broken: a deleted item's, an unpublished item's last, or nothing's. */
async function reasonsAt(db: Database, siteId: string, at: Array<{ locale: string; path: string }>): Promise<Map<string, BrokenReason>> {
  const out = new Map<string, BrokenReason>();
  if (at.length === 0) return out;
  const paths = [...new Set(at.map((a) => a.path))];
  await runSiteTransaction(db, siteId, async (tx) => {
    const memory = await tx
      .select({ locale: publicPathMemory.locale, path: publicPathMemory.path })
      .from(publicPathMemory)
      .where(and(eq(publicPathMemory.siteId, siteId), inArray(publicPathMemory.path, paths)));
    for (const m of memory) out.set(keyOf(m.locale, m.path), 'unpublished');
    const tombs = await tx
      .select({ locale: routeTombstones.locale, path: routeTombstones.path })
      .from(routeTombstones)
      .where(and(eq(routeTombstones.siteId, siteId), inArray(routeTombstones.path, paths)));
    for (const t of tombs) out.set(keyOf(t.locale, t.path), 'deleted');
  });
  return out;
}

/** A file's address: its last segment has a dot (feeds, sitemaps, root files are served at such names). */
const isFile = (pathname: string) => (pathname.split('/').filter(Boolean).pop() ?? '').includes('.');

/** The outcome of each address not at a public item, resolved as a request (redirects followed), up to `limit`. */
async function resolveAll(db: Database, siteId: string, targets: Array<{ url: string; locale: string | null; path: string | null }>, limit: number) {
  const outcomes = new Map<string, Outcome>();
  const pending: Array<{ url: string; locale: string; path: string }> = [];
  for (const t of targets.slice(0, limit)) {
    const u = new URL(t.url);
    if (isFile(u.pathname)) {
      outcomes.set(t.url, { kind: 'skip' });
      continue;
    }
    let result: PublicPathResult = await resolvePublicPath(db, { host: u.host, path: u.pathname });
    // A redirect: where it ends (the resolver answers one 301 to the final address), judged as a direct address would be
    // (Codex review of batch 10, round 1: a redirect to a feed is not broken).
    if (result.kind === 'redirect') {
      const end = new URL(result.location);
      if (isFile(end.pathname)) {
        outcomes.set(t.url, { kind: 'skip' });
        continue;
      }
      result = await resolvePublicPath(db, { host: end.host, path: end.pathname });
    }
    if (result.kind === 'item') {
      outcomes.set(t.url, { kind: 'item', itemId: result.itemId });
      continue;
    }
    const at = result.kind === 'gone' || result.kind === 'not_found' ? result.at : undefined;
    // The site's own pages answer there: a language's home and its search page.
    if (at && (at.contentPath === '/' || at.contentPath === '/search')) {
      outcomes.set(t.url, { kind: 'skip' });
      continue;
    }
    const locale = at?.locale ?? t.locale;
    const path = at?.contentPath ?? t.path;
    if (locale && path) pending.push({ url: t.url, locale, path });
    else outcomes.set(t.url, { kind: 'broken', reason: 'missing' });
  }
  const reasons = await reasonsAt(db, siteId, pending);
  for (const p of pending) outcomes.set(p.url, { kind: 'broken', reason: reasons.get(keyOf(p.locale, p.path)) ?? 'missing' });
  return outcomes;
}

/** The report of a site, limited to what the caller may see. */
export async function linkReport(db: Database, siteId: string, opts: LinkReportOptions): Promise<LinkReport> {
  const limits = { ...LIMITS, ...opts.limits };
  const { unmatched: allUnmatched, elsewhere: allElsewhere, orphans: allOrphans, scan } = await candidatesOf(db, siteId, limits.candidates, opts);
  let truncated = allUnmatched.length > limits.candidates || allOrphans.length > limits.candidates || allElsewhere.length > limits.candidates;
  const unmatched = allUnmatched.slice(0, limits.candidates);

  // The caller's links first, each list within its own budget: what decides whether a page is an orphan (any public
  // page's links through redirects) never takes the places of the caller's broken links.
  const mine = new Map<string, { url: string; locale: string | null; path: string | null }>();
  for (const e of unmatched) if (!mine.has(e.targetUrl)) mine.set(e.targetUrl, { url: e.targetUrl, locale: e.targetLocale, path: e.targetPath });
  if (mine.size > limits.resolve) truncated = true;
  const outcomes = await resolveAll(db, siteId, [...mine.values()], limits.resolve);
  const elsewhere = allElsewhere.slice(0, limits.candidates);
  const others = elsewhere.filter((t) => !outcomes.has(t.url));
  if (others.length > limits.resolve) truncated = true;
  for (const [url, outcome] of await resolveAll(db, siteId, others, limits.resolve)) outcomes.set(url, outcome);

  const broken: BrokenLink[] = [];
  const viaRedirect = new Set<string>();
  const navigation = new Map<string, number>();
  let unchecked = 0;
  for (const e of unmatched) {
    const outcome = outcomes.get(e.targetUrl);
    if (!outcome) {
      unchecked++;
      continue;
    }
    if (outcome.kind === 'item' && e.origin === 'manual') navigation.set(outcome.itemId, (navigation.get(outcome.itemId) ?? 0) + 1);
    if (outcome.kind !== 'broken') continue;
    const source: LinkSource =
      e.origin === 'manual'
        ? { kind: 'navigation', linkId: e.id, label: e.sourceLabel ?? '' }
        : { kind: 'item', itemId: e.sourceItemId!, collection: e.sourceCollection!, title: e.sourceTitle ?? '', url: e.sourceUrl };
    broken.push({ source, field: e.field, position: e.position, href: e.href, anchorText: e.anchorText, targetUrl: e.targetUrl, reason: outcome.reason });
  }
  // Pages reached through a redirect from another public page (a page's link to its own old address is a link to
  // itself, Codex review of batch 10, round 3).
  for (const t of elsewhere) {
    const outcome = outcomes.get(t.url);
    // One row per address, its sources gathered (Codex review of batch 10, round 4: the budget counts addresses).
    if (outcome?.kind === 'item' && t.sources.some((source) => source !== outcome.itemId)) viaRedirect.add(outcome.itemId);
  }

  const shownBroken = broken.sort((a, b) => {
    const ka = a.source.kind === 'item' ? `1${a.source.title}\u0000${a.source.itemId}` : `0${a.source.label}\u0000${a.source.linkId}`;
    const kb = b.source.kind === 'item' ? `1${b.source.title}\u0000${b.source.itemId}` : `0${b.source.label}\u0000${b.source.linkId}`;
    return ka < kb ? -1 : ka > kb ? 1 : (a.field ?? '').localeCompare(b.field ?? '') || a.position - b.position;
  });
  const shownOrphans = allOrphans
    .slice(0, limits.candidates)
    .filter((r) => !viaRedirect.has(r.itemId))
    .map((r) => ({
      itemId: r.itemId,
      collection: r.collection,
      locale: r.locale,
      title: r.title,
      url: r.url,
      listing: r.collection === 'articles',
      // The registered links are an administrator's: not even their count to others (round 3).
      navigation: opts.navigation ? r.navigation + (navigation.get(r.itemId) ?? 0) : 0,
    }));
  if (shownBroken.length > limits.rows || shownOrphans.length > limits.rows) truncated = true;
  return {
    scan: scan
      ? { status: scan.status, startedAt: scan.startedAt.toISOString(), finishedAt: scan.finishedAt?.toISOString() ?? null, processed: scan.processed, lastError: scan.lastError }
      : null,
    broken: shownBroken.slice(0, limits.rows),
    brokenTotal: shownBroken.length,
    orphans: shownOrphans.slice(0, limits.rows),
    orphansTotal: shownOrphans.length,
    unchecked,
    truncated,
  };
}
