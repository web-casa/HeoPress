import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { FailureCategory } from '@heopress/contracts/schemas';
import {
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
import type { FetchedPage } from './fetcher';
import { writeSnapshot } from './snapshot-store';

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

async function assertOwnership(tx: SiteTransaction, siteId: string, run: RunOwnership | null): Promise<void> {
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
  operationId: string;
  url: string;
  page: FetchedPage;
  extracted: ExtractedDocument;
  startedAt: Date;
  fetchMethod?: string;
  fetchProvider?: string;
}

export interface RegisterDeps {
  db: Database;
  storage: StorageProvider;
  now?: () => Date;
  /** Test hook: runs inside the transaction after every insert, before the commit. */
  beforeCommit?: () => Promise<void> | void;
}

export async function registerSourceDocument(deps: RegisterDeps, input: RegisterInput): Promise<{ documentId: string; duplicate: boolean; snapshotId: string }> {
  const snapshot = await writeSnapshot(deps, input.siteId, input.page.body);
  const now = deps.now?.() ?? new Date();
  const method = input.fetchMethod ?? 'native';
  const provider = input.fetchProvider ?? 'native';
  const { extracted: x, page } = input;
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
        runId: input.run?.runId ?? null,
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
        return { documentId: existing.id, duplicate: true, snapshotId: existing.snapshotId };
      }
      const [source] = await tx
        .select()
        .from(ingestSources)
        .where(and(eq(ingestSources.siteId, input.siteId), eq(ingestSources.id, input.sourceId)));
      if (!source) throw new Error(`source ${input.sourceId} no longer exists`);
      const [doc] = await tx
        .insert(ingestSourceDocuments)
        .values({
          siteId: input.siteId,
          sourceId: input.sourceId,
          runId: input.run?.runId ?? null,
          operationId: input.operationId,
          url: input.url,
          normalizedUrl: input.url,
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
        })
        .returning({ id: ingestSourceDocuments.id });
      await tx.insert(ingestFetchAttempts).values({ ...attempt, outcome: 'succeeded', sourceDocumentId: doc!.id });
      await tx.insert(ingestProcessingJobs).values({ siteId: input.siteId, sourceDocumentId: doc!.id, createdAt: now });
      await appendItemEvent(tx, {
        siteId: input.siteId,
        resource: 'source_document',
        collection: SOURCE_DOCUMENTS_COLLECTION,
        itemId: doc!.id,
        itemVersion: null,
        operation: 'create',
        changedFields: [],
        source: 'system',
        payload: { sourceId: input.sourceId, snapshotSha256: snapshot.sha256, extractionRuleVersion: x.ruleVersion },
      });
      await deps.beforeCommit?.();
      return { documentId: doc!.id, duplicate: false, snapshotId: snapshot.id };
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
      runId: input.run?.runId ?? null,
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
