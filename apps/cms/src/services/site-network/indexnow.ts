import { and, asc, eq, inArray, isNull, lt, lte, notInArray, or, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import {
  indexNowQueue,
  indexNowSites,
  indexNowState,
  publicHosts,
  publicItems,
  siteSeoSettings,
  sites,
  type Database,
} from '@heopress/database';
import { effectiveSeoSettings, type SiteSeoSettings } from '@heopress/contracts/schemas';
import { absoluteUrl, decideIndexing, pageTypeOfCollection } from '@heopress/seo-geo';
import type { EventConsumerDefinition } from '../../modules/events/consumer-runner';
import { guardedFetch } from '../ssrf-guard';
import { runSiteTransaction } from '../rls-transaction';

/**
 * IndexNow (HeoPress P07 tasks 3.4, 3.6; spec seo/crawl-discovery "IndexNow 推送"): a site that turns it on tells the
 * search engines which of its URLs changed — published, updated, unpublished, moved, deleted, no longer indexed — and
 * nothing else (a theme, an SEO field: no notice).
 *
 *   - The event consumer only queues the site (one row per change event, the event's id unique: an event delivered
 *     twice is queued once) and acknowledges the event; it never waits on a search engine.
 *   - The worker takes a site whose rows are due (a 10-second window gathers a burst of changes), holds the site's lease,
 *     and works out what changed: the public projection's listable URLs (indexable, canonical to themselves) and their
 *     content fingerprints, against what IndexNow was last told (`lumibase_indexnow_state`). New or changed URLs are
 *     pushed; URLs that are no longer listable are pushed once more (the engines then fetch a 404, a 410 or a noindex)
 *     and forgotten. The first pass of a site only records what is there (what was public before IndexNow was on is not
 *     news).
 *   - Every URL must be on one of the site's current public hosts (from the projection, never from the queue); a request
 *     holds one host's URLs, at most 10,000; it goes only to the site's chosen official endpoint, without following
 *     redirects. A failure or a timeout (outcome unknown) leaves the state as it was: the next pass sends it again.
 *   - The reconciliation job queues every site with IndexNow on, periodically: changes whose events were lost are found
 *     by the same comparison.
 */

/** The window a burst of changes is gathered in. */
const INDEXNOW_WINDOW_MS = 10_000;
/** URLs in one request at most (the protocol's limit). */
const INDEXNOW_MAX_URLS = 10_000;
/** How long a worker holds a site. */
const LEASE_MS = 3 * 60_000;
/** How long one request may take; past it the outcome is unknown and the next pass sends it again. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Retry delays after a failure: 30 s doubling, at most an hour. */
const retryDelayMs = (attempts: number) => Math.min(60 * 60_000, 30_000 * 2 ** Math.max(0, attempts - 1));

/** Change events that can change a site's public URLs. */
const RESOURCES = new Set(['item', 'content_route', 'redirect', 'site_content_settings', 'site_seo_settings', 'translation_group', 'collection', 'field']);

type Tx = Parameters<Parameters<typeof runSiteTransaction>[2]>[0];

const indexNowOn = (s: SiteSeoSettings) => s.discovery.indexNow && !!s.discovery.indexNowKey;

/** The site's SEO settings with their defaults, in its scope (read here: this module depends on no projection writer). */
async function seoSettingsOf(tx: Tx, siteId: string): Promise<SiteSeoSettings> {
  const [row] = await tx.select({ settings: siteSeoSettings.settings }).from(siteSeoSettings).where(eq(siteSeoSettings.siteId, siteId));
  return effectiveSeoSettings(row?.settings);
}

/** Queue a site's IndexNow pass for `eventId` (once per id), due after the window. */
export async function enqueueIndexNow(db: Database | Tx, siteId: string, eventId: string, now = new Date()): Promise<void> {
  await db
    .insert(indexNowQueue)
    .values({ siteId, eventId, dueAt: new Date(now.getTime() + INDEXNOW_WINDOW_MS) })
    .onConflictDoNothing({ target: indexNowQueue.eventId });
}

/** The `indexnow` consumer: a change that may move a site's public URLs queues that site (when IndexNow is on). */
export function indexNowConsumer(deps: { db: Database }): EventConsumerDefinition {
  return {
    name: 'indexnow',
    accepts: (e) => RESOURCES.has(e.resource),
    handle: async (event) => {
      await runSiteTransaction(deps.db, event.siteId, async (tx) => {
        // Turned on by this very event, or already on: queued. Off: nothing to tell.
        if (!indexNowOn(await seoSettingsOf(tx, event.siteId))) return;
        await enqueueIndexNow(tx, event.siteId, `event:${event.id}`);
      });
    },
  };
}

/**
 * Queue every site with IndexNow on (the reconciliation job, task 3.6): what changed without an event reaching the
 * consumer is found by the pass's comparison. One row per site and period.
 */
export async function scheduleIndexNowReconciliation(db: Database, now = new Date(), periodMs = 15 * 60_000): Promise<number> {
  const bucket = Math.floor(now.getTime() / periodMs);
  let queued = 0;
  for (const { id } of await db.select({ id: sites.id }).from(sites).orderBy(asc(sites.id))) {
    await runSiteTransaction(db, id, async (tx) => {
      if (!indexNowOn(await seoSettingsOf(tx, id))) return;
      await tx
        .insert(indexNowQueue)
        .values({ siteId: id, eventId: `reconcile:${id}:${bucket}`, dueAt: now })
        .onConflictDoNothing({ target: indexNowQueue.eventId });
      queued++;
    });
  }
  return queued;
}

export interface IndexNowDeps {
  /** The HTTP client (default: the SSRF-guarded fetch). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => Date;
}

export interface IndexNowPassResult {
  siteId: string;
  status: 'pushed' | 'seeded' | 'nothing' | 'off' | 'failed';
  urls: number;
  requests: number;
  error?: string;
}

/** The site's listable URLs and their content fingerprints, and its public hosts. In the site's scope. */
async function currentOf(tx: Tx, siteId: string, settings: SiteSeoSettings) {
  const hosts = new Set(
    (await tx.select({ h: publicHosts.hostname }).from(publicHosts).where(eq(publicHosts.siteId, siteId))).map((r) => r.h.toLowerCase()),
  );
  const rows = await tx
    .select({
      collection: publicItems.collection,
      seoRobots: publicItems.seoRobots,
      url: sql<string | null>`${publicItems.card} ->> 'url'`,
      canonical: sql<string | null>`${publicItems.data} ->> 'canonical_url'`,
      contentHash: publicItems.contentHash,
    })
    .from(publicItems)
    .where(eq(publicItems.siteId, siteId));
  const listed = new Map<string, string>();
  for (const r of rows) {
    const url = absoluteUrl(r.url);
    if (!url || !decideIndexing({ settings, pageType: pageTypeOfCollection(r.collection), collection: r.collection, itemRobots: r.seoRobots }).indexable) continue;
    // Canonical to another address: a declared duplicate, listed nowhere (the discovery outputs' rule).
    const override = absoluteUrl(r.canonical);
    if (override && override !== url) continue;
    listed.set(url, r.contentHash ?? '');
  }
  return { hosts, listed };
}

/**
 * Record the baseline of a site's IndexNow state: what is listable now, as if it had been pushed (Codex review of batch
 * 8: called in the transaction that turns IndexNow on, so what is published after that moment is news — the first pass
 * no longer takes it into the baseline). `settings`: the settings being stored. A site already seeded keeps its state
 * (turned on again: what changed while it was off is pushed).
 */
export async function seedIndexNowBaseline(tx: Tx, siteId: string, settings: SiteSeoSettings, at = new Date()): Promise<boolean> {
  await tx.insert(indexNowSites).values({ siteId }).onConflictDoNothing({ target: indexNowSites.siteId });
  const [status] = await tx.select({ seededAt: indexNowSites.seededAt }).from(indexNowSites).where(eq(indexNowSites.siteId, siteId)).for('update');
  if (status?.seededAt) return false;
  const { listed } = await currentOf(tx, siteId, settings);
  const rows = [...listed];
  for (let i = 0; i < rows.length; i += 1000) {
    await tx
      .insert(indexNowState)
      .values(rows.slice(i, i + 1000).map(([url, fingerprint]) => ({ siteId, url, fingerprint })))
      .onConflictDoUpdate({ target: [indexNowState.siteId, indexNowState.url], set: { fingerprint: sql`excluded.fingerprint` } });
  }
  await tx.update(indexNowSites).set({ seededAt: at, lastRunAt: at, lastStatus: 'seeded', lastError: null }).where(eq(indexNowSites.siteId, siteId));
  return true;
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

/** One site's pass, under its lease (`processIndexNowQueue`). */
async function passOf(db: Database, siteId: string, deps: IndexNowDeps, lease: { renew(): Promise<boolean> }): Promise<IndexNowPassResult> {
  const now = deps.now ?? (() => new Date());
  const send = deps.fetch ?? ((url: string, init: RequestInit) => guardedFetch(url, init));
  const plan = await runSiteTransaction(db, siteId, async (tx) => {
    const settings = await seoSettingsOf(tx, siteId);
    if (!indexNowOn(settings)) return { kind: 'off' as const };
    const { hosts, listed } = await currentOf(tx, siteId, settings);
    // Not seeded (IndexNow turned on past the settings service, an older release): the baseline now.
    if (await seedIndexNowBaseline(tx, siteId, settings, now())) return { kind: 'seeded' as const, count: listed.size };
    const known = new Map((await tx.select({ url: indexNowState.url, fingerprint: indexNowState.fingerprint }).from(indexNowState).where(eq(indexNowState.siteId, siteId))).map((r) => [r.url, r.fingerprint]));
    const changed = [...listed].filter(([url, fp]) => known.get(url) !== fp);
    const gone = [...known.keys()].filter((url) => !listed.has(url));
    return { kind: 'diff' as const, settings, hosts, changed, gone };
  });
  if (plan.kind === 'off') return { siteId, status: 'off', urls: 0, requests: 0 };
  if (plan.kind === 'seeded') return { siteId, status: 'seeded', urls: plan.count, requests: 0 };

  const { settings, hosts, changed, gone } = plan;
  const key = settings.discovery.indexNowKey!;
  // Only the site's own current hosts: a URL elsewhere is never sent (a gone URL whose host the site no longer has is
  // forgotten: no notice can be made for it).
  const byHost = new Map<string, Array<{ url: string; fingerprint: string | null }>>();
  const orphans: string[] = [];
  const add = (h: string, entry: { url: string; fingerprint: string | null }) => {
    const list = byHost.get(h);
    if (list) list.push(entry);
    else byHost.set(h, [entry]);
  };
  for (const [url, fingerprint] of changed) {
    const h = hostOf(url);
    if (h && hosts.has(h)) add(h, { url, fingerprint });
  }
  for (const url of gone) {
    const h = hostOf(url);
    if (h && hosts.has(h)) add(h, { url, fingerprint: null });
    else orphans.push(url);
  }
  let urls = 0;
  let requests = 0;
  let failure: string | null = null;
  for (const [host, list] of [...byHost].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (let i = 0; i < list.length && !failure; i += INDEXNOW_MAX_URLS) {
      const batch = list.slice(i, i + INDEXNOW_MAX_URLS);
      // Still this worker's site (renewed for the next request): else another worker has it — stop, record nothing more.
      if (!(await lease.renew())) {
        failure = 'lease lost';
        break;
      }
      try {
        const res = await send(settings.discovery.indexNowEndpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ host, key, keyLocation: `https://${host}/${key}.txt`, urlList: batch.map((b) => b.url) }),
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        requests++;
        if (res.status !== 200 && res.status !== 202) {
          failure = `HTTP ${res.status}`;
          break;
        }
      } catch (err) {
        // No answer (a timeout, a refused connection): the outcome is unknown — the state stays, the next pass sends again.
        failure = err instanceof Error && err.name === 'TimeoutError' ? 'timeout: outcome unknown' : 'request failed';
        break;
      }
      // Accepted: recorded, so the next pass does not send it again — by the lease's holder only (a worker that lost the
      // site while it waited records nothing: its successor makes its own comparison).
      if (!(await lease.renew())) {
        failure = 'lease lost';
        break;
      }
      await runSiteTransaction(db, siteId, async (tx) => {
        const kept = batch.filter((b) => b.fingerprint !== null);
        if (kept.length) {
          await tx
            .insert(indexNowState)
            .values(kept.map((b) => ({ siteId, url: b.url, fingerprint: b.fingerprint!, pushedAt: now() })))
            .onConflictDoUpdate({ target: [indexNowState.siteId, indexNowState.url], set: { fingerprint: sql`excluded.fingerprint`, pushedAt: sql`excluded.pushed_at` } });
        }
        const dropped = batch.filter((b) => b.fingerprint === null).map((b) => b.url);
        if (dropped.length) await tx.delete(indexNowState).where(and(eq(indexNowState.siteId, siteId), inArray(indexNowState.url, dropped)));
      });
      urls += batch.length;
    }
    if (failure) break;
  }
  // A worker that lost the site leaves the record to its successor.
  if (failure === 'lease lost') return { siteId, status: 'failed', urls, requests, error: failure };
  await runSiteTransaction(db, siteId, async (tx) => {
    if (orphans.length) await tx.delete(indexNowState).where(and(eq(indexNowState.siteId, siteId), inArray(indexNowState.url, orphans)));
    await tx
      .update(indexNowSites)
      .set({ lastRunAt: now(), lastStatus: failure ? 'failed' : urls ? 'pushed' : 'nothing', lastError: failure, pushedUrls: sql`${indexNowSites.pushedUrls} + ${urls}` })
      .where(eq(indexNowSites.siteId, siteId));
  });
  return failure ? { siteId, status: 'failed', urls, requests, error: failure } : { siteId, status: urls ? 'pushed' : 'nothing', urls, requests };
}

/**
 * Work through the due sites, one at a time per site (its lease) and per row (`FOR UPDATE SKIP LOCKED`): each site's due
 * rows are taken, its pass made, and the rows deleted — or put off with a growing delay after a failure (the next pass
 * makes the same comparison, so nothing is lost or sent twice). Returns each site's outcome.
 */
export async function processIndexNowQueue(db: Database, deps: IndexNowDeps & { limit?: number } = {}): Promise<IndexNowPassResult[]> {
  const now = deps.now ?? (() => new Date());
  const out: IndexNowPassResult[] = [];
  const tried = new Set<string>();
  while (out.length < (deps.limit ?? 50)) {
    // A due row of a site not tried yet in this run, taken without waiting on another worker's.
    const [pick] = await db
      .select({ siteId: indexNowQueue.siteId })
      .from(indexNowQueue)
      .where(
        and(
          lte(indexNowQueue.dueAt, now()),
          or(isNull(indexNowQueue.leasedUntil), lt(indexNowQueue.leasedUntil, now())),
          tried.size ? notInArray(indexNowQueue.siteId, [...tried]) : undefined,
        ),
      )
      .orderBy(asc(indexNowQueue.dueAt))
      .limit(1)
      .for('update', { skipLocked: true });
    if (!pick) break;
    const siteId = pick.siteId;
    tried.add(siteId);
    // The site's lease: one worker at a time makes its pass — under its own token, renewed before each step and released
    // only by its holder (Codex review of batch 8).
    const token = randomUUID();
    const leaseFor = () => new Date(now().getTime() + LEASE_MS);
    const leased = await runSiteTransaction(db, siteId, async (tx) => {
      await tx.insert(indexNowSites).values({ siteId }).onConflictDoNothing({ target: indexNowSites.siteId });
      const [row] = await tx
        .update(indexNowSites)
        .set({ leasedUntil: leaseFor(), leaseToken: token })
        .where(and(eq(indexNowSites.siteId, siteId), or(isNull(indexNowSites.leasedUntil), lt(indexNowSites.leasedUntil, now()))))
        .returning({ siteId: indexNowSites.siteId });
      return !!row;
    });
    if (!leased) continue;
    const lease = {
      renew: async () =>
        (
          await runSiteTransaction(db, siteId, (tx) =>
            tx
              .update(indexNowSites)
              .set({ leasedUntil: leaseFor() })
              .where(and(eq(indexNowSites.siteId, siteId), eq(indexNowSites.leaseToken, token)))
              .returning({ siteId: indexNowSites.siteId }),
          )
        ).length > 0,
    };
    try {
      // The rows this pass answers for: those due now (a row queued meanwhile waits for the next pass).
      const rows = await db
        .update(indexNowQueue)
        .set({ leasedUntil: leaseFor() })
        .where(and(eq(indexNowQueue.siteId, siteId), lte(indexNowQueue.dueAt, now()), or(isNull(indexNowQueue.leasedUntil), lt(indexNowQueue.leasedUntil, now()))))
        .returning({ id: indexNowQueue.id, attempts: indexNowQueue.attempts });
      if (rows.length === 0) continue;
      let result: IndexNowPassResult;
      try {
        result = await passOf(db, siteId, deps, lease);
      } catch (err) {
        result = { siteId, status: 'failed', urls: 0, requests: 0, error: err instanceof Error ? err.message.slice(0, 200) : 'failed' };
      }
      out.push(result);
      // The rows are settled by the lease's holder only: a worker that lost the site leaves them (they come due again).
      if (!(await lease.renew())) continue;
      const ids = rows.map((r) => r.id);
      if (result.status === 'failed') {
        const attempts = Math.max(...rows.map((r) => r.attempts)) + 1;
        await db
          .update(indexNowQueue)
          .set({ attempts, leasedUntil: null, lastError: result.error ?? 'failed', dueAt: new Date(now().getTime() + retryDelayMs(attempts)) })
          .where(inArray(indexNowQueue.id, ids));
      } else {
        await db.delete(indexNowQueue).where(inArray(indexNowQueue.id, ids));
      }
    } finally {
      await runSiteTransaction(db, siteId, (tx) =>
        tx.update(indexNowSites).set({ leasedUntil: null, leaseToken: null }).where(and(eq(indexNowSites.siteId, siteId), eq(indexNowSites.leaseToken, token))),
      );
    }
  }
  return out;
}
