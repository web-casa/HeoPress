import type { FailureCategory, FetchChainStep } from '@heopress/contracts/schemas';
import type { Database } from '@heopress/database';
import type { KeyProvider } from '@heopress/runtime';
import { outboundBlockOf } from '@heopress/runtime/node';
import { runSiteTransaction } from '../../rls-transaction';
import type { ExtractedDocument } from '../extract';
import { classifyFetchFailure, IngestFetchError } from '../failure';
import { assertRobotsAllows, ingestUserAgent, type FetchedPage, type FetchPageOptions } from '../fetcher';
import { reserveUsage, settleUsage } from './budget';
import { createProviderHttp, type ProviderHttpOptions } from './http';
import { CRAWL_PROVIDERS } from './registry';
import { extractCrawlResult } from './result';
import { chainFor, loadProviderStates, providerConfig, type ProviderState } from './settings';
import { assertPublicTarget } from './target';
import { ProviderError, type CrawlProvider, type ProviderConfig, type ProviderId } from './types';

/**
 * The fallback chain (HeoPress P08 task 3.3; design decision 4; spec ingest/crawling "访问拒绝不得绕过").
 *
 * Steps run in the source's order (default: native first, then the site's enabled services). A technical failure —
 * timeout, network, a service's own error, an extraction that fails the quality check — hands the URL to the next
 * step. `access_denied` (401 / 403 / 451, robots.txt, a no-AI reservation) and `blocked` (the outbound boundary) stop
 * the chain at once: later services are never called, because fallback exists for technical failures, not to get
 * around a site's refusal (ADR-0009).
 *
 * Before a service gets the URL: the service must be usable for the site (enabled, confirmed, configured, within
 * budget, breaker closed), the URL must pass the normal outbound check and robots.txt, and its budget is reserved.
 * The final URL the service reports is checked again. Its output goes through the native extraction (`result.ts`).
 */

export interface ChainOptions {
  db: Database;
  /** Opens the sites' credentials; without it no service is used. */
  keys?: KeyProvider;
  /** The native fetch's boundary options (resolver / classifier test hooks, robots cache, User-Agent). */
  fetch?: Pick<FetchPageOptions, 'resolve' | 'classify' | 'robots' | 'userAgent'>;
  http?: ProviderHttpOptions;
  /** Test hook: replace built-in providers. */
  providers?: Partial<Record<ProviderId, CrawlProvider>>;
  now?: () => Date;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

export interface ChainSuccess {
  page: FetchedPage;
  extracted: ExtractedDocument;
  method: 'native' | 'provider';
  provider: FetchChainStep;
}

/** The chain's final failure: the last step's category (terminal or not) and which step it was. */
export class ChainFailure extends IngestFetchError {
  constructor(
    category: FailureCategory,
    message: string,
    readonly step: FetchChainStep,
    opts: { httpStatus?: number; finalUrl?: string } = {},
  ) {
    super(category, message, opts);
    this.name = 'ChainFailure';
  }
}

interface StepFailure {
  step: FetchChainStep;
  category: FailureCategory;
  message: string;
  httpStatus?: number;
  finalUrl?: string;
  /** True: the step was not tried (unusable service). */
  skipped: boolean;
}

interface ChainInput {
  siteId: string;
  sourceId: string;
  url: string;
  signal?: AbortSignal;
  /** The native step (the url runner's fetch + extraction). */
  native: () => Promise<{ page: FetchedPage; extracted: ExtractedDocument }>;
  /** Called for each step that failed and was followed by another (records the attempt). */
  onStepFailed?: (f: StepFailure) => Promise<void>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function stepFailure(step: FetchChainStep, err: unknown): StepFailure & { terminal: boolean } {
  if (err instanceof ProviderError) return { step, category: err.category, message: err.message, terminal: false, skipped: false };
  const verdict = classifyFetchFailure(err);
  const e = err as { httpStatus?: number; finalUrl?: string };
  return { step, category: verdict.category, message: message(err), httpStatus: e.httpStatus, finalUrl: e.finalUrl, terminal: verdict.terminal, skipped: false };
}

/** Run one service step; throws what the step failed with. */
async function runProvider(opts: ChainOptions, input: ChainInput, state: ProviderState, config: ProviderConfig): Promise<ChainSuccess> {
  const provider = opts.providers?.[state.provider] ?? CRAWL_PROVIDERS[state.provider];
  const boundary = { resolve: opts.fetch?.resolve, classify: opts.fetch?.classify };
  // The normal outbound check of the target and robots.txt, before anything is sent to the service.
  await assertPublicTarget(input.url, boundary);
  await assertRobotsAllows(input.url, { ...opts.fetch, signal: input.signal });

  const manifest = CRAWL_PROVIDERS[state.provider].manifest;
  const estimate = manifest.defaultUnitCostMicros;
  const reservation = await reserveUsage(opts, { siteId: input.siteId, provider: state.provider, estimate, ceiling: state.row?.monthlyBudgetMicros ?? null });
  if (!reservation.ok) throw new ProviderError(state.provider, 'quota', `${state.provider}: this site's monthly budget is used up`);

  let serviceFailed = false;
  let cost: number | null = null;
  try {
    const http = createProviderHttp(manifest, config, { env: opts.env, ...opts.http });
    let result;
    try {
      result = await provider.crawl(
        { url: input.url, userAgent: opts.fetch?.userAgent ?? ingestUserAgent(opts.env), timeoutMs: opts.timeoutMs ?? 30_000, signal: input.signal },
        { http, config },
      );
    } catch (err) {
      // A refusal of the service's own endpoint is the service's failure, not the target's.
      if (outboundBlockOf(err)) throw new ProviderError(state.provider, 'other', `${state.provider}: ${message(err)}`);
      throw err;
    }
    cost = result.cost ?? null;
    if (result.finalUrl !== input.url) await assertPublicTarget(result.finalUrl, boundary);
    const { page, extracted } = extractCrawlResult(result);
    return { page, extracted, method: 'provider', provider: state.provider };
  } catch (err) {
    serviceFailed = err instanceof ProviderError || (!(err instanceof IngestFetchError) && !classifyFetchFailure(err).terminal);
    throw err;
  } finally {
    await settleUsage(opts, { siteId: input.siteId, provider: state.provider, estimate, cost, failed: serviceFailed });
  }
}

export async function runFetchChain(opts: ChainOptions, input: ChainInput): Promise<ChainSuccess> {
  const now = opts.now?.() ?? new Date();
  const { states, chain } = await runSiteTransaction(opts.db, input.siteId, async (tx) => {
    const states = await loadProviderStates(tx, input.siteId, now);
    return { states, chain: await chainFor(tx, input.siteId, input.sourceId, states) };
  });

  let last: (StepFailure & { terminal: boolean }) | null = null;
  const fail = async (f: StepFailure & { terminal: boolean }, more: boolean) => {
    last = f;
    if (f.terminal) throw new ChainFailure(f.category, f.message, f.step, { httpStatus: f.httpStatus, finalUrl: f.finalUrl });
    if (more) await input.onStepFailed?.(f);
  };

  for (const [i, step] of chain.entries()) {
    const more = i < chain.length - 1;
    if (input.signal?.aborted) break;
    if (step === 'native') {
      try {
        const got = await input.native();
        return { ...got, method: 'native', provider: 'native' };
      } catch (err) {
        await fail(stepFailure('native', err), more);
        continue;
      }
    }
    const state = states.find((s) => s.provider === step)!;
    const skip = async (reason: string) => fail({ step, category: 'other', message: `${step} skipped: ${reason}`, terminal: false, skipped: true }, more);
    if (state.unavailable) {
      await skip(state.unavailable);
      continue;
    }
    if (!opts.keys) {
      await skip('no key provider');
      continue;
    }
    let config: ProviderConfig;
    try {
      config = await providerConfig(opts.keys, input.siteId, step, state.row);
    } catch {
      // A credential that does not open for this site (sealed for another site, or under a lost key) is unusable.
      await skip('the stored credential is not usable for this site');
      continue;
    }
    try {
      return await runProvider(opts, input, state, config);
    } catch (err) {
      await fail(stepFailure(step, err), more);
    }
  }
  const f = last as (StepFailure & { terminal: boolean }) | null;
  if (!f) throw new ChainFailure('other', 'the fetch chain is empty', 'native');
  throw new ChainFailure(f.category, f.message, f.step, { httpStatus: f.httpStatus, finalUrl: f.finalUrl });
}
