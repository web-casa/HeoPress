import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { ingestDiscoveredUrls, ingestSourceRuns, sites, type Database } from '@heopress/database';
import type { QueueProvider, StorageProvider } from '@heopress/runtime';
import { extractDocument } from './extract';
import { classifyFetchFailure } from './failure';
import { fetchPage, type FetchPageOptions } from './fetcher';
import type { HostLimiter } from './host-limiter';
import { runSiteTransaction } from '../rls-transaction';
import { discoverPluginSource, discoverSource, FETCH_QUEUE, type DiscoveryLimits, type DiscoveryQuota, type FetchJobPayload, type PluginSourceAdapters } from './discovery-runner';
import { ChainFailure, runFetchChain, type ChainOptions } from './providers/chain';
import {
  type DedupOptions,
  dispatchProcessingJobs,
  operationIdFor,
  recordFailedAttempt,
  registerSourceDocument,
  ReplayMismatchError,
  StaleRunError,
} from './source-documents';
import { dispatchResearchLeads } from './research-leads';
import { processDocumentMedia, type MediaLimits } from './source-media';
import { setSourceRunner, SourceRunError, type SourceRunContext, type SourceRunner } from './source-worker';

/**
 * The runner for sources of type `url` (HeoPress P08 task 2.x; one page per run): fetch it through the native
 * fetcher (SSRF boundary, robots.txt, per-host limits), extract and sanitise it, snapshot it and register the source
 * document. Failures are recorded as a fetch attempt and reach the source's health with their category
 * (`SourceRunError`). Feed, sitemap and list-page sources run discovery (`discovery-runner.ts`, task 1.3): each new
 * URL becomes a fetch job on the `ingest-fetch` queue (`processFetchJob`), which runs the same document pipeline.
 */

export interface IngestRunnerDeps {
  db: Database;
  storage: StorageProvider;
  limiter?: HostLimiter | null;
  fetch?: Omit<FetchPageOptions, 'signal' | 'limiter'>;
  /** Fetch jobs of discovered URLs go here; without a queue they are fetched inline, one after another. */
  queue?: QueueProvider;
  limits?: Partial<DiscoveryLimits>;
  quota?: DiscoveryQuota;
  dedup?: DedupOptions;
  now?: () => Date;
  /** External crawl services (task 3.3): with these the URL goes through the source's fallback chain. */
  providers?: Omit<ChainOptions, 'db' | 'now'>;
  /** Caps on source media downloads (task 2.9). */
  media?: Partial<MediaLimits>;
  /** Plugin source adapters (HeoPress P12 task 4.1): the site's adapter a `plugin` source names. */
  sourceAdapters?: PluginSourceAdapters;
}

function decode(body: Buffer, contentType: string): string {
  const declared = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/["']/g, '');
  let label = declared;
  if (!label) {
    const head = body.subarray(0, 2048).toString('latin1');
    label = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label || 'utf-8').decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

interface UrlTarget {
  siteId: string;
  sourceId: string;
  scheduledFor: string;
  /** The run's ownership (a `url` source's own run); null for a fetch job of a discovered URL (its own unit of work). */
  run: { runId: string; generation: number } | null;
  /** The run the attempt belongs to, for the record. */
  runId: string | null;
  signal?: AbortSignal;
}

type UrlOutcome = { kind: 'new' | 'duplicate'; documentId: string };

/** Fetch and register one URL. Throws `SourceRunError` (after recording the attempt) or `StaleRunError`. */
async function ingestUrl(deps: IngestRunnerDeps, t: UrlTarget, url: string, operationKey = url): Promise<UrlOutcome> {
  const operationId = operationIdFor(t.sourceId, t.scheduledFor, operationKey);
  const run = t.run;
  const startedAt = deps.now?.() ?? new Date();
  let finalUrl: string | null = null;
  try {
    const native = async () => {
      const page = await fetchPage(url, { ...deps.fetch, limiter: deps.limiter ?? null, signal: t.signal });
      finalUrl = page.finalUrl;
      return { page, extracted: extractDocument(decode(page.body, page.contentType), page.finalUrl) };
    };
    const got = deps.providers
      ? await runFetchChain(
          { ...deps.providers, db: deps.db, now: deps.now, fetch: { ...deps.fetch, ...deps.providers.fetch } },
          {
            siteId: t.siteId,
            sourceId: t.sourceId,
            url,
            signal: t.signal,
            native,
            onStepFailed: (f) =>
              recordFailedAttempt(deps, {
                ...{ siteId: t.siteId, sourceId: t.sourceId, run, runId: t.runId, operationId, url, startedAt },
                finalUrl: f.finalUrl ?? null,
                category: f.category,
                message: f.message,
                httpStatus: f.httpStatus ?? null,
                fetchMethod: f.step === 'native' ? 'native' : 'provider',
                fetchProvider: f.step,
              }),
          },
        )
      : { ...(await native()), method: 'native' as const, provider: 'native' as const };
    finalUrl = got.page.finalUrl;
    const { page, extracted } = got;
    const res = await registerSourceDocument(deps, {
      siteId: t.siteId,
      sourceId: t.sourceId,
      run,
      runId: t.runId,
      operationId,
      url,
      page,
      extracted,
      startedAt,
      fetchMethod: got.method,
      fetchProvider: got.provider,
    });
    if (!res.duplicate) await afterRegistration(deps, t.siteId, res.documentId, t.signal);
    return { kind: res.duplicate ? 'duplicate' : 'new', documentId: res.documentId };
  } catch (err) {
    if (err instanceof StaleRunError) throw err;
    const verdict = err instanceof ReplayMismatchError ? { category: 'other' as const } : classifyFetchFailure(err);
    const message = err instanceof Error ? err.message : String(err);
    const httpStatus = (err as { httpStatus?: number }).httpStatus ?? null;
    finalUrl = (err as { finalUrl?: string }).finalUrl ?? finalUrl;
    const step = err instanceof ChainFailure ? err.step : 'native';
    await recordFailedAttempt(deps, {
      ...{ siteId: t.siteId, sourceId: t.sourceId, run, runId: t.runId, operationId, url, finalUrl, category: verdict.category, message, httpStatus, startedAt },
      fetchMethod: step === 'native' ? 'native' : 'provider',
      fetchProvider: step,
    });
    throw new SourceRunError(verdict.category, message);
  }
}

/**
 * After a new document (tasks 1.7, 2.9): its images, each on its own (never failing the document), and its research
 * leads handed on as fetch jobs (queued, or fetched inline without a queue). Best effort: what is left over is taken
 * up by `maintainIngestSites`.
 */
async function afterRegistration(deps: IngestRunnerDeps, siteId: string, documentId: string, signal?: AbortSignal): Promise<void> {
  await processDocumentMedia(mediaDeps(deps), siteId, documentId).catch(() => undefined);
  await dispatchLeads(deps, siteId, signal).catch(() => undefined);
}

function mediaDeps(deps: IngestRunnerDeps) {
  return { db: deps.db, storage: deps.storage, limiter: deps.limiter, fetch: deps.fetch, limits: deps.media, trackingParams: deps.dedup?.trackingParams, now: deps.now };
}

async function dispatchLeads(deps: IngestRunnerDeps, siteId: string, signal?: AbortSignal): Promise<void> {
  const inline: FetchJobPayload[] = [];
  const queue = deps.queue;
  await dispatchResearchLeads(deps, siteId, async (job) => {
    if (queue) await queue.enqueue<FetchJobPayload>(FETCH_QUEUE, 'fetch-url', job, { singletonKey: fetchSingletonKey(job) });
    else inline.push(job);
  });
  for (const job of inline) await processFetchJob(deps, job, signal);
}

const fetchSingletonKey = (job: FetchJobPayload) => `ingest-fetch:${job.siteId}:${createHash('sha256').update(job.normalizedUrl).digest('hex').slice(0, 32)}`;

/** The periodic pass over every site: the processing outbox, pending research leads and media due for a (re)try. */
export async function maintainIngestSites(deps: IngestRunnerDeps): Promise<void> {
  for (const { id } of await deps.db.select({ id: sites.id }).from(sites)) {
    if (deps.queue) await dispatchProcessingJobs(deps, id);
    await dispatchLeads(deps, id).catch(() => undefined);
    await processDocumentMedia(mediaDeps(deps), id).catch(() => undefined);
  }
}

export type FetchJobOutcome = 'skipped' | 'fetched' | 'duplicate' | 'refused' | 'failed';

/**
 * Fetch one discovered URL (a job of the `ingest-fetch` queue). Idempotent: only a `queued` URL is fetched, and the
 * operation (source, slot, normalised URL) makes a redelivered job reuse the document it already registered.
 */
export async function processFetchJob(deps: IngestRunnerDeps, job: FetchJobPayload, signal?: AbortSignal): Promise<FetchJobOutcome> {
  const where = and(eq(ingestDiscoveredUrls.siteId, job.siteId), eq(ingestDiscoveredUrls.id, job.discoveredId));
  const [row] = await runSiteTransaction(deps.db, job.siteId, (tx) => tx.select({ status: ingestDiscoveredUrls.status }).from(ingestDiscoveredUrls).where(where));
  if (row?.status !== 'queued') return 'skipped';
  const finish = (status: Exclude<FetchJobOutcome, 'skipped'>, extra: { reason?: string | null; sourceDocumentId?: string | null } = {}) =>
    runSiteTransaction(deps.db, job.siteId, async (tx) => {
      await tx
        .update(ingestDiscoveredUrls)
        .set({ status, reason: extra.reason ?? null, sourceDocumentId: extra.sourceDocumentId ?? null, updatedAt: deps.now?.() ?? new Date() })
        .where(where);
      if (status === 'duplicate') {
        await tx
          .update(ingestSourceRuns)
          .set({ itemsDuplicate: sql`${ingestSourceRuns.itemsDuplicate} + 1` })
          .where(and(eq(ingestSourceRuns.siteId, job.siteId), eq(ingestSourceRuns.id, job.runId)));
      }
    });
  try {
    const res = await ingestUrl(deps, { siteId: job.siteId, sourceId: job.sourceId, scheduledFor: job.scheduledFor, run: null, runId: job.runId, signal }, job.normalizedUrl, job.normalizedUrl);
    await finish(res.kind === 'new' ? 'fetched' : 'duplicate', { sourceDocumentId: res.documentId });
    return res.kind === 'new' ? 'fetched' : 'duplicate';
  } catch (err) {
    const category = err instanceof SourceRunError ? err.category : 'other';
    const message = err instanceof Error ? err.message.slice(0, 500) : String(err);
    // Refused by the outbound boundary or the site (internal address, robots.txt, 403): never retried.
    const status = category === 'blocked' || category === 'access_denied' ? 'refused' : 'failed';
    await finish(status, { reason: `${category}: ${message}` });
    return status;
  }
}

export function createIngestRunner(deps: IngestRunnerDeps): SourceRunner {
  return async (ctx) => {
    if (ctx.source.type === 'url') {
      const res = await ingestUrl(
        deps,
        { siteId: ctx.siteId, sourceId: ctx.source.id, scheduledFor: ctx.scheduledFor, run: { runId: ctx.runId, generation: ctx.generation }, runId: ctx.runId, signal: ctx.signal },
        ctx.source.url,
      );
      const isNew = res.kind === 'new' ? 1 : 0;
      return { itemsFound: isNew, stats: { discovered: 1, new: isNew, duplicate: 1 - isNew } };
    }
    const inline: FetchJobPayload[] = [];
    const queue = deps.queue;
    const discover = ctx.source.type === 'plugin' ? discoverPluginSource : discoverSource;
    const result = await discover(deps, ctx, async (job) => {
      if (queue) await queue.enqueue<FetchJobPayload>(FETCH_QUEUE, 'fetch-url', job, { singletonKey: fetchSingletonKey(job) });
      else inline.push(job);
    });
    for (const job of inline) await processFetchJob(deps, job, ctx.signal);
    return result;
  };
}

/** Install the runner and the fetch-job consumer (serve.ts). */
export function installIngestRunner(deps: IngestRunnerDeps): void {
  setSourceRunner(createIngestRunner(deps));
  deps.queue?.process<FetchJobPayload>(FETCH_QUEUE, async (job) => {
    await processFetchJob(deps, job.data, job.signal);
  });
}
