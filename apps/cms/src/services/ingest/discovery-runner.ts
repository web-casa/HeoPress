import { and, eq } from 'drizzle-orm';
import { ingestDiscoveredUrls, ingestSourceCursors, type DiscoveryCursor } from '@heopress/database';
import { runSiteTransaction } from '../rls-transaction';
import { maybeGunzip, parseFeed, parseListPage, parseSitemap, type DiscoveredLink, type DiscoveredPage } from './discover';
import { classifyFetchFailure, IngestFetchError } from './failure';
import { fetchPage } from './fetcher';
import { assertOwnership, StaleRunError } from './source-documents';
import type { RunStats } from './source-service';
import { SourceRunError, type SourceRunContext } from './source-worker';
import type { IngestRunnerDeps } from './url-runner';
import { DEFAULT_TRACKING_PARAMS, normalizeUrl } from './url-normalize';

/**
 * Discovery with bounded pagination and backfill (HeoPress P08 tasks 1.3, 2.8; spec ingest/crawling "有界分页与断点续采").
 *
 * A run of an `rss` / `atom` / `sitemap` / `list_page` source fetches its listing through the native fetcher — the same
 * outbound boundary, robots.txt and per-host limits as an article, checked again on every page and every redirect —
 * and records each link it finds once per site (`ingest_discovered_urls`, keyed by the normalised URL). Only a new URL
 * becomes a fetch job (queue `ingest-fetch`, singleton per site and URL) that runs the document pipeline of
 * `url-runner.ts`. At most `maxItemsPerRun` new URLs per run; the rest stay unrecorded and are new next time.
 *
 * Pagination (list-page "next", Atom `rel="next"`) and sitemap-index recursion are capped by pages, duration, bytes,
 * discovered links and an external quota; a page seen before in the run is a cycle and ends the walk. The reason is
 * kept on the run (`stop_reason`). Progress is a cursor with two halves: the **attempt** cursor moves before a page is
 * fetched, the **success** cursor only after its links are recorded; a failure never moves the success cursor. A list
 * page source that stopped before the end of its listing resumes from the success cursor once the head of the listing
 * is caught up (backfill). Every cursor and link write checks the run's generation in its transaction: a worker that
 * lost its run (lease lapsed, taken over) gets `StaleRunError` and writes nothing.
 */

export interface DiscoveryLimits {
  maxPages: number;
  maxDurationMs: number;
  maxBytes: number;
  /** Links read per run, new or not. */
  maxDiscovered: number;
  /** Nesting of sitemap indexes. */
  maxSitemapDepth: number;
}

const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = {
  maxPages: 10,
  maxDurationMs: 120_000,
  maxBytes: 20 * 1024 * 1024,
  maxDiscovered: 5000,
  maxSitemapDepth: 3,
};

/** An external budget (e.g. a crawl service's monthly quota): one unit per listing page. */
export interface DiscoveryQuota {
  take(siteId: string, sourceId: string): Promise<boolean>;
}

export interface FetchJobPayload {
  siteId: string;
  sourceId: string;
  runId: string;
  scheduledFor: string;
  discoveredId: string;
  url: string;
  normalizedUrl: string;
}

export const FETCH_QUEUE = 'ingest-fetch';

const FEED_TYPES = /^(application\/(rss\+xml|atom\+xml|rdf\+xml|xml|x-gzip|gzip|octet-stream)|text\/xml|text\/plain)\b/i;
const HTML = /^(text\/html|application\/xhtml\+xml)\b/i;

async function writeCursor(deps: IngestRunnerDeps, ctx: SourceRunContext, half: 'attempt' | 'success', cursor: DiscoveryCursor): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await runSiteTransaction(deps.db, ctx.siteId, async (tx) => {
    await assertOwnership(tx, ctx.siteId, { runId: ctx.runId, generation: ctx.generation });
    const values =
      half === 'attempt' ? { attemptCursor: cursor, attemptRunId: ctx.runId, attemptAt: now } : { successCursor: cursor, successRunId: ctx.runId, successAt: now };
    await tx
      .insert(ingestSourceCursors)
      .values({ siteId: ctx.siteId, sourceId: ctx.source.id, ...values })
      .onConflictDoUpdate({ target: [ingestSourceCursors.siteId, ingestSourceCursors.sourceId], set: values });
  });
}

async function loadSuccessCursor(deps: IngestRunnerDeps, ctx: SourceRunContext): Promise<DiscoveryCursor | null> {
  const [row] = await runSiteTransaction(deps.db, ctx.siteId, (tx) =>
    tx
      .select({ success: ingestSourceCursors.successCursor })
      .from(ingestSourceCursors)
      .where(and(eq(ingestSourceCursors.siteId, ctx.siteId), eq(ingestSourceCursors.sourceId, ctx.source.id))),
  );
  return row?.success ?? null;
}

type Registered = { kind: 'new'; payload: FetchJobPayload } | { kind: 'seen' } | { kind: 'refused' };

/** Record one discovered link for the site; a URL already known (or a tracking variant of one) is `seen`. */
async function registerLink(deps: IngestRunnerDeps, ctx: SourceRunContext, link: DiscoveredLink, params: readonly string[]): Promise<Registered> {
  const normalized = normalizeUrl(link.url, params);
  let refusal: string | null = null;
  if (!normalized) refusal = 'only http and https URLs are fetched';
  else if (new URL(normalized).username || new URL(normalized).password) refusal = 'URL carries credentials';
  const key = normalized ?? link.url.slice(0, 2000);
  return runSiteTransaction(deps.db, ctx.siteId, async (tx) => {
    await assertOwnership(tx, ctx.siteId, { runId: ctx.runId, generation: ctx.generation });
    const [row] = await tx
      .insert(ingestDiscoveredUrls)
      .values({
        siteId: ctx.siteId,
        sourceId: ctx.source.id,
        normalizedUrl: key,
        url: link.url.slice(0, 2000),
        title: link.title?.slice(0, 500) ?? null,
        runId: ctx.runId,
        status: refusal ? 'refused' : 'queued',
        reason: refusal,
      })
      .onConflictDoNothing({ target: [ingestDiscoveredUrls.siteId, ingestDiscoveredUrls.normalizedUrl] })
      .returning({ id: ingestDiscoveredUrls.id });
    let id = row?.id;
    if (!id && !refusal) {
      // Known: fetch it again only when its last fetch failed for a technical reason.
      const [retry] = await tx
        .update(ingestDiscoveredUrls)
        .set({ status: 'queued', reason: null, runId: ctx.runId, updatedAt: deps.now?.() ?? new Date() })
        .where(and(eq(ingestDiscoveredUrls.siteId, ctx.siteId), eq(ingestDiscoveredUrls.normalizedUrl, key), eq(ingestDiscoveredUrls.status, 'failed')))
        .returning({ id: ingestDiscoveredUrls.id });
      id = retry?.id;
    }
    if (!id) return { kind: 'seen' as const };
    if (refusal) return { kind: 'refused' as const };
    return {
      kind: 'new' as const,
      payload: { siteId: ctx.siteId, sourceId: ctx.source.id, runId: ctx.runId, scheduledFor: ctx.scheduledFor, discoveredId: id, url: link.url, normalizedUrl: key },
    };
  });
}

function parse(type: string, body: Buffer, base: string, ctx: SourceRunContext, maxBytes: number): DiscoveredPage {
  if (type === 'list_page') {
    const selectors = ctx.source.listSelectors;
    if (!selectors) throw new IngestFetchError('extraction', 'the list page source has no selectors');
    return parseListPage(body.toString('utf8'), base, selectors);
  }
  const xml = maybeGunzip(body, maxBytes).toString('utf8');
  return type === 'sitemap' ? parseSitemap(xml, base) : parseFeed(xml, base);
}

/**
 * Run discovery for a source. `onNew` receives each new URL's fetch job (enqueue it, or fetch inline). Returns the
 * run's stats; throws `SourceRunError` when the first page cannot be read, `StaleRunError` when the run was lost.
 */
export async function discoverSource(
  deps: IngestRunnerDeps,
  ctx: SourceRunContext,
  onNew: (payload: FetchJobPayload) => Promise<void>,
): Promise<{ itemsFound: number; stats: RunStats }> {
  const limits = { ...DEFAULT_DISCOVERY_LIMITS, ...deps.limits };
  const params = deps.dedup?.trackingParams ?? DEFAULT_TRACKING_PARAMS;
  const type = ctx.source.type;
  const started = Date.now();
  const stats: RunStats = { discovered: 0, new: 0, duplicate: 0, stopReason: null };
  const visited = new Set<string>();
  const stop = (reason: string) => {
    stats.stopReason ??= reason;
  };

  const saved = type === 'list_page' ? await loadSuccessCursor(deps, ctx) : null;
  let resumeFrom = saved && !saved.caughtUp && saved.next ? saved.next : null;
  let chain: 'head' | 'backfill' = 'head';
  const pending: Array<{ url: string; depth: number }> = [{ url: ctx.source.url, depth: 0 }];
  let pages = 0;
  let bytes = 0;

  walk: while (pending.length) {
    const task = pending.shift()!;
    const norm = normalizeUrl(task.url, params);
    if (!norm) {
      stop('invalid_url');
      continue;
    }
    if (visited.has(norm)) {
      stop('cycle');
      continue;
    }
    if (pages >= limits.maxPages) {
      stop('max_pages');
      break;
    }
    if (Date.now() - started >= limits.maxDurationMs) {
      stop('max_duration');
      break;
    }
    if (bytes >= limits.maxBytes) {
      stop('max_bytes');
      break;
    }
    if (stats.new >= ctx.maxItems) {
      stop('max_items');
      break;
    }
    if (deps.quota && !(await deps.quota.take(ctx.siteId, ctx.source.id))) {
      if (pages === 0) throw new SourceRunError('quota', 'the discovery quota is exhausted', stats);
      stop('quota');
      break;
    }
    visited.add(norm);
    await writeCursor(deps, ctx, 'attempt', { page: norm, next: null, caughtUp: false });

    let parsed: DiscoveredPage;
    let finalUrl: string;
    try {
      const page = await fetchPage(task.url, {
        ...deps.fetch,
        limiter: deps.limiter ?? null,
        signal: ctx.signal,
        accept: type === 'list_page' ? HTML : FEED_TYPES,
        maxBytes: Math.max(1, Math.min(deps.fetch?.maxBytes ?? 5 * 1024 * 1024, limits.maxBytes - bytes)),
      });
      pages++;
      bytes += page.body.byteLength;
      finalUrl = page.finalUrl;
      parsed = parse(type, page.body, finalUrl, ctx, limits.maxBytes);
    } catch (err) {
      if (err instanceof StaleRunError) throw err;
      const verdict = classifyFetchFailure(err);
      const message = err instanceof Error ? err.message : String(err);
      if (pages === 0 && !stats.discovered) throw new SourceRunError(verdict.category, message, stats);
      stop(`fetch_failed:${verdict.category}`);
      break;
    }

    let pageNew = 0;
    let pageSeen = 0;
    for (const link of parsed.links) {
      if (stats.discovered >= limits.maxDiscovered) {
        stop('max_discovered');
        break walk;
      }
      if (stats.new >= ctx.maxItems) {
        stop('max_items');
        break;
      }
      stats.discovered++;
      const r = await registerLink(deps, ctx, link, params);
      if (r.kind === 'new') {
        stats.new++;
        pageNew++;
        await onNew(r.payload);
      } else if (r.kind === 'seen') {
        stats.duplicate++;
        pageSeen++;
      }
    }
    const listingDone = stats.new >= ctx.maxItems && stats.stopReason === 'max_items';

    if (type === 'sitemap') {
      if (task.depth < limits.maxSitemapDepth) for (const c of parsed.children) pending.push({ url: c, depth: task.depth + 1 });
      else if (parsed.children.length) stop('max_depth');
      await writeCursor(deps, ctx, 'success', { page: norm, next: null, caughtUp: true });
      continue;
    }

    // A page whose links were cut off (max items) is not done: the success cursor stays where it was.
    if (listingDone) break;
    const next = parsed.next ? normalizeUrl(parsed.next, params) : null;
    if (chain === 'backfill' || !resumeFrom) await writeCursor(deps, ctx, 'success', { page: norm, next, caughtUp: !next });
    const caughtUp = pageNew === 0 && pageSeen > 0;
    if (caughtUp && chain === 'head') {
      if (resumeFrom) {
        pending.length = 0;
        pending.push({ url: resumeFrom, depth: 0 });
        resumeFrom = null;
        chain = 'backfill';
        continue;
      }
      await writeCursor(deps, ctx, 'success', { page: norm, next: null, caughtUp: true });
      break;
    }
    if (next) pending.push({ url: next, depth: 0 });
  }
  return { itemsFound: stats.new, stats };
}
