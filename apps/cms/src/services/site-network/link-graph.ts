import { and, asc, eq, gt, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { linkEdges, linkScans, publicItems, siteDomains, sites, type Database } from '@heopress/database';
import { linksOf, pathOf, type SitePathSpace } from '@heopress/public-site';
import type { EventConsumerDefinition } from '../../modules/events/consumer-runner';
import { runSiteTransaction } from '../rls-transaction';
import { loadSpace } from './site-rules';

/**
 * The internal link graph (HeoPress P07 task 5.3; spec seo/link-graph "站内链接图"): the links of every public item's rich
 * text that point into the site, one row each (`lumibase_link_edges`), with where they are (item, field, position) and where
 * they point (as written, and in the site's content space).
 *
 *   - Only the public projection is read: a draft, an unpublished or deleted item has no edges (its own are removed when it
 *     stops being public), and a field the public cannot see is never read.
 *   - A change of an item (its event) replaces that item's edges, and only those. What a link points to now is not stored:
 *     the reports work it out (`link-report.ts`), so a target that goes away needs no refresh of the pages linking to it.
 *   - A full scan (asked for by a change of the site's URL policy, its collections or fields, an administrator, or the daily
 *     check) goes through the public items in id order, a batch per transaction, the cursor saved with the batch; a failure
 *     or an interruption leaves the cursor where it was and the next run goes on from there. Only a finished scan removes
 *     the edges it did not find again (stamped before it started): a failed scan never empties the graph.
 */

type Tx = Parameters<Parameters<typeof runSiteTransaction>[2]>[0];

/** What a recorded anchor text and fragment keep at most. */
const MAX_TEXT = 200;
/** Items refreshed per scan transaction. */
const SCAN_BATCH = 100;
/** How long a worker holds a site's scan. */
const LEASE_MS = 2 * 60_000;
/** A site's graph is scanned again when its last full scan is older than this. */
const SCAN_PERIOD_MS = 24 * 60 * 60_000;

/** Change events of one item (its edges are refreshed). */
const ITEM_RESOURCES = new Set(['item', 'content_route']);
/** Change events that can move every link of the site (a full scan). */
const SITE_RESOURCES = new Set(['site_content_settings', 'collection', 'field']);

/** Where a site's links can point: its hosts (an alias host stands for the primary) and its content space. */
export interface SiteLinkSpace {
  /** Active hostname → the host its addresses are detected on. */
  hosts: Map<string, string>;
  space: SitePathSpace;
}

export async function siteLinkSpace(tx: Tx, siteId: string): Promise<SiteLinkSpace> {
  const domains = await tx
    .select({ hostname: siteDomains.hostname, isPrimary: siteDomains.isPrimary, entryLocale: siteDomains.entryLocale })
    .from(siteDomains)
    .where(and(eq(siteDomains.siteId, siteId), eq(siteDomains.status, 'active')));
  const primary = domains.find((d) => d.isPrimary)?.hostname.toLowerCase() ?? null;
  const space = await loadSpace(tx, siteId, primary ? { primaryHost: primary } : {});
  const hosts = new Map<string, string>();
  for (const d of domains) {
    const host = d.hostname.toLowerCase();
    // A plain alias (not primary, not a language entry) answers at the primary domain (the resolver's rule).
    hosts.set(host, !d.isPrimary && !d.entryLocale && primary ? primary : host);
  }
  return { hosts, space };
}

/** A URL's place in the site: its host as detected, its decoded bare path, and the language and content path there. */
export function siteTargetOf(link: SiteLinkSpace, url: string): { host: string; locale: string | null; contentPath: string | null } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = link.hosts.get(u.hostname.toLowerCase());
  if (!host) return null;
  const raw = u.pathname;
  const body = raw.length > 1 && raw.endsWith('/') ? raw.slice(1, -1) : raw.slice(1);
  const segments: string[] = [];
  if (body !== '') {
    for (const s of body.split('/')) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(s);
      } catch {
        return { host, locale: null, contentPath: null };
      }
      if (decoded === '' || decoded === '.' || decoded === '..' || decoded.includes('/')) return { host, locale: null, contentPath: null };
      segments.push(decoded);
    }
  }
  const at = link.space.detect({ host, path: pathOf(segments) });
  return { host, locale: at?.locale ?? null, contentPath: at?.contentPath ?? null };
}

/**
 * The internal links of a public item's rich text, as edge rows (the item's address is the base of relative links): every
 * one (Codex review of batch 10, round 1: a cap would make the reports wrong without saying so; the item's own size bounds
 * them).
 */
function edgesOf(
  siteId: string,
  row: { itemId: string; data: Record<string, unknown>; richFields: string[]; url: string | null },
  link: SiteLinkSpace,
): Array<typeof linkEdges.$inferInsert> {
  if (!row.url) return [];
  const out: Array<typeof linkEdges.$inferInsert> = [];
  for (const field of [...row.richFields].sort()) {
    const html = row.data[field];
    if (typeof html !== 'string' || !html) continue;
    for (const l of linksOf(html, row.url)) {
      const at = siteTargetOf(link, l.url);
      if (!at) continue; // external
      out.push({
        siteId,
        origin: 'auto',
        sourceItemId: row.itemId,
        field,
        position: l.position,
        // Whole (Codex review of batch 10, round 2: a cut address would be resolved elsewhere); the item's size bounds it.
        href: l.href,
        targetUrl: l.url,
        targetLocale: at.locale,
        targetPath: at.contentPath,
        fragment: l.fragment?.slice(0, MAX_TEXT) ?? null,
        anchorText: l.text.slice(0, MAX_TEXT),
      });
    }
  }
  return out;
}

/** One item at a time: the scan and a change of the same item never interleave their delete and insert. */
async function lockItem(tx: Tx, itemId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`link-graph:${itemId}`}, 0))`);
}

/**
 * Replace the automatic edges of `itemIds` (in the site's scope) by what their public rows hold now: none for an item that
 * is not public. Stamped with the transaction's time (a scan's clean-up compares it).
 */
export async function refreshItemLinks(tx: Tx, siteId: string, itemIds: string[], link?: SiteLinkSpace): Promise<number> {
  if (itemIds.length === 0) return 0;
  const ids = [...new Set(itemIds)].sort();
  for (const id of ids) await lockItem(tx, id);
  await tx.delete(linkEdges).where(and(eq(linkEdges.siteId, siteId), eq(linkEdges.origin, 'auto'), inArray(linkEdges.sourceItemId, ids)));
  const rows = await tx
    .select({ itemId: publicItems.itemId, data: publicItems.data, richFields: publicItems.richFields, url: sql<string | null>`${publicItems.card} ->> 'url'` })
    .from(publicItems)
    .where(and(eq(publicItems.siteId, siteId), inArray(publicItems.itemId, ids)));
  if (rows.every((r) => r.richFields.length === 0)) return 0;
  const space = link ?? (await siteLinkSpace(tx, siteId));
  const edges = rows.flatMap((r) => edgesOf(siteId, r, space));
  // In chunks (a statement's parameters are limited).
  for (let i = 0; i < edges.length; i += 500) await tx.insert(linkEdges).values(edges.slice(i, i + 500));
  return edges.length;
}

/** The `link-graph` consumer: a change of an item refreshes its edges; a change of the site's URL policy, collections or fields asks for a full scan. */
export function linkGraphConsumer(deps: { db: Database }): EventConsumerDefinition {
  return {
    name: 'link-graph',
    accepts: (e) => ITEM_RESOURCES.has(e.resource) || SITE_RESOURCES.has(e.resource),
    handle: async (event) => {
      if (SITE_RESOURCES.has(event.resource)) {
        await requestLinkScan(deps.db, event.siteId);
        return;
      }
      if (!event.itemId) return;
      await runSiteTransaction(deps.db, event.siteId, (tx) => refreshItemLinks(tx, event.siteId, [event.itemId]));
    },
  };
}

/**
 * Ask for a full scan of a site: started now, or — while one is running — run again once it has finished (what it already
 * went past may have changed). `now` (an administrator's request): a scan waiting out a failure is due at once, its error
 * cleared (Codex review of batch 10, round 2); the change events never do this (a failing scan would be retried at once).
 */
export async function requestLinkScan(db: Database | Tx, siteId: string, opts: { now?: boolean } = {}): Promise<void> {
  await db.execute(sql`
    INSERT INTO ${linkScans} (site_id, status, started_at) VALUES (${siteId}, 'running', now())
    ON CONFLICT (site_id) DO UPDATE SET
      rerun = ${linkScans.status} = 'running',
      started_at = CASE WHEN ${linkScans.status} = 'running' THEN ${linkScans.startedAt} ELSE now() END,
      cursor = CASE WHEN ${linkScans.status} = 'running' THEN ${linkScans.cursor} ELSE NULL END,
      processed = CASE WHEN ${linkScans.status} = 'running' THEN ${linkScans.processed} ELSE 0 END,
      finished_at = CASE WHEN ${linkScans.status} = 'running' THEN ${linkScans.finishedAt} ELSE NULL END,
      ${opts.now ? sql`retry_at = NULL, attempts = 0, last_error = NULL,` : sql``}
      status = 'running'`);
}

/** Ask for a scan of every site whose graph was never scanned, or not for a day (the daily check). */
export async function scheduleLinkScans(db: Database): Promise<number> {
  const due = await db
    .select({ id: sites.id })
    .from(sites)
    .leftJoin(linkScans, eq(linkScans.siteId, sites.id))
    .where(or(isNull(linkScans.siteId), and(eq(linkScans.status, 'done'), lt(linkScans.finishedAt, new Date(Date.now() - SCAN_PERIOD_MS)))))
    .orderBy(asc(sites.id));
  for (const { id } of due) await requestLinkScan(db, id);
  return due.length;
}

export interface LinkScanResult {
  siteId: string;
  status: 'done' | 'partial' | 'failed' | 'lost';
  processed: number;
  error?: string;
}

/** Take a running scan that is due and not held (or whose holder's lease ran out), with a lease token. */
async function takeScan(db: Database, skip: string[]): Promise<{ siteId: string; token: string } | null> {
  const token = randomUUID();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ siteId: linkScans.siteId })
      .from(linkScans)
      .where(
        and(
          eq(linkScans.status, 'running'),
          or(isNull(linkScans.retryAt), lte(linkScans.retryAt, sql`now()`)),
          or(isNull(linkScans.leasedUntil), lt(linkScans.leasedUntil, sql`now()`)),
          skip.length ? notInArray(linkScans.siteId, skip) : undefined,
        ),
      )
      // The longest waiting first: a scan that ran out of budget waits from then (`retry_at`), behind those already waiting
      // (Codex review of batch 10, round 1: a large site's scan never starves the others).
      .orderBy(sql`coalesce(${linkScans.retryAt}, ${linkScans.startedAt})`, asc(linkScans.siteId))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!row) return null;
    await tx
      .update(linkScans)
      .set({ leaseToken: token, leasedUntil: sql`now() + ${`${LEASE_MS} milliseconds`}::interval` })
      .where(eq(linkScans.siteId, row.siteId));
    return { siteId: row.siteId, token };
  });
}

/** Whether this worker still holds the scan (locks the row for the batch's transaction); renews the lease. */
async function holds(tx: Tx, siteId: string, token: string) {
  const [row] = await tx
    .select({ startedAt: linkScans.startedAt, cursor: linkScans.cursor, rerun: linkScans.rerun })
    .from(linkScans)
    .where(and(eq(linkScans.siteId, siteId), eq(linkScans.leaseToken, token), eq(linkScans.status, 'running')))
    .for('update');
  if (!row) return null;
  await tx
    .update(linkScans)
    .set({ leasedUntil: sql`now() + ${`${LEASE_MS} milliseconds`}::interval` })
    .where(eq(linkScans.siteId, siteId));
  return row;
}

export interface LinkScanOptions {
  batchSize?: number;
  /** Stop taking batches after this long (the next run goes on). */
  budgetMs?: number;
  /** Test hook: called before each batch's refresh (a throw fails the batch). */
  beforeBatch?: (siteId: string, itemIds: string[]) => Promise<void> | void;
  /** Test hook: called after each batch is committed. */
  afterBatch?: (siteId: string) => Promise<void> | void;
}

/** Run one site's scan from its cursor, a batch per transaction, until done, out of budget, or failed. */
async function runScan(db: Database, siteId: string, token: string, opts: LinkScanOptions, deadline: number): Promise<LinkScanResult> {
  const batchSize = opts.batchSize ?? SCAN_BATCH;
  let processed = 0;
  try {
    for (;;) {
      if (Date.now() > deadline) {
        // Out of budget: it goes on later, after the scans already waiting.
        await db.update(linkScans).set({ retryAt: sql`now()` }).where(and(eq(linkScans.siteId, siteId), eq(linkScans.leaseToken, token)));
        return { siteId, status: 'partial', processed };
      }
      const step = await runSiteTransaction(
        db,
        siteId,
        async (tx) => {
          const scan = await holds(tx, siteId, token);
          if (!scan) return 'lost' as const;
          const ids = (
            await tx
              .select({ id: publicItems.itemId })
              .from(publicItems)
              .where(and(eq(publicItems.siteId, siteId), scan.cursor ? gt(publicItems.itemId, scan.cursor) : undefined))
              .orderBy(asc(publicItems.itemId))
              .limit(batchSize)
          ).map((r) => r.id);
          if (ids.length > 0) {
            await opts.beforeBatch?.(siteId, ids);
            await refreshItemLinks(tx, siteId, ids);
            await tx
              .update(linkScans)
              .set({ cursor: ids[ids.length - 1]!, processed: sql`${linkScans.processed} + ${ids.length}`, attempts: 0, lastError: null })
              .where(eq(linkScans.siteId, siteId));
            processed += ids.length;
            return 'more' as const;
          }
          // Finished: the edges not stamped since the scan started belong to items no longer public (or links gone).
          await tx.delete(linkEdges).where(and(eq(linkEdges.siteId, siteId), eq(linkEdges.origin, 'auto'), lt(linkEdges.refreshedAt, scan.startedAt)));
          if (scan.rerun) {
            await tx
              .update(linkScans)
              .set({ rerun: false, startedAt: sql`now()`, cursor: null, processed: 0 })
              .where(eq(linkScans.siteId, siteId));
            return 'more' as const;
          }
          await tx
            .update(linkScans)
            .set({ status: 'done', finishedAt: sql`now()`, leaseToken: null, leasedUntil: null, attempts: 0, lastError: null, retryAt: null })
            .where(eq(linkScans.siteId, siteId));
          return 'done' as const;
        },
        { retry: false },
      );
      if (step === 'lost') return { siteId, status: 'lost', processed };
      if (step === 'done') return { siteId, status: 'done', processed };
      await opts.afterBatch?.(siteId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : 'scan failed';
    // The batch was rolled back: the cursor stays, the graph as it was; tried again later.
    await db
      .update(linkScans)
      .set({
        attempts: sql`${linkScans.attempts} + 1`,
        lastError: message,
        // A minute, doubling with each failure in a row, at most an hour.
        retryAt: sql`now() + make_interval(secs => least(3600, 60 * power(2, ${linkScans.attempts})))`,
        leaseToken: null,
        leasedUntil: null,
      })
      .where(and(eq(linkScans.siteId, siteId), eq(linkScans.leaseToken, token)));
    return { siteId, status: 'failed', processed, error: message };
  } finally {
    // Out of budget: the lease is given back (the cursor is saved).
    await db
      .update(linkScans)
      .set({ leaseToken: null, leasedUntil: null })
      .where(and(eq(linkScans.siteId, siteId), eq(linkScans.leaseToken, token), eq(linkScans.status, 'running')));
  }
}

/** The worker: the due scans, one site at a time, within the budget. */
export async function processLinkScans(db: Database, opts: LinkScanOptions = {}): Promise<LinkScanResult[]> {
  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  const results: LinkScanResult[] = [];
  while (Date.now() <= deadline) {
    // A site once per run: the others get their turn even while one has a long scan.
    const taken = await takeScan(db, results.map((r) => r.siteId));
    if (!taken) break;
    results.push(await runScan(db, taken.siteId, taken.token, opts, deadline));
  }
  return results;
}

/** Registered links per site at most, and a label's length. */
const MAX_MANUAL_LINKS = 500;
const MAX_LABEL = 120;

export class LinkGraphError extends Error {
  constructor(
    readonly code: 'INVALID_LABEL' | 'NOT_ON_SITE' | 'TOO_MANY' | 'NOT_FOUND',
    message: string,
    readonly status: 400 | 404 | 409,
  ) {
    super(message);
  }
}

export interface ManualLink {
  id: string;
  label: string;
  url: string;
  createdBy: string | null;
  createdAt: string;
}

/**
 * The administrators' registered links (spec seo/link-graph: an edge is found or registered): the site's navigation, which
 * the content does not hold — a theme's menu, a footer. Each names where it is (`label`) and an address on the site's own
 * hosts; the orphan report counts them apart from the content's links.
 */
export async function listManualLinks(db: Database, siteId: string): Promise<ManualLink[]> {
  const rows = await runSiteTransaction(db, siteId, (tx) =>
    tx
      .select()
      .from(linkEdges)
      .where(and(eq(linkEdges.siteId, siteId), eq(linkEdges.origin, 'manual')))
      .orderBy(asc(linkEdges.sourceLabel), asc(linkEdges.targetUrl), asc(linkEdges.id)),
  );
  return rows.map((r) => ({ id: r.id, label: r.sourceLabel ?? '', url: r.targetUrl, createdBy: r.createdBy, createdAt: r.refreshedAt.toISOString() }));
}

export async function addManualLink(db: Database, siteId: string, input: { label: unknown; url: unknown }, createdBy: string | null): Promise<ManualLink> {
  const label = typeof input.label === 'string' ? input.label.replace(/\s+/g, ' ').trim() : '';
  if (!label || label.length > MAX_LABEL) throw new LinkGraphError('INVALID_LABEL', `A label of 1 to ${MAX_LABEL} characters is required.`, 400);
  return runSiteTransaction(db, siteId, async (tx) => {
    let url: URL | null = null;
    try {
      url = typeof input.url === 'string' ? new URL(input.url) : null;
    } catch {
      url = null;
    }
    const link = await siteLinkSpace(tx, siteId);
    const at = url && (url.protocol === 'https:' || url.protocol === 'http:') ? siteTargetOf(link, url.toString()) : null;
    if (!url || !at) throw new LinkGraphError('NOT_ON_SITE', 'The address must be on one of the site\'s active domains.', 400);
    // One count at a time (two registrations cannot both pass the limit).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`link-graph-manual:${siteId}`}, 0))`);
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(linkEdges)
      .where(and(eq(linkEdges.siteId, siteId), eq(linkEdges.origin, 'manual')))) as [{ n: number }];
    if (n >= MAX_MANUAL_LINKS) throw new LinkGraphError('TOO_MANY', `A site registers ${MAX_MANUAL_LINKS} links at most.`, 409);
    const fragment = url.hash.length > 1 ? url.hash.slice(1) : null;
    url.hash = '';
    const [row] = await tx
      .insert(linkEdges)
      .values({
        siteId,
        origin: 'manual',
        sourceLabel: label,
        href: url.toString(),
        targetUrl: url.toString(),
        targetLocale: at.locale,
        targetPath: at.contentPath,
        fragment,
        createdBy,
      })
      .returning();
    return { id: row!.id, label, url: row!.targetUrl, createdBy, createdAt: row!.refreshedAt.toISOString() };
  });
}

export async function deleteManualLink(db: Database, siteId: string, id: string): Promise<void> {
  const gone = await runSiteTransaction(db, siteId, (tx) =>
    tx
      .delete(linkEdges)
      .where(and(eq(linkEdges.siteId, siteId), eq(linkEdges.origin, 'manual'), eq(linkEdges.id, id)))
      .returning({ id: linkEdges.id }),
  );
  if (gone.length === 0) throw new LinkGraphError('NOT_FOUND', 'No such registered link.', 404);
}

/** A site's scan as an administrator sees it. */
export async function linkScanOf(db: Database, siteId: string) {
  const [row] = await db.select().from(linkScans).where(eq(linkScans.siteId, siteId));
  return row
    ? { status: row.status, startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt?.toISOString() ?? null, processed: row.processed, rerun: row.rerun, lastError: row.lastError }
    : null;
}
