import { and, eq } from 'drizzle-orm';
import { parseFragment } from 'parse5';
import { collections, fields as fieldsTable, siteDomains, siteSeoSettings, type Database } from '@heopress/database';
import { effectiveSeoSettings, type SiteSeoSettings } from '@heopress/contracts/schemas';
import { linksOf, type PublicPathResult } from '@heopress/public-site';
import { decideIndexing, pageTypeOfCollection } from '@heopress/seo-geo';
import { applyFieldMask } from '../permission-dsl';
import { runSiteTransaction } from '../rls-transaction';

/**
 * Pre-publish checks of one item (HeoPress P07a task 5.4; spec studio/review-workspace "稿件详情与发布前检查",
 * "发布前检查的读取权限"). Hints only — whether publishing is blocked stays the site's own rules. Computed from what the
 * caller may read: a field it may not read shows `no_permission` and its content is never in the answer. Internal
 * links are resolved against the public projection and route table in the database; external links are `not_checked`;
 * nothing is fetched over the network.
 */

type CheckStatus = 'pass' | 'warn' | 'fail' | 'not_checked' | 'no_permission';

export interface Check {
  id: 'title' | 'description' | 'indexing' | 'structured_data' | 'links' | 'images';
  status: CheckStatus;
  /** A reason code for the interface (`too_short`, `noindex`, …). */
  reason?: string;
  /** Lengths, counts. */
  value?: number;
  /** Links or images concerned (addresses only, never body text). */
  items?: Array<{ url: string; status: 'ok' | 'broken' | 'redirected' | 'not_checked' | 'no_alt' }>;
}

const TITLE_RANGE = [30, 60] as const;
const DESCRIPTION_RANGE = [70, 160] as const;
const RICH_TEXT = 'wysiwyg';

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Length of the title the page will show: the SEO title, else the title. */
export function titleCheck(data: Record<string, unknown>, readable: (f: string) => boolean): Check {
  if (!readable('seo_title') && !readable('title')) return { id: 'title', status: 'no_permission' };
  const value = (readable('seo_title') ? str(data.seo_title) : '') || (readable('title') ? str(data.title) : '');
  if (!value) return { id: 'title', status: 'fail', reason: 'missing', value: 0 };
  const n = [...value].length;
  if (n < TITLE_RANGE[0]) return { id: 'title', status: 'warn', reason: 'too_short', value: n };
  if (n > TITLE_RANGE[1]) return { id: 'title', status: 'warn', reason: 'too_long', value: n };
  return { id: 'title', status: 'pass', value: n };
}

/** Length of the description: the SEO description, else the excerpt or description (as the projection picks it). */
export function descriptionCheck(data: Record<string, unknown>, readable: (f: string) => boolean): Check {
  const sources = ['seo_description', 'excerpt', 'description'];
  if (!sources.some(readable)) return { id: 'description', status: 'no_permission' };
  const value = sources.filter(readable).map((f) => str(data[f])).find(Boolean) ?? '';
  if (!value) {
    // The missing value may be one the caller cannot see.
    if (!sources.every(readable)) return { id: 'description', status: 'no_permission' };
    return { id: 'description', status: 'warn', reason: 'missing', value: 0 };
  }
  const n = [...value].length;
  if (n < DESCRIPTION_RANGE[0]) return { id: 'description', status: 'warn', reason: 'too_short', value: n };
  if (n > DESCRIPTION_RANGE[1]) return { id: 'description', status: 'warn', reason: 'too_long', value: n };
  return { id: 'description', status: 'pass', value: n };
}

/** Whether the page will be indexed: the item's robots field over the site's settings. */
export function indexingCheck(data: Record<string, unknown>, readable: (f: string) => boolean, settings: SiteSeoSettings, collection: string): Check {
  if (!readable('seo_robots')) return { id: 'indexing', status: 'no_permission' };
  const decided = decideIndexing({ settings, pageType: pageTypeOfCollection(collection), collection, itemRobots: data.seo_robots });
  return decided.indexable ? { id: 'indexing', status: 'pass' } : { id: 'indexing', status: 'warn', reason: `noindex_by_${decided.decidedBy}` };
}

/** `<img>` without a text alternative in rich text. */
export function imagesCheck(html: string[]): Check {
  const missing: string[] = [];
  const visit = (nodes: unknown[]) => {
    for (const node of nodes as Array<{ tagName?: string; attrs?: Array<{ name: string; value: string }>; childNodes?: unknown[] }>) {
      if (node.tagName === 'img') {
        const alt = node.attrs?.find((a) => a.name === 'alt');
        if (!alt || !alt.value.trim()) missing.push(node.attrs?.find((a) => a.name === 'src')?.value ?? '');
      }
      if (node.childNodes) visit(node.childNodes);
    }
  };
  for (const h of html) visit(parseFragment(h).childNodes as unknown[]);
  return missing.length
    ? { id: 'images', status: 'warn', reason: 'missing_alt', value: missing.length, items: missing.map((url) => ({ url, status: 'no_alt' as const })) }
    : { id: 'images', status: 'pass' };
}

export type ResolvePath = (host: string, path: string) => Promise<PublicPathResult>;

/** Links of rich text: internal ones resolved in the database, external ones not checked. */
export async function linksCheck(html: string[], base: string | null, ownHosts: ReadonlySet<string>, resolve: ResolvePath): Promise<Check> {
  const found = new Map<string, { host: string; path: string; internal: boolean }>();
  for (const h of html) {
    for (const l of linksOf(h, base ?? 'https://unresolved.invalid/')) {
      const u = new URL(l.url);
      const host = u.hostname.toLowerCase();
      const relativeWithoutBase = !base && host === 'unresolved.invalid';
      found.set(l.url, { host, path: u.pathname, internal: ownHosts.has(host) || relativeWithoutBase });
    }
  }
  if (found.size === 0) return { id: 'links', status: 'pass', value: 0 };
  const items: NonNullable<Check['items']> = [];
  for (const [url, l] of found) {
    if (!l.internal) {
      items.push({ url, status: 'not_checked' });
      continue;
    }
    if (l.host === 'unresolved.invalid') {
      items.push({ url: l.path, status: 'not_checked' });
      continue;
    }
    const r = await resolve(l.host, l.path);
    items.push({ url, status: r.kind === 'item' ? 'ok' : r.kind === 'redirect' ? 'redirected' : 'broken' });
  }
  const broken = items.filter((i) => i.status === 'broken').length;
  return {
    id: 'links',
    status: broken ? 'fail' : 'pass',
    ...(broken ? { reason: 'broken_internal' } : {}),
    value: items.length,
    items,
  };
}

export interface ChecksInput {
  db: Database;
  siteId: string;
  collection: string;
  /** The item as the caller may read it (fields masked). */
  item: { id: string; status: string; data: Record<string, unknown> };
  /** The caller's read grant's field list. */
  readFields: string[];
  resolve: ResolvePath;
}

export async function publishChecks(input: ChecksInput): Promise<Check[]> {
  const { db, siteId, collection, item } = input;
  const ctx = await runSiteTransaction(db, siteId, async (tx) => {
    const [coll] = await tx.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, collection)));
    const defs = coll ? await tx.select({ name: fieldsTable.name, interface: fieldsTable.interface }).from(fieldsTable).where(eq(fieldsTable.collectionId, coll.id)) : [];
    const [seo] = await tx.select({ settings: siteSeoSettings.settings }).from(siteSeoSettings).where(eq(siteSeoSettings.siteId, siteId));
    const domains = await tx
      .select({ hostname: siteDomains.hostname, isPrimary: siteDomains.isPrimary })
      .from(siteDomains)
      .where(and(eq(siteDomains.siteId, siteId), eq(siteDomains.status, 'active')));
    return { defs, settings: effectiveSeoSettings(seo?.settings), domains };
  });
  const known = [...new Set([...ctx.defs.map((d) => d.name), 'title', 'seo_title', 'seo_description', 'excerpt', 'description', 'seo_robots'])];
  const allowed = new Set(applyFieldMask(known, input.readFields));
  const readable = (f: string) => allowed.has(f);
  const rich = ctx.defs.filter((d) => d.interface === RICH_TEXT && readable(d.name)).map((d) => item.data[d.name]).filter((v): v is string => typeof v === 'string' && v.length > 0);
  const primary = ctx.domains.find((d) => d.isPrimary) ?? ctx.domains[0];
  const base = primary ? `https://${primary.hostname.toLowerCase()}/` : null;
  const hosts = new Set(ctx.domains.map((d) => d.hostname.toLowerCase()));
  const richHidden = ctx.defs.some((d) => d.interface === RICH_TEXT && !readable(d.name));
  const links = await linksCheck(rich, base, hosts, input.resolve);
  const images = imagesCheck(rich);
  return [
    titleCheck(item.data, readable),
    descriptionCheck(item.data, readable),
    indexingCheck(item.data, readable, ctx.settings, collection),
    // Structured data is generated from the page when it is published; a published item's checks come from the audit.
    { id: 'structured_data', status: 'not_checked', reason: item.status === 'published' ? 'see_audit' : 'generated_on_publish' },
    richHidden && rich.length === 0 ? { id: 'links', status: 'no_permission' } : links,
    richHidden && rich.length === 0 ? { id: 'images', status: 'no_permission' } : images,
  ];
}
