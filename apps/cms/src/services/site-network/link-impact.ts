import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { parseFragment, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { items, linkEdges, publicItems, redirects, type Database } from '@heopress/database';
import { appendItemEvent } from '../../modules/cdc/change-feed/outbox-writer';
import type { ItemService } from '../item-service';
import { runSiteTransaction } from '../rls-transaction';
import type { ReadableScope } from './readable-items';
import { siteLinkSpace, siteTargetOf, type SiteLinkSpace } from './link-graph';
import { publicItemPredicate, resolvePublicPath, type PublicPathResult } from './public-path';
import { assertSiteRulesTerminate, lockAddressSpace } from './site-rules';

/**
 * Change impact (HeoPress P07 task 5.5; spec seo/link-graph "变更影响预览"): before a page is unpublished, deleted or moved,
 * the pages that link to it and where — "may be affected": the link graph knows the links of published text and the
 * registered navigation, not a theme's or another site's — and two ways out: a redirect from its address, or the links
 * updated to another address.
 *
 *   - Links to it: to its address, or to an address a redirect of the site sends to it (one step, by path).
 *   - Depth 2 (asked for): the pages linking to those pages — they may lose their way to it too. At most `MAX_DEPTH`, at
 *     most `limit` pages in all (`truncated` says more were found).
 *   - What the caller is shown is limited to the pages it may read; the registered links, to administrators.
 */

const MAX_DEPTH = 2;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;
/** Pages whose links are updated in one request at most. */
const MAX_UPDATE = 50;

export class LinkImpactError extends Error {
  constructor(
    readonly code: 'NOT_PUBLIC' | 'NOT_ON_SITE' | 'NOT_A_PAGE' | 'REDIRECT_EXISTS' | 'REDIRECT_CONFLICT' | 'TOO_MANY' | 'INVALID',
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

interface Target {
  itemId: string;
  collection: string;
  locale: string;
  path: string;
  url: string | null;
}

interface ImpactLink {
  depth: 1 | 2;
  source: { kind: 'item'; itemId: string; collection: string; title: string; url: string | null } | { kind: 'navigation'; linkId: string; label: string };
  field: string | null;
  position: number;
  href: string;
  anchorText: string;
  /** For depth 2: the page of depth 1 it links to. */
  via?: string;
}

export interface LinkImpact {
  target: Target;
  links: ImpactLink[];
  /** Distinct pages listed (sources of `links`). */
  pages: number;
  truncated: boolean;
  limits: { depth: number; limit: number };
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

async function targetIn(tx: Tx, siteId: string, itemId: string): Promise<Target> {
  const [row] = await tx
    .select({ itemId: publicItems.itemId, collection: publicItems.collection, locale: publicItems.locale, path: publicItems.path, url: sql<string | null>`${publicItems.card} ->> 'url'` })
    .from(publicItems)
    .where(and(eq(publicItems.siteId, siteId), eq(publicItems.itemId, itemId)));
  if (!row) throw new LinkImpactError('NOT_PUBLIC', 'The item is not public: no page links to it.', 404);
  return row;
}

const targetOf = (db: Database, siteId: string, itemId: string) => runSiteTransaction(db, siteId, (tx) => targetIn(tx, siteId, itemId));

/**
 * The addresses that reach a page: in the content space (its own, and content redirects to it), and URL-layer redirects to
 * one of its addresses (Codex review of task 5.5, rounds 1–5). A URL-layer rule applies on every host of the site, and
 * leads to the page only from the hosts where its destination is one of the page's addresses (its canonical address; the
 * content path on its language's entry domain): such an alias is the rule's decoded source path on those hosts — a link
 * is to it when its URL has one of those hosts and its path decodes to that path (`/old-%62/` is `/old-b`), whatever
 * language, if any, the site detects there. One step.
 */
interface Addresses {
  content: Array<{ locale: string; path: string }>;
  urlAliases: UrlAlias[];
}

interface UrlAlias {
  /** The active hostnames the alias answers on (lower case). */
  hosts: string[];
  /** Decoded, no trailing slash (the root as `/`). */
  path: string;
}

/** An edge's target URL's host, lower case (after any user information, as `URL.hostname`; Codex review of task 5.5, round 6). */
const urlHost = (e: string) => sql.raw(`lower(substring(${e}.target_url from '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/?#@]*@)?([^/:?#]+)'))`);

/** An edge's target URL's path as `target_url` holds it (percent-encoded), without its query, fragment and trailing slash (the root as `/`; Codex review of task 5.5, round 2: `/old/b/?x=1` is a link to `/old/b`). */
const urlPath = (e: string) =>
  sql.raw(`coalesce(nullif(rtrim(regexp_replace(split_part(split_part(${e}.target_url, '#', 1), '?', 1), '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+', ''), '/'), ''), '/')`);

/** A path without its trailing slash (the root as `/`). */
const bare = (path: string) => path.replace(/\/+$/, '') || '/';

/**
 * Whether the URL parser writes a byte of a path escaped (WHATWG path percent-encode set: controls, space, `"#<>?^`,
 * the backquote, the braces, DEL and non-ASCII bytes; Codex review of task 5.5, round 7).
 */
const parserEscapes = (b: number) => b <= 0x20 || b >= 0x7f || '"#<>?^`{}'.includes(String.fromCharCode(b));

/**
 * A decoded path as `target_url` holds a link to it (the parser's escapes, upper case), no trailing slash: what only an
 * escape can say is escaped too — `%` itself, and `\` (a separator to the parser). Every path written with these
 * escapes only is this path of its decoded form; any other escape is `NON_CANONICAL`.
 */
export function canonicalPath(path: string): string {
  let out = '';
  for (const b of new TextEncoder().encode(path)) {
    const c = String.fromCharCode(b);
    out += parserEscapes(b) || c === '%' || c === '\\' ? `%${b.toString(16).toUpperCase().padStart(2, '0')}` : c;
  }
  return bare(out);
}

/** A path with an escape `canonicalPath` never writes (written by hand: `%62`, lower case, `%2F`…): decoded in the service. */
const NON_CANONICAL = `'%(?![01][0-9A-F]|2[0235]|3[CEF]|5[CE]|60|7[BDF]|[89A-F][0-9A-F])'`;

/** A URL's host (lower case) and path decoded segment by segment, no trailing slash; null when its path does not decode to segments. */
function decodedTarget(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(url);
    const segments = bare(u.pathname).split('/').map((seg) => decodeURIComponent(seg));
    if (segments.slice(1).some((seg) => seg.includes('/'))) return null;
    return { host: u.hostname.toLowerCase(), path: segments.join('/') || '/' };
  } catch {
    return null;
  }
}

/**
 * The aliases indexed by decoded path: `match(url)` is the value of an alias the URL is a link to (one of its hosts, its
 * path decoded) — the one rule of the preview's hand-written escapes, the second level's attribution and the link update.
 */
function aliasIndex<T>(entries: Array<[UrlAlias, T]>): (url: string) => T | undefined {
  const byPath = new Map<string, Array<[UrlAlias, T]>>();
  for (const e of entries) byPath.set(e[0].path, [...(byPath.get(e[0].path) ?? []), e]);
  return (url) => {
    const d = decodedTarget(url);
    return d ? byPath.get(d.path)?.find(([a]) => a.hosts.includes(d.host))?.[1] : undefined;
  };
}

/** The active hostnames whose addresses are detected on `host` (it, and the plain aliases of the primary domain). */
function hostnamesOf(link: SiteLinkSpace, host: string): string[] {
  return [...link.hosts].filter(([, to]) => to === host).map(([name]) => name);
}

/** An edge's id and target URL. */
type EdgeTarget = { id: string; targetUrl: string };

type ChildNode = DefaultTreeAdapterMap['childNode'];

type EdgeRow = {
  id: string;
  origin: string;
  sourceItemId: string | null;
  sourceLabel: string | null;
  field: string | null;
  position: number;
  href: string;
  anchorText: string;
  targetLocale: string | null;
  targetPath: string | null;
  targetUrl: string;
  collection: string | null;
  title: string;
  url: string | null;
};

/**
 * The links to `targets`, by the pages (and registered links) they are in: the rows of at most `pages` + 1 distinct
 * sources (Codex review of task 5.5: the limit counts pages, not links — one page with many links does not hide others).
 */
async function linksTo(db: Database, siteId: string, targets: Addresses, opts: { readable: ReadableScope; navigation: boolean; pages: number; exclude: string[] }): Promise<EdgeRow[]> {
  // As tables of one parameter each, whatever their number (Codex review of task 5.5, rounds 6 and 7: up to 20,000 imported
  // rules, on any number of hosts): the aliases' host sets once each, the aliases once each, joined.
  const groups = new Map<string, number>();
  const hostRows: Array<{ g: number; host: string }> = [];
  const aliasRows: Array<{ g: number; path: string }> = [];
  for (const a of targets.urlAliases) {
    const key = a.hosts.join(' ');
    let g = groups.get(key);
    if (g === undefined) {
      g = groups.size;
      groups.set(key, g);
      for (const host of a.hosts) hostRows.push({ g, host });
    }
    aliasRows.push({ g, path: canonicalPath(a.path) });
  }
  const hostTable = sql`json_to_recordset(${JSON.stringify(hostRows)}::json) AS h(g int, host text)`;
  const parts = [
    ...(targets.content.length
      ? [sql`(e.target_locale, e.target_path) IN (SELECT c.locale, c.path FROM json_to_recordset(${JSON.stringify(targets.content)}::json) AS c(locale text, path text))`]
      : []),
    // The alias as the URL parser writes it: hash joins.
    ...(aliasRows.length
      ? [
          sql`e.id IN (SELECT x.id FROM ${linkEdges} x JOIN ${hostTable} ON h.host = ${urlHost('x')}
                       JOIN json_to_recordset(${JSON.stringify(aliasRows)}::json) AS a(g int, path text) ON a.g = h.g AND a.path = ${urlPath('x')}
                       WHERE x.site_id = ${siteId})`,
        ]
      : []),
  ];
  if (parts.length === 0) return [];
  return (await runSiteTransaction(db, siteId, async (tx) => {
    // Written with other escapes (rare): those of the aliases' hosts read, decoded here — only paths whose length an
    // alias can have (Codex review of task 5.5, round 8): never shorter than its parser encoding (what the parser must
    // escape cannot stand literally in `target_url`), never longer than every byte escaped.
    if (aliasRows.length) {
      const shortest = Math.min(...aliasRows.map((a) => a.path.length));
      const longest = Math.max(...targets.urlAliases.map((a) => 3 * new TextEncoder().encode(a.path).length));
      const handWritten = (await tx.execute(sql`
        SELECT x.id, x.target_url AS "targetUrl" FROM ${linkEdges} x
        WHERE x.site_id = ${siteId} AND ${urlHost('x')} IN (SELECT h.host FROM ${hostTable}) AND ${urlPath('x')} ~ ${sql.raw(NON_CANONICAL)}
          AND length(${urlPath('x')}) BETWEEN ${shortest} AND ${longest}`)) as unknown as EdgeTarget[];
      const match = aliasIndex(targets.urlAliases.map((a) => [a, true] as [UrlAlias, true]));
      const ids = handWritten.filter((x) => match(x.targetUrl)).map((x) => x.id);
      if (ids.length) parts.push(sql`e.id IN (SELECT value FROM json_array_elements_text(${JSON.stringify(ids)}::json))`);
    }
    return tx.execute(sql`
      SELECT * FROM (
        SELECT e.id, e.origin, e.source_item_id AS "sourceItemId", e.source_label AS "sourceLabel", e.field, e.position, e.href,
               e.anchor_text AS "anchorText", e.target_locale AS "targetLocale", e.target_path AS "targetPath", e.target_url AS "targetUrl",
               s.collection, coalesce(nullif(s.data ->> 'title', ''), nullif(s.data ->> 'name', ''), s.data ->> 'slug', '') AS title,
               s.card ->> 'url' AS url,
               dense_rank() OVER (ORDER BY e.origin, coalesce(nullif(s.data ->> 'title', ''), nullif(s.data ->> 'name', ''), s.data ->> 'slug', ''), coalesce(e.source_item_id, e.id)) AS page
        FROM ${linkEdges} e
        LEFT JOIN ${publicItems} s ON s.site_id = e.site_id AND s.item_id = e.source_item_id
        WHERE e.site_id = ${siteId} AND (${sql.join(parts, sql` OR `)})
          AND (${opts.navigation ? sql`e.origin = 'manual' OR ` : sql``}(s.item_id IS NOT NULL AND ${opts.readable(sql`s.item_id`, sql`s.collection`)}))
          ${opts.exclude.length ? sql`AND (e.source_item_id IS NULL OR e.source_item_id NOT IN (${sql.join(opts.exclude.map((x) => sql`${x}`), sql`, `)}))` : sql``}
      ) r
      WHERE r.page <= ${opts.pages + 1}
      ORDER BY r.page, r.field, r.position`);
  })) as unknown as EdgeRow[];
}

/**
 * The addresses that reach each of `targets` (`Addresses`), in one read of the redirects (Codex review of task 5.5,
 * round 3: the second level asks for many pages at once).
 */
async function addressesOfMany(db: Database, siteId: string, targets: Target[]): Promise<Map<string, Addresses>> {
  const out = new Map<string, Addresses>();
  for (const t of targets) out.set(t.itemId, { content: [{ locale: t.locale, path: t.path }], urlAliases: [] });
  if (targets.length === 0) return out;
  return runSiteTransaction(db, siteId, async (tx) => {
    const link = await siteLinkSpace(tx, siteId);
    const places = new Map(targets.map((t) => [t.itemId, link.space.addressesOf(t.locale, t.path)]));
    // One list per host, shared by its aliases.
    const hostLists = new Map<string, string[]>();
    const hostsOf = (host: string) => hostLists.get(host) ?? hostLists.set(host, hostnamesOf(link, host)).get(host)!;
    const contentKeys = targets.map((t) => sql`(${t.locale}, ${t.path})`);
    const externals = [...new Set([...places.values()].flat().flatMap((p) => (p.path === '/' ? ['/'] : [p.path, `${p.path}/`])))];
    const rows = await tx
      .select({ scope: redirects.scope, locale: redirects.locale, fromPath: redirects.fromPath, toPath: redirects.toPath, toLocale: redirects.toLocale })
      .from(redirects)
      .where(
        and(
          eq(redirects.siteId, siteId),
          eq(redirects.match, 'exact'),
          or(
            and(eq(redirects.scope, 'content'), sql`(${redirects.toLocale}, ${redirects.toPath}) IN (${sql.join(contentKeys, sql`, `)})`),
            externals.length ? and(eq(redirects.scope, 'url'), inArray(redirects.toPath, externals)) : undefined,
          ),
        ),
      );
    for (const t of targets) {
      const a = out.get(t.itemId)!;
      for (const r of rows) {
        if (r.scope === 'content' && r.toLocale === t.locale && r.toPath === t.path) a.content.push({ locale: r.locale, path: r.fromPath });
        if (r.scope !== 'url') continue;
        // The hosts where the rule's destination is one of the page's addresses.
        for (const place of places.get(t.itemId)!) {
          if (bare(r.toPath) !== bare(place.path)) continue;
          const hosts = hostsOf(place.host);
          if (hosts.length) a.urlAliases.push({ hosts, path: bare(r.fromPath) });
        }
      }
    }
    return out;
  });
}

/** The addresses that reach a page (`Addresses`). */
async function addressesOf(db: Database, siteId: string, target: Target): Promise<Addresses> {
  return (await addressesOfMany(db, siteId, [target])).get(target.itemId)!;
}

/** What may be affected by a change of `itemId`'s page (task 5.5). */
export async function linkImpact(
  db: Database,
  siteId: string,
  itemId: string,
  opts: { readable: ReadableScope; navigation: boolean; depth?: number; limit?: number },
): Promise<LinkImpact> {
  const depth = Math.min(Math.max(1, Math.trunc(opts.depth ?? 1)), MAX_DEPTH);
  const limit = Math.min(Math.max(1, Math.trunc(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const target = await targetOf(db, siteId, itemId);
  const toLink = (r: EdgeRow, d: 1 | 2, via?: string): ImpactLink => ({
    depth: d,
    source:
      r.origin === 'manual'
        ? { kind: 'navigation', linkId: r.id, label: r.sourceLabel ?? '' }
        : { kind: 'item', itemId: r.sourceItemId!, collection: r.collection!, title: r.title, url: r.url },
    field: r.field,
    position: r.position,
    href: r.href,
    anchorText: r.anchorText,
    ...(via ? { via } : {}),
  });
  const pageOf = (r: EdgeRow) => r.sourceItemId ?? `nav:${r.id}`;
  /** The rows of the first `n` distinct pages, and whether there were more. */
  const firstPages = (rows: EdgeRow[], n: number) => {
    const seen: string[] = [];
    const kept = rows.filter((r) => {
      const p = pageOf(r);
      if (!seen.includes(p)) seen.push(p);
      return seen.indexOf(p) < n;
    });
    return { kept, more: seen.length > n };
  };
  const first = firstPages(await linksTo(db, siteId, await addressesOf(db, siteId, target), { ...opts, pages: limit, exclude: [itemId] }), limit);
  let truncated = first.more;
  const links = first.kept.map((r) => toLink(r, 1));
  const pagesOf = (list: ImpactLink[]) => new Set(list.flatMap((l) => (l.source.kind === 'item' ? [l.source.itemId] : [`nav:${l.source.linkId}`])));
  if (depth >= 2 && !truncated) {
    const level1 = [...new Set(first.kept.flatMap((r) => (r.sourceItemId ? [r.sourceItemId] : [])))];
    const room = limit - pagesOf(links).size;
    // No room left for a second level that may hold pages: the list is not complete (Codex review of task 5.5, round 2).
    if (room <= 0 && level1.length) truncated = true;
    if (room > 0 && level1.length) {
      const pages = await runSiteTransaction(db, siteId, (tx) =>
        tx
          .select({ itemId: publicItems.itemId, collection: publicItems.collection, locale: publicItems.locale, path: publicItems.path, url: sql<string | null>`${publicItems.card} ->> 'url'` })
          .from(publicItems)
          .where(and(eq(publicItems.siteId, siteId), inArray(publicItems.itemId, level1))),
      );
      // Each first-level page's addresses, its aliases included (round 2), read at once (round 3).
      const all: Addresses = { content: [], urlAliases: [] };
      const viaOf = new Map<string, string>();
      const aliasesOf: Array<[UrlAlias, string]> = [];
      for (const [id, a] of await addressesOfMany(db, siteId, pages)) {
        for (const c of a.content) {
          all.content.push(c);
          viaOf.set(`c\u0000${c.locale}\u0000${c.path}`, id);
        }
        for (const alias of a.urlAliases) {
          all.urlAliases.push(alias);
          aliasesOf.push([alias, id]);
        }
      }
      const second = firstPages(await linksTo(db, siteId, all, { ...opts, pages: room, exclude: [itemId, ...level1] }), room);
      if (second.more) truncated = true;
      const viaAlias = aliasIndex(aliasesOf);
      const via = (r: EdgeRow) => (r.targetLocale && r.targetPath ? viaOf.get(`c\u0000${r.targetLocale}\u0000${r.targetPath}`) : undefined) ?? viaAlias(r.targetUrl);
      links.push(...second.kept.map((r) => toLink(r, 2, via(r))));
    }
  }
  return { target, links, pages: pagesOf(links).size, truncated, limits: { depth, limit } };
}

/**
 * A redirect from the page's address to `to` (an address on the site's own hosts), so links to it keep working once it is
 * unpublished, deleted or moved. A content rule of the page's language; it takes effect when the page no longer answers
 * there (a live page is served first). The site's rule set must still terminate. Administrators only (the route).
 */
export async function createImpactRedirect(db: Database, siteId: string, itemId: string, to: unknown, actor: { userId: string | null }): Promise<{ id: string; fromPath: string; toPath: string; toLocale: string }> {
  return runSiteTransaction(db, siteId, async (tx) => {
    // Everything the redirect is made of read under the address-space lock (Codex review of task 5.5, rounds 3 to 5): the
    // page and its addresses, the site's hosts and language prefixes that place the destination, its redirect chain — the
    // writers of each take the same lock (a page's move through its items trigger), so what is checked is what is stored.
    await lockAddressSpace(tx, siteId);
    const target = await targetIn(tx, siteId, itemId);
    const link = await siteLinkSpace(tx, siteId);
    const dest = typeof to === 'string' ? siteTargetOf(link, to) : null;
    if (!dest || !dest.locale || !dest.contentPath) throw new LinkImpactError('NOT_ON_SITE', 'The destination must be a page address on one of the site\'s active domains.', 400);
    if (dest.locale === target.locale && dest.contentPath === target.path) throw new LinkImpactError('INVALID', 'A page cannot redirect to itself.', 400);
    // Another page: the destination must answer with a public page, never a redirect to nothing.
    let page: PublicPathResult | null = null;
    try {
      const u = new URL(to as string);
      page = await resolvePublicPath(db, { host: u.host, path: u.pathname });
      if (page.kind === 'redirect') {
        const end = new URL(page.location);
        page = await resolvePublicPath(db, { host: end.host, path: end.pathname });
      }
    } catch {
      page = null;
    }
    if (page?.kind !== 'item' || page.siteId !== siteId || page.itemId === itemId) throw new LinkImpactError('NOT_A_PAGE', 'The destination must be another published page of the site.', 400);
    // The destination still a public page, and kept so until this commits (round 2: its unpublishing or a move waits).
    const [still] = await tx
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.siteId, siteId), eq(items.id, page.itemId), publicItemPredicate()))
      .for('share');
    if (!still) throw new LinkImpactError('NOT_A_PAGE', 'The destination must be another published page of the site.', 400);
    // A rule already at its address — of its language, or a URL-layer one at one of its external addresses (which would
    // win): taken.
    const external = link.space.addressesOf(target.locale, target.path).flatMap((p) => (p.path === '/' ? ['/'] : [p.path, `${p.path}/`]));
    const [existing] = await tx
      .select({ id: redirects.id })
      .from(redirects)
      .where(
        and(
          eq(redirects.siteId, siteId),
          eq(redirects.match, 'exact'),
          or(
            and(eq(redirects.scope, 'content'), eq(redirects.locale, target.locale), eq(redirects.fromPath, target.path)),
            external.length ? and(eq(redirects.scope, 'url'), inArray(redirects.fromPath, external)) : undefined,
          ),
        ),
      );
    if (existing) throw new LinkImpactError('REDIRECT_EXISTS', 'A redirect from this address already exists.', 409);
    const [row] = await tx
      .insert(redirects)
      .values({ siteId, scope: 'content', locale: target.locale, fromPath: target.path, match: 'exact', toPath: dest.contentPath, toLocale: dest.locale, source: 'impact', createdBy: actor.userId })
      .returning({ id: redirects.id });
    try {
      await assertSiteRulesTerminate(tx, siteId);
    } catch {
      throw new LinkImpactError('REDIRECT_CONFLICT', 'This redirect would make the site\'s redirects loop.', 409);
    }
    await appendItemEvent(tx, {
      siteId,
      resource: 'redirect',
      collection: '$redirects',
      itemId: row!.id,
      itemVersion: null,
      changedFields: ['redirects'],
      operation: 'create',
      source: 'api',
      actor: actor.userId ? { type: 'user', id: actor.userId } : undefined,
      payload: { impactOf: itemId, rules: 1 },
    });
    return { id: row!.id, fromPath: target.path, toPath: dest.contentPath, toLocale: dest.locale };
  });
}

/**
 * `html` with every link to one of `from` (absolute against `base`) pointing to `to` instead, its fragment kept; and how
 * many. The HTML is parsed (Codex review of task 5.5: an `href` is an `<a>`'s attribute, however it is quoted or
 * escaped, never text inside another attribute) and, when something changed, written out again.
 */
export function rewriteLinks(html: string, base: string, from: Set<string>, to: string): { html: string; changed: number } {
  const fragment = parseFragment(html);
  let changed = 0;
  const walk = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (!('tagName' in n)) continue;
      if (n.tagName === 'a') {
        const attr = n.attrs.find((x) => x.name === 'href');
        if (attr) {
          try {
            const u = new URL(attr.value.trim(), base);
            const hash = u.hash;
            u.hash = '';
            if (from.has(u.toString())) {
              const next = new URL(to);
              next.hash = hash;
              attr.value = next.toString();
              changed++;
            }
          } catch {
            // Not a URL: left as it is.
          }
        }
      }
      walk(n.childNodes as ChildNode[]);
    }
  };
  walk(fragment.childNodes as ChildNode[]);
  return { html: changed ? serialize(fragment) : html, changed };
}

/**
 * The links of `sources` that point to the page (its address, or an address redirected to it) changed to `to`, through
 * the caller's own item service: each page is updated only if the caller may update it (else it is reported skipped),
 * at its current version, as a new revision. At most `MAX_UPDATE` pages per request.
 */
export async function updateImpactLinks(
  db: Database,
  siteId: string,
  items: ItemService,
  itemId: string,
  input: { to: unknown; sources: unknown },
): Promise<{ updated: Array<{ itemId: string; links: number }>; skipped: Array<{ itemId: string; reason: string }> }> {
  const target = await targetOf(db, siteId, itemId);
  const sources = Array.isArray(input.sources) ? [...new Set(input.sources.filter((s): s is string => typeof s === 'string'))] : [];
  if (sources.length === 0) throw new LinkImpactError('INVALID', 'Name the pages whose links to update.', 400);
  if (sources.length > MAX_UPDATE) throw new LinkImpactError('TOO_MANY', `At most ${MAX_UPDATE} pages at a time.`, 400);
  // The addresses that reach the page; the links to them are found by the edges' recorded targets.
  const addresses = await addressesOf(db, siteId, target);
  const { dest, from, rows } = await runSiteTransaction(db, siteId, async (tx) => {
    const link = await siteLinkSpace(tx, siteId);
    const dest = typeof input.to === 'string' ? siteTargetOf(link, input.to) : null;
    const edges = await tx
      .select({ sourceItemId: linkEdges.sourceItemId, targetUrl: linkEdges.targetUrl, targetLocale: linkEdges.targetLocale, targetPath: linkEdges.targetPath })
      .from(linkEdges)
      .where(and(eq(linkEdges.siteId, siteId), eq(linkEdges.origin, 'auto'), inArray(linkEdges.sourceItemId, sources)));
    const reaching = new Set(addresses.content.map((a) => `${a.locale}\u0000${a.path}`));
    const toAlias = aliasIndex(addresses.urlAliases.map((a) => [a, true] as [UrlAlias, true]));
    const from = new Set(
      edges
        .filter(
          (e) =>
            (e.targetLocale && e.targetPath && reaching.has(`${e.targetLocale}\u0000${e.targetPath}`)) ||
            !!toAlias(e.targetUrl),
        )
        .map((e) => e.targetUrl),
    );
    const rows = await tx
      .select({ itemId: publicItems.itemId, collection: publicItems.collection, url: sql<string | null>`${publicItems.card} ->> 'url'`, richFields: publicItems.richFields })
      .from(publicItems)
      .where(and(eq(publicItems.siteId, siteId), inArray(publicItems.itemId, sources)));
    return { dest, from, rows };
  });
  if (!dest || !dest.locale || typeof input.to !== 'string') throw new LinkImpactError('NOT_ON_SITE', 'The new address must be on one of the site\'s active domains.', 400);
  const updated: Array<{ itemId: string; links: number }> = [];
  const skipped: Array<{ itemId: string; reason: string }> = [];
  for (const id of sources) {
    const row = rows.find((r) => r.itemId === id);
    if (!row || !row.url) {
      skipped.push({ itemId: id, reason: 'not_public' });
      continue;
    }
    try {
      const item = (await items.detail(row.collection, id)) as { data?: Record<string, unknown>; version?: number } | null;
      if (!item?.data) {
        skipped.push({ itemId: id, reason: 'not_found' });
        continue;
      }
      const patch: Record<string, unknown> = {};
      let count = 0;
      for (const field of row.richFields) {
        const value = item.data[field];
        if (typeof value !== 'string') continue;
        const { html, changed } = rewriteLinks(value, row.url, from, input.to);
        if (changed) {
          patch[field] = html;
          count += changed;
        }
      }
      if (count === 0) {
        skipped.push({ itemId: id, reason: 'no_links' });
        continue;
      }
      await items.patch(row.collection, id, { data: patch, expectedVersion: item.version ?? 0 });
      updated.push({ itemId: id, links: count });
    } catch (err) {
      const status = (err as { status?: number }).status;
      skipped.push({ itemId: id, reason: status === 403 ? 'forbidden' : status === 409 ? 'changed' : 'failed' });
    }
  }
  return { updated, skipped };
}
