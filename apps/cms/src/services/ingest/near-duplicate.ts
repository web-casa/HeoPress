import { and, desc, eq, gte } from 'drizzle-orm';
import { ingestDedupIndex } from '@heopress/database';
import { gatewayFor, type GatewayContext } from '../llm/bindings';
import type { LlmGateway } from '../llm/gateway';
import type { SiteTransaction } from '../rls-transaction';

/**
 * Near-duplicate detection (HeoPress P08 tasks 4.2, 4.3; spec ingest/deduplication "近似重复检测", design decision 7).
 *
 * The body (title + first 4,000 characters) is embedded by a `NearDuplicateEmbedder` (in production the model gateway's
 * `embedding` route, `gatewayEmbedder`) and compared by cosine similarity with recent documents embedded by the **same
 * model**, in the same site and in the other sites of the deployment. At or above the threshold (default 0.92,
 * `HEOPRESS_INGEST_NEAR_DUP_THRESHOLD`) the document is a near duplicate of the most similar earlier one.
 *
 * The comparison reads `lumibase_ingest_dedup_index` — embeddings and hashes only, no text — across sites: this module
 * is the controlled internal service of design "数据隔离与去重边界". What it finds about another site is stored on the
 * document and shown to a caller only after a live permission check on that site (`routes/ingest-documents.ts`).
 *
 * Candidates are the newest `candidateLimit` (default 500) entries of the last `windowDays` (default 30), compared in
 * the process. Without an embedder the check is skipped with a recorded reason, never guessed. (The P03 pgvector
 * store is not used: its purposes are visitor answers and writing aids, and it searches one site's active space.)
 */

export interface NearDuplicateEmbedder {
  /**
   * Embed a site's text. `model` names the model and dimension: vectors of different models are never compared. Null:
   * the site has no embedding model (the check is skipped with `no_embedding_provider`).
   */
  embed(input: { siteId: string; text: string }): Promise<{ embedding: number[]; model: string } | null>;
}

export interface NearDuplicateOptions {
  embedder: NearDuplicateEmbedder | null;
  threshold: number;
  windowDays: number;
  candidateLimit: number;
}

const DEFAULT_NEAR_DUP_THRESHOLD = 0.92;

/**
 * Embeddings through the P04 model gateway (ledger, budget, routing): the site's `embedding` provider list. A site
 * without one gets null (skipped), never a guess.
 */
export function gatewayEmbedder(gateway: Pick<LlmGateway, 'embed' | 'embeddingConfigured'>): NearDuplicateEmbedder {
  return {
    async embed({ siteId, text }) {
      if (!(await gateway.embeddingConfigured(siteId))) return null;
      const out = await gateway.embed({ siteId, origin: { kind: 'ingest_near_duplicate' }, text });
      return { embedding: out.embedding, model: `${out.model}:${out.embedding.length}` };
    },
  };
}

/**
 * The near-duplicate settings from the environment. Embedding a body is a model call and goes through the model
 * gateway: with a gateway context, each site's `embedding` provider list is used (sites without one skip the check
 * with `no_embedding_provider`); without one, no embedder. The threshold is `HEOPRESS_INGEST_NEAR_DUP_THRESHOLD`.
 */
export function nearDuplicateOptionsFromEnv(gateway?: GatewayContext, env: Record<string, string | undefined> = process.env): NearDuplicateOptions {
  const threshold = Number(env.HEOPRESS_INGEST_NEAR_DUP_THRESHOLD);
  return {
    embedder: gateway ? gatewayEmbedder(gatewayFor(gateway)) : null,
    threshold: Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : DEFAULT_NEAR_DUP_THRESHOLD,
    windowDays: 30,
    candidateLimit: 500,
  };
}

/** Cosine similarity; 0 for vectors of different lengths or zero length. */
function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

/** The text that is embedded. */
export function embeddingInput(title: string, bodyText: string): string {
  return `${title}\n\n${bodyText.slice(0, 4000)}`;
}

export type NearDuplicateResult =
  | { check: 'skipped'; reason: string }
  | { check: 'unique'; embedding: number[]; model: string }
  | { check: 'duplicate'; embedding: number[]; model: string; documentId: string; siteId: string; similarity: number; scope: 'same_site' | 'cross_site' };

/** Compare an embedding with the index. Run inside the document's transaction. */
export async function findNearDuplicate(
  tx: SiteTransaction,
  input: { siteId: string; embedding: number[]; model: string; now: Date },
  opts: Pick<NearDuplicateOptions, 'threshold' | 'windowDays' | 'candidateLimit'>,
): Promise<NearDuplicateResult> {
  const since = new Date(input.now.getTime() - opts.windowDays * 86_400_000);
  const rows = await tx
    .select({ documentId: ingestDedupIndex.documentId, siteId: ingestDedupIndex.siteId, embedding: ingestDedupIndex.embedding, createdAt: ingestDedupIndex.createdAt })
    .from(ingestDedupIndex)
    .where(and(eq(ingestDedupIndex.embeddingModel, input.model), gte(ingestDedupIndex.createdAt, since)))
    .orderBy(desc(ingestDedupIndex.createdAt))
    .limit(opts.candidateLimit);
  let best: { documentId: string; siteId: string; similarity: number; createdAt: Date } | null = null;
  for (const r of rows) {
    const similarity = cosineSimilarity(input.embedding, r.embedding);
    if (similarity < opts.threshold) continue;
    // The most similar; on a tie the earliest (the one that came first).
    if (!best || similarity > best.similarity || (similarity === best.similarity && r.createdAt < best.createdAt)) {
      best = { documentId: r.documentId, siteId: r.siteId, similarity, createdAt: r.createdAt };
    }
  }
  if (!best) return { check: 'unique', embedding: input.embedding, model: input.model };
  return {
    check: 'duplicate',
    embedding: input.embedding,
    model: input.model,
    documentId: best.documentId,
    siteId: best.siteId,
    similarity: Math.round(best.similarity * 10_000) / 10_000,
    scope: best.siteId === input.siteId ? 'same_site' : 'cross_site',
  };
}
