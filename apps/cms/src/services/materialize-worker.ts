import { and, eq } from 'drizzle-orm';
import { materializedCollections, type Database } from '@heopress/database';
import type { QueueProvider } from '@heopress/runtime';
import { formatSafeError } from '@heopress/contracts/utils';
import { refreshPhysicalTable, type MaterializeConfig, type RefreshResult } from './materialize-service';
import { runSiteTransaction } from './rls-transaction';

/**
 * The consumer of `materialize-refresh` (HeoPress P14 task 5.3, design D5; spec platform/infrastructure-adapters
 * "入队的任务必有消费者" / "物化集合随内容刷新"). The item service queues one job per materialization of a collection
 * after a write (`triggerMaterializeRefresh`); before this worker existed nothing consumed them, so with a queue a
 * materialized collection was never refreshed.
 *
 * A job names the materialization by id and site. The worker reads its current definition in that site's scope (a
 * materialization deleted meanwhile is skipped; one changed meanwhile is refreshed as it is now), then truncates and
 * refills the physical table and records the row count in one site transaction. The TRUNCATE lock serialises
 * concurrent refreshes of one table, and a refresh rebuilds the table from the items, so a job delivered twice (the
 * queue is at least once) leaves the same result. A failure is recorded on the materialization and rethrown, so the
 * queue retries it.
 */

export const MATERIALIZE_REFRESH_QUEUE = 'materialize-refresh';

/** The payload `ItemService` queues: the materialization as it was at the write; only `id` and `siteId` are used. */
export interface MaterializeRefreshJob {
  config: Pick<MaterializeConfig, 'id' | 'siteId'> & Partial<MaterializeConfig>;
}

export interface MaterializeRefreshWorkerDeps {
  db: Database;
  queue?: QueueProvider;
}

/** Refresh one materialization; `null` when it no longer exists. */
export async function processMaterializeRefreshJob(db: Database, job: MaterializeRefreshJob): Promise<RefreshResult | null> {
  const id = job?.config?.id;
  const siteId = job?.config?.siteId;
  if (typeof id !== 'string' || !id || typeof siteId !== 'string' || !siteId) {
    throw new Error('materialize-refresh job without a materialization id and site');
  }
  try {
    return await runSiteTransaction(db, siteId, async (tx) => {
      const [mc] = await tx
        .select()
        .from(materializedCollections)
        .where(and(eq(materializedCollections.siteId, siteId), eq(materializedCollections.id, id)));
      if (!mc) return null;
      const result = await refreshPhysicalTable(tx as unknown as Database, {
        id: mc.id,
        siteId,
        collection: mc.collection,
        target: mc.target,
        refreshStrategy: mc.refreshStrategy,
        projection: mc.projection as MaterializeConfig['projection'],
        filter: mc.filter as MaterializeConfig['filter'],
      });
      await tx
        .update(materializedCollections)
        .set({ status: 'idle', error: null, rowCount: result.rowCount, lastRefreshedAt: result.lastRefreshedAt, updatedAt: new Date() })
        .where(and(eq(materializedCollections.siteId, siteId), eq(materializedCollections.id, id)));
      return result;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await runSiteTransaction(db, siteId, (tx) =>
      tx
        .update(materializedCollections)
        .set({ status: 'error', error: message, updatedAt: new Date() })
        .where(and(eq(materializedCollections.siteId, siteId), eq(materializedCollections.id, id))),
    ).catch(() => undefined);
    throw err;
  }
}

/** Long-lived consumer for `materialize-refresh` jobs (worker role). */
export function registerMaterializeRefreshWorker(deps: MaterializeRefreshWorkerDeps): void {
  deps.queue?.process<MaterializeRefreshJob>(MATERIALIZE_REFRESH_QUEUE, async (job) => {
    try {
      await processMaterializeRefreshJob(deps.db, job.data);
    } catch (err) {
      console.error('[materialize-refresh] job failed', { id: job.data?.config?.id, siteId: job.data?.config?.siteId, err: formatSafeError(err) });
      throw err;
    }
  });
}
