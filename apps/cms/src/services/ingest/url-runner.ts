import { sites, type Database } from '@heopress/database';
import type { QueueProvider, StorageProvider } from '@heopress/runtime';
import { extractDocument } from './extract';
import { classifyFetchFailure } from './failure';
import { fetchPage, type FetchPageOptions } from './fetcher';
import type { HostLimiter } from './host-limiter';
import {
  dispatchProcessingJobs,
  operationIdFor,
  recordFailedAttempt,
  registerSourceDocument,
  ReplayMismatchError,
  StaleRunError,
} from './source-documents';
import { setSourceRunner, SourceRunError, type SourceRunContext, type SourceRunner } from './source-worker';

/**
 * The runner for sources of type `url` (HeoPress P08 task 2.x; one page per run): fetch it through the native
 * fetcher (SSRF boundary, robots.txt, per-host limits), extract and sanitise it, snapshot it and register the source
 * document. Failures are recorded as a fetch attempt and reach the source's health with their category
 * (`SourceRunError`). Feed, sitemap and list-page discovery (task 1.3) plug into the same runner later; until then
 * those types find nothing.
 */

export interface IngestRunnerDeps {
  db: Database;
  storage: StorageProvider;
  limiter?: HostLimiter | null;
  fetch?: Omit<FetchPageOptions, 'signal' | 'limiter'>;
  now?: () => Date;
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

/** Fetch and register one URL for a run. Returns the number of new documents (0 or 1). */
async function ingestUrl(deps: IngestRunnerDeps, ctx: SourceRunContext, url: string): Promise<number> {
  const operationId = operationIdFor(ctx.source.id, ctx.scheduledFor, url);
  const run = { runId: ctx.runId, generation: ctx.generation };
  const startedAt = deps.now?.() ?? new Date();
  let finalUrl: string | null = null;
  try {
    const page = await fetchPage(url, { ...deps.fetch, limiter: deps.limiter ?? null, signal: ctx.signal });
    finalUrl = page.finalUrl;
    const extracted = extractDocument(decode(page.body, page.contentType), page.finalUrl);
    const res = await registerSourceDocument(deps, { siteId: ctx.siteId, sourceId: ctx.source.id, run, operationId, url, page, extracted, startedAt });
    return res.duplicate ? 0 : 1;
  } catch (err) {
    if (err instanceof StaleRunError) throw err;
    const verdict = err instanceof ReplayMismatchError ? { category: 'other' as const } : classifyFetchFailure(err);
    const message = err instanceof Error ? err.message : String(err);
    const httpStatus = (err as { httpStatus?: number }).httpStatus ?? null;
    finalUrl = (err as { finalUrl?: string }).finalUrl ?? finalUrl;
    await recordFailedAttempt(deps, { siteId: ctx.siteId, sourceId: ctx.source.id, run, operationId, url, finalUrl, category: verdict.category, message, httpStatus, startedAt });
    throw new SourceRunError(verdict.category, message);
  }
}

export function createIngestRunner(deps: IngestRunnerDeps): SourceRunner {
  return async (ctx) => {
    if (ctx.source.type === 'url') return { itemsFound: await ingestUrl(deps, ctx, ctx.source.url) };
    return { itemsFound: 0 };
  };
}

/** Install the runner (serve.ts). */
export function installIngestRunner(deps: IngestRunnerDeps): void {
  setSourceRunner(createIngestRunner(deps));
}

/** The outbox dispatcher over every site. */
export async function dispatchAllProcessingJobs(deps: { db: Database; queue?: QueueProvider }): Promise<number> {
  if (!deps.queue) return 0;
  let n = 0;
  for (const { id } of await deps.db.select({ id: sites.id }).from(sites)) n += await dispatchProcessingJobs(deps, id);
  return n;
}
