import { and, asc, eq } from 'drizzle-orm';
import { flows, ingestProcessingJobs, sites, type Database } from '@heopress/database';
import type { QueueProvider } from '@heopress/runtime';
import { FLOW_EVENTS_QUEUE } from '../flow-dispatch';
import { runSiteTransaction } from '../rls-transaction';

/**
 * The processing outbox's consumer (P15; `docs/known-issues.md` listed the gap since P14 task 5.3).
 *
 * `lumibase_ingest_processing_jobs` rows are written in the fetched document's transaction and stay `pending` until
 * something hands them to processing. The site's own flows are that processing: a flow whose first step is
 * `pipeline:fetch-source` takes source documents by id, admits them into the day's quota and continues through
 * translate/rewrite/write. So the dispatcher finds those active flows and enqueues one `flow:event` job per pending
 * row and flow — the same queue and worker that event-triggered flows use — then marks the row `enqueued`.
 *
 * It never invents a processing policy: a site with no such flow keeps its rows `pending` (nothing is configured to
 * process them), and a row is only marked once at least one job was enqueued for it. `FOR UPDATE SKIP LOCKED` plus
 * the `pending → enqueued` update make concurrent dispatchers take different rows; the flow run is at least once, and
 * a document processed twice is the flows' own idempotency question (a production is keyed by its source documents).
 */

const PROCESSING_DISPATCH_LIMIT = 20;
const SITES_PER_TICK = 50;

type GraphNode = { id: string; key: string; next?: string };

/** The active flows that admit source documents first: their id, in a stable order. */
export function processingFlows(rows: Array<{ id: string; status: string; graph: unknown }>): string[] {
  return rows
    .filter((f) => {
      if (f.status !== 'active') return false;
      const nodes = (f.graph as { nodes?: unknown } | null)?.nodes;
      return Array.isArray(nodes) && (nodes[0] as GraphNode | undefined)?.key === 'pipeline:fetch-source';
    })
    .map((f) => f.id)
    .sort();
}

export interface ProcessingDispatchResult {
  /** Rows marked `enqueued` by this tick. */
  dispatched: number;
  /** Jobs enqueued (one per row and matching flow). */
  jobs: number;
  /** Sites that had pending rows. */
  sites: number;
}

/**
 * Hand every pending outbox row to the site's processing flows. Without a queue nothing is dispatched (the rows stay
 * the durable record); a site with no matching flow is left untouched.
 */
export async function dispatchProcessingJobs(deps: {
  db: Database;
  queue?: QueueProvider;
  limit?: number;
  now?: () => Date;
}): Promise<ProcessingDispatchResult> {
  const empty = { dispatched: 0, jobs: 0, sites: 0 };
  if (!deps.queue) return empty;
  const limit = deps.limit ?? PROCESSING_DISPATCH_LIMIT;
  const now = deps.now?.() ?? new Date();

  // Sites with work: the sites table is platform-wide (no site scope needed to list it).
  const waiting = await deps.db.select({ id: sites.id }).from(sites).limit(SITES_PER_TICK);
  let dispatched = 0;
  let jobs = 0;
  let touched = 0;

  for (const site of waiting) {
    const result = await runSiteTransaction(deps.db, site.id, async (tx) => {
      const rows = await tx
        .select({ id: ingestProcessingJobs.id, sourceDocumentId: ingestProcessingJobs.sourceDocumentId })
        .from(ingestProcessingJobs)
        .where(
          and(
            eq(ingestProcessingJobs.siteId, site.id),
            eq(ingestProcessingJobs.status, 'pending'),
            eq(ingestProcessingJobs.kind, 'process'),
          ),
        )
        .orderBy(asc(ingestProcessingJobs.createdAt), asc(ingestProcessingJobs.id))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (!rows.length) return { dispatched: 0, jobs: 0 };
      const active = await tx
        .select({ id: flows.id, status: flows.status, graph: flows.graph })
        .from(flows)
        .where(and(eq(flows.siteId, site.id), eq(flows.status, 'active')));
      const targets = processingFlows(active);
      if (!targets.length) return { dispatched: 0, jobs: 0 };
      let enqueued = 0;
      for (const row of rows) {
        for (const flowId of targets) {
          await deps.queue!.enqueue(FLOW_EVENTS_QUEUE, 'flow:event', {
            siteId: site.id,
            flowId,
            input: { sourceDocumentIds: [row.sourceDocumentId] },
          });
          enqueued += 1;
        }
        await tx
          .update(ingestProcessingJobs)
          .set({ status: 'enqueued', enqueuedAt: now })
          .where(and(eq(ingestProcessingJobs.siteId, site.id), eq(ingestProcessingJobs.id, row.id)));
      }
      return { dispatched: rows.length, jobs: enqueued };
    });
    dispatched += result.dispatched;
    jobs += result.jobs;
    if (result.dispatched) touched += 1;
  }
  return { dispatched, jobs, sites: touched };
}
