/**
 * The queue registry (HeoPress P14 task 5.2, design D5; spec platform/infrastructure-adapters "入队的任务必有消费者").
 *
 * Every queue the application may enqueue to is listed here, with whether it also takes jobs with a `singletonKey`
 * (those go to the companion queue `<name>__singleton`). `PgBossQueueProvider.enqueue` refuses any other name, so a
 * job can no longer be queued where no worker reads it. The CMS wiring test (`apps/cms/src/__tests__/queue-consumers.
 * wiring.test.ts`) checks the other half: the worker role registers a consumer for every queue listed here, and every
 * `enqueue(` in the source names one of them.
 *
 * A queue added here needs its consumer in the same change. A queue that is retired moves to `ABANDONED_QUEUES`, whose
 * leftover jobs and queue rows the migration step removes (`installQueueSchema`).
 *
 * Plain TypeScript without enums or parameter properties: `docker/scripts/accept-mixed-load.mjs` imports this file
 * with Node's type stripping.
 */

export interface QueueDefinition {
  /** Jobs may carry a `singletonKey` (at most one active job per key). */
  readonly singleton: boolean;
}

export const QUEUE_REGISTRY = {
  /** Async agent runs (`services/agent-run-worker.ts`). */
  'agent-runs': { singleton: false },
  /** Veto-window commits (`services/veto-commit-worker.ts`). */
  'agent-veto-commits': { singleton: false },
  /** Batched audit-log writes (`modules/audit/worker.ts`). */
  'audit-log': { singleton: false },
  /** Wakes the event consumers and the Change Feed dispatch (`modules/events/consumer-worker.ts`). */
  'cdc-dispatch': { singleton: false },
  /** The scheduler tick (`services/scheduler-worker.ts`). */
  'content-scheduler': { singleton: false },
  /** Deployment status polling (`services/deployment/status-poller.ts`). */
  'deployment-status': { singleton: false },
  /** Envelope-encryption migration of a site (`services/envelope-migration-worker.ts`). */
  'encryption-envelope-migration': { singleton: false },
  /** Event- and schedule-triggered flows (`services/flow-dispatch.ts`). */
  'flow-events': { singleton: false },
  /** Manual flow runs and async AI chat (`services/flow-run-service.ts`). */
  'flow-runs': { singleton: false },
  /** URL fetches of content sources (`services/ingest/url-runner.ts`). */
  'ingest-fetch': { singleton: true },
  /** Runs of due content sources (`services/ingest/source-worker.ts`). */
  'ingest-sources': { singleton: true },
  /** Refreshes of materialized collections after writes (`services/materialize-worker.ts`). */
  'materialize-refresh': { singleton: false },
  /** Scheduled and queued plugin jobs (`extensions/runtime/jobs.ts`). */
  'plugin-jobs': { singleton: true },
  /** ISR revalidation dispatch (`services/content-invalidation.ts`). */
  'revalidation-dispatch': { singleton: false },
  /** Durable translation jobs (`apps/cms/src/services/translation-job-worker.ts`). */
  'translation-jobs': { singleton: false },
} as const satisfies Record<string, QueueDefinition>;

export type RegisteredQueueName = keyof typeof QUEUE_REGISTRY;

/**
 * Queues that were enqueued to without any consumer and are no longer used (P14 task 5.4): image thumbnails
 * (`media-processing`, design D5), schema events (`schema-events`), agent dead letters (`agent-dead-letter`, now a
 * system event), the URL-ingest processing outbox (`ingest-process`, its rows stay in
 * `lumibase_ingest_processing_jobs`), the `cdc` pageview strategy's emit (`pageview-cdc`) and the health check's
 * fallback probe (`_health`). The migration step deletes their jobs and queue rows, singleton companions included.
 */
export const ABANDONED_QUEUES = [
  'media-processing',
  'schema-events',
  'agent-dead-letter',
  'ingest-process',
  'pageview-cdc',
  '_health',
] as const;

/** The companion queue that holds a queue's jobs with a `singletonKey`. */
export const SINGLETON_QUEUE_SUFFIX = '__singleton';

/** A lookup from queue name to its definition; `undefined` for a name that is not registered. */
export type QueueRegistryLookup = (queueName: string) => QueueDefinition | undefined;

export function isRegisteredQueue(queueName: string): queueName is RegisteredQueueName {
  return Object.prototype.hasOwnProperty.call(QUEUE_REGISTRY, queueName);
}

/** The default lookup: `QUEUE_REGISTRY`. */
export const registeredQueue: QueueRegistryLookup = (queueName) =>
  isRegisteredQueue(queueName) ? QUEUE_REGISTRY[queueName] : undefined;

export class UnregisteredQueueError extends Error {
  readonly queueName: string;

  constructor(queueName: string, reason: 'unregistered' | 'not-singleton') {
    super(
      reason === 'unregistered'
        ? `queue "${queueName}" is not registered (packages/runtime/src/queue-registry.ts): nothing consumes it`
        : `queue "${queueName}" is not registered for jobs with a singletonKey (packages/runtime/src/queue-registry.ts)`,
    );
    this.name = 'UnregisteredQueueError';
    this.queueName = queueName;
  }
}

/** Throws unless `queueName` is registered (and, for a job with a singleton key, registered as singleton). */
export function assertEnqueueable(lookup: QueueRegistryLookup, queueName: string, singleton: boolean): void {
  const def = lookup(queueName);
  if (!def) throw new UnregisteredQueueError(queueName, 'unregistered');
  if (singleton && !def.singleton) throw new UnregisteredQueueError(queueName, 'not-singleton');
}
