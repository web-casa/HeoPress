import { PgBoss } from 'pg-boss';
import type { Job, JobOptions, QueueProvider } from '../../interfaces';

/**
 * Durable job queue on PostgreSQL with pg-boss (HeoPress P03 task 3.1,
 * ADR-0002; spec platform/infrastructure-adapters "持久化任务队列").
 *
 * Jobs live in the `pgboss` schema, so a restart resumes whatever was queued
 * or in flight: delivery is at least once and handlers must be idempotent
 * (see `external-actions.ts` for side effects outside the database).
 *
 * Mapping from the upstream `QueueProvider` contract:
 *   - priority high / normal / low → pg-boss priority 2 / 1 / 0 (higher first);
 *   - `delay` (ms) → `startAfter` (seconds);
 *   - `attempts` → `retryLimit = attempts - 1`; `backoff` exponential or fixed
 *     → `retryBackoff` with `retryDelay` in seconds (minimum 1);
 *   - `jobName` travels in the payload envelope, since pg-boss names jobs by
 *     their queue.
 *
 * `singletonKey`: jobs that carry one go to a companion queue
 * `<queue>__singleton` created with pg-boss's `singleton` policy, so at most
 * one job per key is active at a time while any number may wait. Jobs without
 * a key stay on the standard queue — the singleton policy would otherwise
 * serialise the whole queue on the empty key.
 *
 * The schema is installed by the migrate script (table-owner role,
 * `installQueueSchema` below); the application connects with `migrate: false`.
 */

const QUEUE_SCHEMA = 'pgboss';
const SINGLETON_SUFFIX = '__singleton';

interface Envelope<T> {
  n: string;
  d: T;
}

export interface PgBossQueueOptions {
  /** Seconds between polls when idle (default 2). */
  pollingIntervalSeconds?: number;
  /** pg pool size for pg-boss (default 5). */
  max?: number;
  /** Install or upgrade the pgboss schema on start (default false: the migrate script does it). */
  migrate?: boolean;
  /** Run pg-boss maintenance (expiry, retention) in this process (default true). */
  supervise?: boolean;
  /** How often supervision fails jobs with stale heartbeats or past expiry (default 60 s). */
  superviseIntervalSeconds?: number;
  /**
   * Workers renew active jobs this often (pg-boss heartbeat, default 60 s): a
   * job whose worker died is retried after missing it, while a live worker's
   * long job is never handed to another worker (Codex review 2, #4). Only
   * applies to queues created by this version.
   */
  heartbeatSeconds?: number;
  /** Hard cap on one run (default 24 h); after it the job is retried. */
  expireInSeconds?: number;
}

function priorityOf(p: JobOptions['priority']): number {
  return p === 'high' ? 2 : p === 'low' ? 0 : 1;
}

function statusOf(state: string): Job['status'] {
  switch (state) {
    case 'active':
      return 'active';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'cancelled':
      return 'failed';
    default:
      return 'waiting'; // created, retry
  }
}

export class PgBossQueueProvider implements QueueProvider {
  private readonly boss: PgBoss;
  private started: Promise<void> | null = null;
  private readonly createdQueues = new Map<string, Promise<void>>();
  private readonly pollingIntervalSeconds: number;
  private readonly heartbeatSeconds: number;
  private readonly expireInSeconds: number;

  constructor(connectionString: string, options: PgBossQueueOptions = {}) {
    this.pollingIntervalSeconds = options.pollingIntervalSeconds ?? 2;
    this.heartbeatSeconds = options.heartbeatSeconds ?? 60;
    this.expireInSeconds = options.expireInSeconds ?? 86_400;
    this.boss = new PgBoss({
      connectionString,
      schema: QUEUE_SCHEMA,
      max: options.max ?? 5,
      migrate: options.migrate ?? false,
      createSchema: options.migrate ?? false,
      supervise: options.supervise ?? true,
      // A queue is checked once per max(monitor, supervise) interval, so both move together.
      ...(options.superviseIntervalSeconds
        ? { superviseIntervalSeconds: options.superviseIntervalSeconds, monitorIntervalSeconds: options.superviseIntervalSeconds }
        : {}),
      schedule: false,
      application_name: 'heopress-queue',
    });
    this.boss.on('error', (err: unknown) => {
      console.warn('[queue] pg-boss error:', err instanceof Error ? err.message : err);
    });
  }

  private start(): Promise<void> {
    if (!this.started) {
      this.started = this.boss.start().then(
        () => undefined,
        (err: unknown) => {
          this.started = null;
          throw err;
        },
      );
    }
    return this.started;
  }

  private ensureQueue(name: string, singleton: boolean): Promise<void> {
    let created = this.createdQueues.get(name);
    if (!created) {
      created = (async () => {
        await this.start();
        if (!(await this.boss.getQueue(name))) {
          await this.boss.createQueue(name, {
            policy: singleton ? 'singleton' : 'standard',
            heartbeatSeconds: this.heartbeatSeconds,
            expireInSeconds: this.expireInSeconds,
          });
        }
      })().catch((err: unknown) => {
        this.createdQueues.delete(name);
        throw err;
      });
      this.createdQueues.set(name, created);
    }
    return created;
  }

  supportsQueue(): boolean {
    return true;
  }

  async enqueue<T>(
    queueName: string,
    jobName: string,
    data: T,
    options?: JobOptions,
  ): Promise<string> {
    const singleton = Boolean(options?.singletonKey);
    const name = singleton ? `${queueName}${SINGLETON_SUFFIX}` : queueName;
    await this.ensureQueue(name, singleton);
    const attempts = Math.max(1, options?.attempts ?? 3);
    const backoff = options?.backoff ?? { type: 'exponential' as const, delay: 1000 };
    const id = await this.boss.send(name, { n: jobName, d: data } satisfies Envelope<T>, {
      priority: priorityOf(options?.priority),
      startAfter: options?.delay ? Math.ceil(options.delay / 1000) : undefined,
      retryLimit: attempts - 1,
      retryDelay: Math.max(1, Math.round(backoff.delay / 1000)),
      retryBackoff: backoff.type === 'exponential',
      singletonKey: options?.singletonKey,
    });
    if (!id) throw new Error(`queue ${name} refused the job (singleton or throttle policy)`);
    return id;
  }

  process<T>(queueName: string, handler: (job: Job<T>) => Promise<void>): void {
    for (const [name, singleton] of [
      [queueName, false],
      [`${queueName}${SINGLETON_SUFFIX}`, true],
    ] as const) {
      // One job per fetch, and pg-boss waits the polling interval after every
      // fetch, so a backlog would drain at one job per interval (1,000 search
      // index jobs: about half an hour). After each job the worker is woken
      // to fetch again at once; an empty fetch calls no handler, so an idle
      // queue goes back to polling.
      let workerId: string | undefined;
      void this.ensureQueue(name, singleton)
        .then(async () => {
          workerId = await this.boss.work<Envelope<T>>(
            name,
            { batchSize: 1, pollingIntervalSeconds: this.pollingIntervalSeconds },
            async ([job]) => {
              if (!job) return;
              try {
                await handler({
                  id: job.id,
                  name: job.data.n,
                  data: job.data.d,
                  status: 'active',
                  attempt: job.retryCount + 1,
                  signal: job.signal,
                });
              } finally {
                if (workerId) this.boss.notifyWorker(workerId);
              }
            },
          );
        })
        .catch((err: unknown) => {
          console.error(`[queue] could not start a worker for ${name}:`, err instanceof Error ? err.message : err);
        });
    }
  }

  async getStatus(queueName: string, jobId: string): Promise<Job | null> {
    await this.start();
    for (const name of [queueName, `${queueName}${SINGLETON_SUFFIX}`]) {
      if (!(await this.boss.getQueue(name))) continue;
      const job = await this.boss.getJobById<Envelope<unknown>>(name, jobId);
      if (job) {
        return { id: job.id, name: job.data.n, data: job.data.d, status: statusOf(job.state) };
      }
    }
    return null;
  }

  async ping(): Promise<boolean> {
    await this.start();
    await this.boss.getQueues(['__heopress_ping']);
    return true;
  }

  /** Stop workers, waiting for active handlers (graceful shutdown). */
  async close(): Promise<void> {
    if (this.started) await this.boss.stop({ graceful: true, timeout: 10_000 });
    this.started = null;
    this.createdQueues.clear();
  }
}

/**
 * Install or upgrade the pg-boss schema. Run by the migrate script
 * (packages/database/scripts/migrate.ts) as the table owner, so the
 * application role needs no CREATE privilege.
 */
export async function installQueueSchema(connectionString: string): Promise<void> {
  const boss = new PgBoss({
    connectionString,
    schema: QUEUE_SCHEMA,
    max: 1,
    migrate: true,
    createSchema: true,
    supervise: false,
    schedule: false,
  });
  boss.on('error', () => {});
  await boss.start();
  await boss.stop({ graceful: false, timeout: 1000 });
}
