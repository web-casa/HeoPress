// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
export interface JobOptions {
  priority?: 'high' | 'normal' | 'low';
  delay?: number;
  attempts?: number;
  backoff?: { type: 'exponential' | 'fixed'; delay: number };
  /**
   * At most one job with the same key is active at a time; others wait
   * (P03, spec "同站点任务互斥"). E.g. `ingest:<siteId>`.
   */
  singletonKey?: string;
}

export interface Job<T = unknown> {
  id: string;
  name: string;
  data: T;
  status: 'waiting' | 'active' | 'completed' | 'failed';
  /** 1 on the first delivery, 2 on the first retry, … (delivery is at least once). */
  attempt?: number;
  /** Aborted when the queue gives up on this run (expiry, shutdown); stop at a safe point. */
  signal?: AbortSignal;
}

export interface QueueProvider {
  /** Static routing check for runtimes with explicitly provisioned queues. */
  supportsQueue?(queueName: string): boolean;
  enqueue<T>(queueName: string, jobName: string, data: T, options?: JobOptions): Promise<string>;
  process<T>(queueName: string, handler: (job: Job<T>) => Promise<void>): void;
  getStatus(queueName: string, jobId: string): Promise<Job | null>;
  /** Cheap reachability check for readiness probes (P03). */
  ping?(): Promise<boolean>;
  /** Stop workers, letting active jobs finish (graceful shutdown). */
  close?(): Promise<void>;
  /**
   * Stop fetching jobs and wait for the active ones to finish, keeping the registrations (HeoPress P13 upgrade write
   * freeze); `resume` starts fetching again. Idempotent.
   */
  pause?(): Promise<void>;
  resume?(): Promise<void>;
}
