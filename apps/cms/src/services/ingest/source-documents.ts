import { createHash } from 'node:crypto';
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import type { FailureCategory } from '@heopress/contracts/schemas';
import {
  ingestDedupIndex,
  ingestEventClusters,
  ingestFetchAttempts,
  ingestProcessingJobs,
  ingestSourceDocuments,
  ingestSourceRuns,
  ingestSources,
  type Database,
} from '@heopress/database';
import type { QueueProvider, StorageProvider } from '@heopress/runtime';
import { appendItemEvent } from '../../modules/cdc/change-feed/outbox-writer';
import { runSiteTransaction, type SiteTransaction } from '../rls-transaction';
import type { ExtractedDocument } from './extract';
import { entitiesFromList, eventFingerprint, extractEntities, sameEvent } from './event-cluster';
import type { FetchedPage } from './fetcher';
import { embeddingInput, findNearDuplicate, type NearDuplicateOptions, type NearDuplicateResult } from './near-duplicate';
import { recordResearchLeads } from './research-leads';
import { writeSnapshot } from './snapshot-store';
import { registerDocumentMedia } from './source-media';
import { effectiveUsage } from './usage';
import { DEFAULT_TRACKING_PARAMS, normalizeUrl } from './url-normalize';

/**
 * Registering a source document (HeoPress P08 task 2.7; spec ingest/crawling "规则版本与可恢复登记").
 *
 * The snapshot is written first (`writeSnapshot`: registered row, then the object — idempotent per content). Then one
 * transaction, in the site's scope:
 *
 *   - checks the run is still this worker's (generation, still running) — a worker that lost the run writes nothing;
 *   - finds the operation's document: same content → the existing one (a retry after a crash); different content →
 *     `ReplayMismatchError`;
 *   - inserts the document (with the source's terms at fetch time), its fetch attempt, its processing job (outbox)
 *     and its `source_document.create` change event (ADR-0011).
 *
 * Any failure rolls all of it back; the snapshot stays an orphan until a retry reuses it or the sweeper removes it.
 *
 * Deduplication (HeoPress P08 tasks 4.1–4.4), in the same transaction under a per-site lock:
 *
 *   - exact: the site already has a document with the same normalised-body hash (or, through an adopted same-origin
 *     canonical, at the same URL with the same content) → no second document, the attempt is a `duplicate`;
 *   - near: the body embedding (computed before the transaction) against the deployment-wide index → flagged on the
 *     document (`near-duplicate.ts`), never dropped;
 *   - event: matched against the site's open event clusters → a `supplementary` member gets no processing job, a new
 *     cluster's `representative` does (`event-cluster.ts`).
 */

const SOURCE_DOCUMENTS_COLLECTION = 'ingest_source_documents';
const PROCESSING_QUEUE = 'ingest-process';

/** The worker no longer owns the run: its writes are refused. */
export class StaleRunError extends Error {
  constructor() {
    super('the run was taken over by another worker; this worker may no longer write its results');
    this.name = 'StaleRunError';
  }
}

/** The same operation came back with different content. */
export class ReplayMismatchError extends Error {
  constructor(readonly operationId: string) {
    super(`operation ${operationId} was already registered with different content`);
    this.name = 'ReplayMismatchError';
  }
}

export interface RunOwnership {
  runId: string;
  generation: number;
}

/** The operation identifier of fetching `url` for a source's slot: stable across retries of that slot. */
export function operationIdFor(sourceId: string, scheduledFor: string, url: string): string {
  return `${sourceId}:${scheduledFor}:${createHash('sha256').update(url).digest('hex').slice(0, 32)}`;
}

export async function assertOwnership(tx: SiteTransaction, siteId: string, run: RunOwnership | null): Promise<void> {
  if (!run) return;
  const [row] = await tx
    .select({ id: ingestSourceRuns.id })
    .from(ingestSourceRuns)
    .where(
      and(
        eq(ingestSourceRuns.siteId, siteId),
        eq(ingestSourceRuns.id, run.runId),
        eq(ingestSourceRuns.generation, run.generation),
        eq(ingestSourceRuns.outcome, 'running'),
      ),
    )
    .for('update');
  if (!row) throw new StaleRunError();
}

export interface RegisterInput {
  siteId: string;
  sourceId: string;
  run: RunOwnership | null;
  /** The run the document came from when `run` (ownership) is not checked — a discovered URL's fetch job. */
  runId?: string | null;
  operationId: string;
  url: string;
  page: FetchedPage;
  extracted: ExtractedDocument;
  startedAt: Date;
  fetchMethod?: string;
  fetchProvider?: string;
}

export interface DedupOptions {
  trackingParams?: readonly string[];
  nearDuplicate?: NearDuplicateOptions;
  /** Half-width of the event time window (default 48 hours). */
  eventWindowHours?: number;
}

export interface RegisterDeps {
  db: Database;
  storage: StorageProvider;
  dedup?: DedupOptions;
  now?: () => Date;
  /** Test hook: runs inside the transaction after every insert, before the commit. */
  beforeCommit?: () => Promise<void> | void;
}

export interface RegisterResult {
  documentId: string;
  duplicate: boolean;
  snapshotId: string;
  /** Why it is a duplicate: the same operation came back, or the site already had this content. */
  duplicateReason?: 'operation' | 'content';
}

/** A per-site transaction lock serialising deduplication decisions. */
async function lockSiteDedup(tx: SiteTransaction, siteId: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ingest-dedup:${siteId}`}, 0))`);
}

async function embedFor(deps: RegisterDeps, siteId: string, x: ExtractedDocument): Promise<{ embedding: number[]; model: string } | { skipped: string }> {
  const nd = deps.dedup?.nearDuplicate;
  if (!nd?.embedder) return { skipped: 'no_embedding_provider' };
  try {
    const out = await nd.embedder.embed({ siteId, text: embeddingInput(x.title, x.bodyText) });
    if (!out) return { skipped: 'no_embedding_provider' };
    if (!out.embedding.length) return { skipped: 'embedding_failed' };
    return out;
  } catch {
    return { skipped: 'embedding_failed' };
  }
}

export async function registerSourceDocument(deps: RegisterDeps, input: RegisterInput): Promise<RegisterResult> {
  const snapshot = await writeSnapshot(deps, input.siteId, input.page.body);
  const now = deps.now?.() ?? new Date();
  const method = input.fetchMethod ?? 'native';
  const provider = input.fetchProvider ?? 'native';
  const { extracted: x, page } = input;
  const params = deps.dedup?.trackingParams ?? DEFAULT_TRACKING_PARAMS;
  const normalizedUrl = normalizeUrl(input.url, params) ?? input.url;
  // Skip the (paid, outbound) embedding when the content is already known; the transaction decides for real.
  const known = await runSiteTransaction(deps.db, input.siteId, async (tx) =>
    (await tx
      .select({ id: ingestSourceDocuments.id })
      .from(ingestSourceDocuments)
      .where(and(eq(ingestSourceDocuments.siteId, input.siteId), eq(ingestSourceDocuments.contentHash, x.contentHash)))
      .limit(1)).length > 0,
  );
  const vector = known ? { skipped: 'exact_duplicate' } : await embedFor(deps, input.siteId, x);
  return runSiteTransaction(
    deps.db,
    input.siteId,
    async (tx) => {
      await assertOwnership(tx, input.siteId, input.run);
      const [existing] = await tx
        .select({ id: ingestSourceDocuments.id, contentHash: ingestSourceDocuments.contentHash, snapshotId: ingestSourceDocuments.snapshotId })
        .from(ingestSourceDocuments)
        .where(and(eq(ingestSourceDocuments.siteId, input.siteId), eq(ingestSourceDocuments.operationId, input.operationId)));
      const attempt = {
        siteId: input.siteId,
        sourceId: input.sourceId,
        runId: input.run?.runId ?? input.runId ?? null,
        operationId: input.operationId,
        url: input.url,
        finalUrl: page.finalUrl,
        fetchMethod: method,
        fetchProvider: provider,
        httpStatus: page.status,
        bytes: page.body.byteLength,
        durationMs: page.durationMs,
        startedAt: input.startedAt,
        finishedAt: now,
      };
      if (existing) {
        if (existing.contentHash !== x.contentHash) throw new ReplayMismatchError(input.operationId);
        await tx.insert(ingestFetchAttempts).values({ ...attempt, outcome: 'duplicate', sourceDocumentId: existing.id });
        return { documentId: existing.id, duplicate: true, snapshotId: existing.snapshotId, duplicateReason: 'operation' as const };
      }
      await lockSiteDedup(tx, input.siteId);
      // Exact duplicate (task 4.1): the same normalised body is already in this site. This is also the only way a
      // page's canonical is "adopted": a canonical merges two URLs only when their content is the same, so a
      // canonical candidate alone (cross-origin, other case, other query) never merges anything and is never fetched.
      const [same] = await tx
        .select({ id: ingestSourceDocuments.id, snapshotId: ingestSourceDocuments.snapshotId })
        .from(ingestSourceDocuments)
        .where(and(eq(ingestSourceDocuments.siteId, input.siteId), eq(ingestSourceDocuments.contentHash, x.contentHash)))
        .orderBy(asc(ingestSourceDocuments.createdAt))
        .limit(1);
      if (same) {
        await tx.insert(ingestFetchAttempts).values({ ...attempt, outcome: 'duplicate', message: 'the site already has this content', sourceDocumentId: same.id });
        return { documentId: same.id, duplicate: true, snapshotId: same.snapshotId, duplicateReason: 'content' as const };
      }

      const [source] = await tx
        .select()
        .from(ingestSources)
        .where(and(eq(ingestSources.siteId, input.siteId), eq(ingestSources.id, input.sourceId)));
      if (!source) throw new Error(`source ${input.sourceId} no longer exists`);

      // Near duplicate (task 4.2).
      let near: NearDuplicateResult;
      if ('skipped' in vector) near = { check: 'skipped', reason: vector.skipped };
      else {
        const nd = deps.dedup!.nearDuplicate!;
        near = await findNearDuplicate(tx, { siteId: input.siteId, embedding: vector.embedding, model: vector.model, now }, nd);
      }

      // Event cluster (task 4.4).
      const entities = extractEntities(x.title, x.bodyText);
      const eventAt = x.publishedAt ?? input.startedAt;
      const windowMs = (deps.dedup?.eventWindowHours ?? 48) * 3_600_000;
      let cluster: { id: string; role: 'representative' | 'supplementary' } | null = null;
      if (entities.strong.length) {
        const candidates = await tx
          .select()
          .from(ingestEventClusters)
          .where(
            and(
              eq(ingestEventClusters.siteId, input.siteId),
              gte(ingestEventClusters.lastSeenAt, new Date(eventAt.getTime() - windowMs)),
              lte(ingestEventClusters.firstSeenAt, new Date(eventAt.getTime() + windowMs)),
            ),
          )
          .orderBy(asc(ingestEventClusters.createdAt))
          .limit(200);
        const match = candidates.find((c) => sameEvent(entities, entitiesFromList(c.entities)));
        if (match) {
          await tx
            .update(ingestEventClusters)
            .set({
              memberCount: sql`${ingestEventClusters.memberCount} + 1`,
              firstSeenAt: eventAt < match.firstSeenAt ? eventAt : match.firstSeenAt,
              lastSeenAt: eventAt > match.lastSeenAt ? eventAt : match.lastSeenAt,
            })
            .where(and(eq(ingestEventClusters.siteId, input.siteId), eq(ingestEventClusters.id, match.id)));
          cluster = { id: match.id, role: 'supplementary' };
        }
      }

      const [doc] = await tx
        .insert(ingestSourceDocuments)
        .values({
          siteId: input.siteId,
          sourceId: input.sourceId,
          runId: input.run?.runId ?? input.runId ?? null,
          operationId: input.operationId,
          url: input.url,
          normalizedUrl,
          finalUrl: page.finalUrl,
          title: x.title,
          author: x.author,
          publishedAt: x.publishedAt,
          language: x.language,
          canonicalCandidate: x.canonicalCandidate,
          bodyHtml: x.bodyHtml,
          bodyText: x.bodyText,
          contentHash: x.contentHash,
          snapshotId: snapshot.id,
          extractionRuleVersion: x.ruleVersion,
          hiddenContent: x.hiddenContent,
          fetchMethod: method,
          fetchProvider: provider,
          httpStatus: page.status,
          licenceStatus: source.licenceStatus,
          usageMode: source.usageMode,
          commercialUse: source.commercialUse,
          licenceRevisionId: source.licenceRevisionId,
          fetchedAt: input.startedAt,
          createdAt: now,
          nearDuplicateCheck: near.check,
          nearDuplicateReason: near.check === 'skipped' ? near.reason : null,
          duplicateOf: near.check === 'duplicate' ? near.documentId : null,
          duplicateSimilarity: near.check === 'duplicate' ? near.similarity : null,
          duplicateScope: near.check === 'duplicate' ? near.scope : null,
          duplicateSiteId: near.check === 'duplicate' && near.scope === 'cross_site' ? near.siteId : null,
          eventEntities: entities.all,
        })
        .returning({ id: ingestSourceDocuments.id });
      const documentId = doc!.id;
      if (!cluster && entities.strong.length) {
        const [created] = await tx
          .insert(ingestEventClusters)
          .values({
            siteId: input.siteId,
            fingerprint: eventFingerprint(entities),
            entities: entities.all,
            representativeDocumentId: documentId,
            firstSeenAt: eventAt,
            lastSeenAt: eventAt,
            createdAt: now,
          })
          .returning({ id: ingestEventClusters.id });
        cluster = { id: created!.id, role: 'representative' };
      }
      if (cluster) {
        await tx
          .update(ingestSourceDocuments)
          .set({ eventClusterId: cluster.id, clusterRole: cluster.role })
          .where(and(eq(ingestSourceDocuments.siteId, input.siteId), eq(ingestSourceDocuments.id, documentId)));
      }
      if (near.check !== 'skipped') {
        await tx.insert(ingestDedupIndex).values({ documentId, siteId: input.siteId, contentHash: x.contentHash, embeddingModel: near.model, embedding: near.embedding, createdAt: now });
      }
      await tx.insert(ingestFetchAttempts).values({ ...attempt, outcome: 'succeeded', sourceDocumentId: documentId });
      // A document of a source whose usage in effect is discovery only is a lead (task 1.7): its body never enters
      // processing (its job is `lead`: title and link only), and its links to the site's primary sources become
      // research leads, fetched later as documents of their own sources.
      const leadOnly = effectiveUsage(source, now) === 'discovery_only';
      if (leadOnly) await recordResearchLeads(tx, { siteId: input.siteId, sourceId: input.sourceId, documentId, bodyHtml: x.bodyHtml, trackingParams: params, now });
      // The images it references (task 2.9): recorded now, each processed on its own afterwards.
      await registerDocumentMedia(tx, { siteId: input.siteId, documentId, bodyHtml: x.bodyHtml, trackingParams: params, now });
      // One representative per event goes to processing; supplementary members are read through their cluster.
      if (cluster?.role !== 'supplementary') {
        await tx.insert(ingestProcessingJobs).values({ siteId: input.siteId, sourceDocumentId: documentId, kind: leadOnly ? 'lead' : 'process', createdAt: now });
      }
      await appendItemEvent(tx, {
        siteId: input.siteId,
        resource: 'source_document',
        collection: SOURCE_DOCUMENTS_COLLECTION,
        itemId: documentId,
        itemVersion: null,
        operation: 'create',
        changedFields: [],
        source: 'system',
        payload: { sourceId: input.sourceId, snapshotSha256: snapshot.sha256, extractionRuleVersion: x.ruleVersion },
      });
      await deps.beforeCommit?.();
      return { documentId, duplicate: false, snapshotId: snapshot.id };
    },
    { retry: false },
  );
}

/** A failed fetch, recorded by the run's owner only. */
export async function recordFailedAttempt(
  deps: { db: Database; now?: () => Date },
  input: {
    siteId: string;
    sourceId: string;
    run: RunOwnership | null;
    runId?: string | null;
    operationId: string;
    url: string;
    finalUrl?: string | null;
    category: FailureCategory;
    message: string;
    httpStatus?: number | null;
    startedAt: Date;
    fetchMethod?: string;
    fetchProvider?: string;
  },
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await runSiteTransaction(deps.db, input.siteId, async (tx) => {
    await assertOwnership(tx, input.siteId, input.run);
    await tx.insert(ingestFetchAttempts).values({
      siteId: input.siteId,
      sourceId: input.sourceId,
      runId: input.run?.runId ?? input.runId ?? null,
      operationId: input.operationId,
      url: input.url,
      finalUrl: input.finalUrl ?? null,
      fetchMethod: input.fetchMethod ?? 'native',
      fetchProvider: input.fetchProvider ?? 'native',
      outcome: 'failed',
      failureCategory: input.category,
      message: input.message.slice(0, 1000),
      httpStatus: input.httpStatus ?? null,
      durationMs: now.getTime() - input.startedAt.getTime(),
      startedAt: input.startedAt,
      finishedAt: now,
    });
  });
}

/**
 * Hand pending processing jobs of a site to the queue (the outbox's dispatcher). The consumer is P09; until it is
 * registered the jobs wait on the queue. A row is marked `enqueued` after the queue accepted it; a crash in between
 * enqueues it again (consumers are idempotent per source document).
 */
export async function dispatchProcessingJobs(deps: { db: Database; queue?: QueueProvider; now?: () => Date }, siteId: string, limit = 100): Promise<number> {
  if (!deps.queue) return 0;
  const pending = await runSiteTransaction(deps.db, siteId, (tx) =>
    tx
      .select({ id: ingestProcessingJobs.id, sourceDocumentId: ingestProcessingJobs.sourceDocumentId, kind: ingestProcessingJobs.kind })
      .from(ingestProcessingJobs)
      .where(and(eq(ingestProcessingJobs.siteId, siteId), eq(ingestProcessingJobs.status, 'pending')))
      .limit(limit),
  );
  let n = 0;
  for (const job of pending) {
    await deps.queue.enqueue(PROCESSING_QUEUE, job.kind, { siteId, sourceDocumentId: job.sourceDocumentId, jobId: job.id }, { singletonKey: `ingest-process:${job.sourceDocumentId}` });
    await runSiteTransaction(deps.db, siteId, (tx) =>
      tx
        .update(ingestProcessingJobs)
        .set({ status: 'enqueued', enqueuedAt: deps.now?.() ?? new Date() })
        .where(and(eq(ingestProcessingJobs.siteId, siteId), eq(ingestProcessingJobs.id, job.id))),
    );
    n++;
  }
  return n;
}
