import type { Database } from '@heopress/database';
import type { KeyProvider } from '@heopress/runtime';
import type { FlowRunContext } from '../flow-service';
import { gatewayFor } from '../llm/bindings';
import { ContentPipeline, type PipelineDeps, type ProduceRequest } from './content-pipeline';

/**
 * The content pipeline's Flows operations (HeoPress P09 task 1.1). Each one is a step of a production; the flow
 * engine registers them (`flow-service.ts`) and loads this module lazily.
 *
 * The run environment gives `db`, `siteId`, `keys`, `runId`; a test (or an embedding host) may hand a ready
 * `pipeline` (partial `PipelineDeps`, e.g. a mocked gateway). An option names its input, or the previous step's
 * output supplies it (`productionId`, `sourceDocumentIds`).
 */

function pipelineOf(ctx: FlowRunContext): ContentPipeline {
  const db = ctx.env['db'] as Database | undefined;
  const siteId = ctx.env['siteId'];
  if (!db || typeof siteId !== 'string') throw new Error('pipeline operations require env.db and env.siteId');
  const given = (ctx.env['pipeline'] ?? {}) as Partial<PipelineDeps>;
  return new ContentPipeline({
    db,
    siteId,
    gateway: given.gateway ?? gatewayFor({ db, keys: ctx.env['keys'] as KeyProvider | undefined, env: process.env }),
    ...given,
    flowRunId: typeof ctx.env['runId'] === 'string' ? (ctx.env['runId'] as string) : (given.flowRunId ?? null),
  });
}

const previous = (ctx: FlowRunContext): Record<string, unknown> => (ctx.steps['previous'] ?? {}) as Record<string, unknown>;

function productionIdOf(ctx: FlowRunContext, options: Record<string, unknown>): string {
  const id = options['productionId'] ?? previous(ctx)['productionId'] ?? ctx.input['productionId'];
  if (typeof id !== 'string' || !id) throw new Error('this operation needs a productionId (option, previous step or input)');
  return id;
}

function sourceIdsOf(ctx: FlowRunContext, options: Record<string, unknown>): string[] {
  const prev = previous(ctx);
  const fromPrev = Array.isArray(prev['admitted']) ? (prev['admitted'] as Array<{ id: string }>).map((a) => a.id) : undefined;
  const raw = options['sourceDocumentIds'] ?? ctx.input['sourceDocumentIds'] ?? fromPrev ?? (ctx.input['sourceDocumentId'] ? [ctx.input['sourceDocumentId']] : undefined);
  if (!Array.isArray(raw) || !raw.length || raw.some((r) => typeof r !== 'string')) throw new Error('this operation needs sourceDocumentIds');
  return raw as string[];
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export async function fetchSourceOperation(ctx: FlowRunContext, options: Record<string, unknown>) {
  return pipelineOf(ctx).fetchSources(sourceIdsOf(ctx, options), { priority: Number(options['priority'] ?? 0) || 0 });
}

function produceOperation(mode: ProduceRequest['mode']) {
  return async (ctx: FlowRunContext, options: Record<string, unknown>) => {
    const targetLocale = str(options['targetLocale']) ?? str(ctx.input['targetLocale']);
    if (!targetLocale) throw new Error(`pipeline:${mode} needs a targetLocale`);
    return pipelineOf(ctx).produce({
      mode,
      sourceDocumentIds: sourceIdsOf(ctx, options),
      targetLocale,
      collection: str(options['collection']),
      promptVersion: str(options['promptVersion']),
      sourceLocale: str(options['sourceLocale']),
    });
  };
}

export const translateOperation = async (ctx: FlowRunContext, options: Record<string, unknown>) => {
  // An item of a translation group: translate it (new draft) or retranslate a translation's stale blocks.
  const collection = str(options['collection']) ?? 'articles';
  const targetItemId = str(options['targetItemId']) ?? str(ctx.input['targetItemId']);
  if (targetItemId) return pipelineOf(ctx).retranslate({ collection, targetItemId, promptVersion: str(options['promptVersion']) });
  const sourceItemId = str(options['sourceItemId']) ?? str(ctx.input['sourceItemId']);
  if (sourceItemId) {
    const targetLocale = str(options['targetLocale']) ?? str(ctx.input['targetLocale']);
    if (!targetLocale) throw new Error('pipeline:translate needs a targetLocale');
    return pipelineOf(ctx).translateItem({ collection, sourceItemId, targetLocale, promptVersion: str(options['promptVersion']) });
  }
  return produceOperation('translate')(ctx, options);
};
export const rewriteOperation = produceOperation('rewrite');
export const writeOperation = produceOperation('write');

export async function seoCopyOperation(ctx: FlowRunContext, options: Record<string, unknown>) {
  return pipelineOf(ctx).seoCopy(productionIdOf(ctx, options));
}

export async function runGateOperation(ctx: FlowRunContext, options: Record<string, unknown>) {
  const id = productionIdOf(ctx, options);
  return { productionId: id, ...(await pipelineOf(ctx).runGate(id)) };
}

export async function proposePublishOperation(ctx: FlowRunContext, options: Record<string, unknown>) {
  const id = productionIdOf(ctx, options);
  return { productionId: id, ...(await pipelineOf(ctx).proposePublish(id)) };
}
