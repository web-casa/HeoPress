import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ThemeViewModel } from '@heopress/contracts/theme';
import type { ThemeAsset } from './engine.ts';
import type { PreviewPolicy, SystemContent } from './postprocess.ts';
import type { RenderReply, RenderRequest, WorkerReady } from './render-worker.ts';

/**
 * The rendering pool (HeoPress P06 tasks 2.2, 2.6, 4.1; design §3, R3, R21, R33, R37): theme renders run
 * in worker threads, one render per worker at a time, so a template that loops forever is actually
 * stopped (the worker is terminated and replaced — not a `Promise.race`) and never holds the event loop.
 *
 *   - Fair admission: each site has its own queue; workers take from the sites in turn. The pool has a
 *     global capacity in jobs and bytes; a site may hold `max(2, ⌊C / (queued sites + 1)⌋)` jobs. When
 *     full, the newest job of the site with the most queued is refused (its request gets the site's 503),
 *     so one site filling the queue does not keep another out. A job larger than the per-job limit is
 *     refused outright.
 *   - Timeouts: wall clock per render (terminate, wait for the exit, start a new worker; a late result is
 *     dropped) and per queue wait.
 *   - Workers get no environment and bounded V8 heaps; a crashed worker is replaced after a backoff.
 *     `resourceLimits` bound the V8 heap only, not external memory: the pool's budget is
 *     workers × heap + the byte limits above.
 */

export interface RenderJob {
  siteId: string;
  /** Immutable theme version id: workers cache the parsed templates under it. */
  versionId: string;
  templates: Record<string, string>;
  /** The version's asset manifest (`asset_url`). */
  assets?: ThemeAsset[];
  /** Where `asset_url` points (default `/_theme/`; the preview serves assets under its own path). */
  assetBase?: string;
  /** A preview render: the final HTML is also stripped of what could carry the draft away (R29). */
  preview?: PreviewPolicy;
  entry: string;
  vm: ThemeViewModel;
  system: SystemContent;
}

export interface RenderPoolOptions {
  workers?: number;
  /** Wall-clock limit of one render, ms. */
  timeoutMs?: number;
  /** The engine's own render-time limit, ms (cooperative; below `timeoutMs`). */
  renderLimitMs?: number;
  /**
   * Longest a job may wait before a worker takes it, ms — the whole admission wait, including a worker
   * that is still starting (start-up is excluded from `timeoutMs`, not from this).
   */
  queueTimeoutMs?: number;
  /** Longest a new worker may take to load before it is replaced, ms. */
  startupTimeoutMs?: number;
  /** The worker module (tests only; default: the bundled or source render worker next to this file). */
  workerUrl?: URL;
  /** Global capacity: queued jobs. */
  maxQueued?: number;
  /** Global capacity: bytes of queued jobs. */
  maxQueuedBytes?: number;
  /** One job's size limit, bytes. */
  maxJobBytes?: number;
  /** V8 heap limit of a worker, MB. */
  heapMb?: number;
  /** Renders of one site running at the same time (R3). */
  maxActivePerSite?: number;
}

export class RenderError extends Error {
  constructor(
    readonly code: 'RENDER_TIMEOUT' | 'RENDER_QUEUE_FULL' | 'RENDER_TOO_LARGE' | 'RENDER_CRASHED' | 'RENDER_CLOSED' | string,
    message: string,
  ) {
    super(message);
    this.name = 'RenderError';
  }
}

interface Task {
  job: RenderJob;
  bytes: number;
  resolve: (html: string) => void;
  reject: (err: Error) => void;
  queueTimer?: NodeJS.Timeout;
}

interface Slot {
  worker: Worker | null;
  /** The worker has loaded and said so: only then does it get jobs (start-up is not render time). */
  ready: boolean;
  /** Replaces a worker that does not become ready in time (stuck while loading). */
  startTimer?: NodeJS.Timeout;
  task: Task | null;
  requestId: number;
  timer?: NodeJS.Timeout;
  backoffMs: number;
}

/**
 * Resolved when a worker starts, not at import: bundles that never render (the CMS) may not have
 * `import.meta.url`. A bundle (the site-classic image) ships the worker built as `render-worker.mjs`
 * beside itself; from source it is the TypeScript file, loaded with Node's type stripping.
 */
const workerUrl = () => {
  const bundled = new URL('./render-worker.mjs', import.meta.url);
  return existsSync(fileURLToPath(bundled)) ? bundled : new URL('./render-worker.ts', import.meta.url);
};

export class RenderPool {
  private readonly opts: Required<RenderPoolOptions>;
  private readonly queues = new Map<string, Task[]>();
  /** Sites with queued jobs, in turn order. */
  private readonly turn: string[] = [];
  private readonly slots: Slot[] = [];
  private queuedCount = 0;
  private queuedBytes = 0;
  private nextId = 1;
  private closed = false;
  private closing: Promise<void> | null = null;
  /** Renders running, per site. */
  private readonly active = new Map<string, number>();
  /** Workers being terminated (close() waits for them). */
  private readonly terminating = new Set<Promise<number>>();

  constructor(options: RenderPoolOptions = {}) {
    this.opts = {
      workers: options.workers ?? 2,
      timeoutMs: options.timeoutMs ?? 1500,
      renderLimitMs: options.renderLimitMs ?? 500,
      queueTimeoutMs: options.queueTimeoutMs ?? 5000,
      maxQueued: options.maxQueued ?? 64,
      maxQueuedBytes: options.maxQueuedBytes ?? 32_000_000,
      maxJobBytes: options.maxJobBytes ?? 4_000_000,
      heapMb: options.heapMb ?? 96,
      startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
      workerUrl: options.workerUrl ?? workerUrl(),
      maxActivePerSite: options.maxActivePerSite ?? 2,
    };
    for (let i = 0; i < this.opts.workers; i++) {
      const slot: Slot = { worker: null, ready: false, task: null, requestId: 0, backoffMs: 50 };
      this.slots.push(slot);
      this.spawn(slot);
    }
  }

  /** The live workers' thread ids (a terminated worker's id disappears; for tests and metrics). */
  threadIds(): number[] {
    return this.slots.flatMap((s) => (s.worker ? [s.worker.threadId] : []));
  }

  /** Workers loaded and taking jobs (for tests and metrics). */
  readyWorkers(): number {
    return this.slots.filter((s) => s.worker && s.ready).length;
  }

  /** Renders running, per site (for tests and metrics). */
  running(): Record<string, number> {
    return Object.fromEntries(this.active);
  }

  /** Jobs waiting, per site (for tests and metrics). */
  queued(): Record<string, number> {
    return Object.fromEntries([...this.queues].map(([site, q]) => [site, q.length]));
  }

  render(job: RenderJob): Promise<string> {
    if (this.closed) return Promise.reject(new RenderError('RENDER_CLOSED', 'the rendering pool is closed'));
    const bytes = Buffer.byteLength(JSON.stringify([job.templates, job.vm, job.system]));
    if (bytes > this.opts.maxJobBytes) return Promise.reject(new RenderError('RENDER_TOO_LARGE', 'page data too large'));
    return new Promise<string>((resolve, reject) => {
      const task: Task = { job, bytes, resolve, reject };
      if (!this.admit(task)) return reject(new RenderError('RENDER_QUEUE_FULL', 'the rendering queue is full'));
      task.queueTimer = setTimeout(() => {
        if (this.dequeue(task)) task.reject(new RenderError('RENDER_QUEUE_FULL', 'waited too long for a renderer'));
      }, this.opts.queueTimeoutMs);
      this.schedule();
    });
  }

  /**
   * Make room for `task` (R33, R37): refuse it, or plan which newest jobs of the sites with the most queued
   * to refuse so that it fits — and refuse them only when the plan succeeds.
   */
  private admit(task: Task): boolean {
    const site = task.job.siteId;
    const ownQueue = this.queues.get(site) ?? [];
    const sites = this.queues.size + (ownQueue.length ? 0 : 1);
    const quota = Math.max(2, Math.floor(this.opts.maxQueued / (sites + 1)));
    const byteQuota = Math.max(2 * this.opts.maxJobBytes, Math.floor(this.opts.maxQueuedBytes / (sites + 1)));
    const ownBytes = ownQueue.reduce((n, t) => n + t.bytes, 0);
    let count = this.queuedCount;
    let bytes = this.queuedBytes;
    const fits = () => count + 1 <= this.opts.maxQueued && bytes + task.bytes <= this.opts.maxQueuedBytes;
    if (!fits() && (ownQueue.length + 1 > quota || ownBytes + task.bytes > byteQuota)) return false;
    const left = new Map([...this.queues].filter(([s]) => s !== site).map(([s, q]) => [s, [...q]]));
    const victims: Task[] = [];
    while (!fits()) {
      let victim: string | null = null;
      for (const [s, q] of left) if (q.length && (!victim || q.length > left.get(victim)!.length)) victim = s;
      if (!victim) return false; // nothing changed: the plan failed before any job was refused
      const evicted = left.get(victim)!.pop()!;
      victims.push(evicted);
      count--;
      bytes -= evicted.bytes;
    }
    for (const v of victims) {
      this.dequeue(v);
      v.reject(new RenderError('RENDER_QUEUE_FULL', 'the rendering queue is full'));
    }
    const q = this.queues.get(site) ?? [];
    if (!q.length) {
      this.queues.set(site, q);
      this.turn.push(site);
    }
    q.push(task);
    this.queuedCount++;
    this.queuedBytes += task.bytes;
    return true;
  }

  private dequeue(task: Task): boolean {
    const site = task.job.siteId;
    const q = this.queues.get(site);
    const i = q ? q.indexOf(task) : -1;
    if (i < 0) return false;
    q!.splice(i, 1);
    this.queuedCount--;
    this.queuedBytes -= task.bytes;
    if (task.queueTimer) clearTimeout(task.queueTimer);
    if (!q!.length) {
      this.queues.delete(site);
      const t = this.turn.indexOf(site);
      if (t >= 0) this.turn.splice(t, 1);
    }
    return true;
  }

  /** Give idle workers the next job, one site after another, at most `maxActivePerSite` of a site at once. */
  private schedule(): void {
    for (const slot of this.slots) {
      if (slot.task || !slot.worker || !slot.ready) continue;
      const at = this.turn.findIndex((s) => (this.active.get(s) ?? 0) < this.opts.maxActivePerSite);
      if (at < 0) return;
      const site = this.turn[at]!;
      const task = this.queues.get(site)![0]!;
      // dequeue drops the site from the turn when its queue empties; otherwise it goes to the back.
      this.dequeue(task);
      const still = this.turn.indexOf(site);
      if (still >= 0) this.turn.push(...this.turn.splice(still, 1));
      this.dispatch(slot, task);
    }
  }

  private dispatch(slot: Slot, task: Task): void {
    slot.task = task;
    this.active.set(task.job.siteId, (this.active.get(task.job.siteId) ?? 0) + 1);
    slot.requestId = this.nextId++;
    const { siteId: _site, ...rest } = task.job;
    const req: RenderRequest = { id: slot.requestId, ...rest, assets: rest.assets ?? [], renderLimitMs: this.opts.renderLimitMs };
    slot.timer = setTimeout(() => {
      void this.recycle(slot, new RenderError('RENDER_TIMEOUT', 'the template took too long'));
    }, this.opts.timeoutMs);
    slot.worker!.postMessage(req);
  }

  private finish(slot: Slot): Task | null {
    const task = slot.task;
    slot.task = null;
    if (slot.timer) clearTimeout(slot.timer);
    if (task) {
      const n = (this.active.get(task.job.siteId) ?? 1) - 1;
      if (n > 0) this.active.set(task.job.siteId, n);
      else this.active.delete(task.job.siteId);
    }
    return task;
  }

  /** End the slot's worker (timeout, crash), fail its job, start a new worker once it has exited. */
  private async recycle(slot: Slot, err: RenderError): Promise<void> {
    const worker = slot.worker;
    slot.worker = null;
    clearTimeout(slot.startTimer);
    this.finish(slot)?.reject(err);
    if (worker) {
      worker.removeAllListeners();
      worker.on('error', () => undefined);
      const done = worker.terminate();
      this.terminating.add(done);
      await done.finally(() => this.terminating.delete(done));
    }
    this.schedule();
    if (this.closed) return;
    const delay = err.code === 'RENDER_TIMEOUT' ? 0 : slot.backoffMs;
    if (err.code !== 'RENDER_TIMEOUT') slot.backoffMs = Math.min(slot.backoffMs * 2, 5000);
    setTimeout(() => {
      if (!this.closed) this.spawn(slot);
    }, delay).unref();
  }

  private spawn(slot: Slot): void {
    const worker = new Worker(this.opts.workerUrl, {
      env: {},
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: this.opts.heapMb, maxYoungGenerationSizeMb: 16, codeRangeSizeMb: 16, stackSizeMb: 4 },
    });
    worker.unref();
    slot.worker = worker;
    slot.ready = false;
    clearTimeout(slot.startTimer);
    slot.startTimer = setTimeout(() => {
      if (slot.worker === worker && !slot.ready) void this.recycle(slot, new RenderError('RENDER_CRASHED', 'the renderer did not start'));
    }, this.opts.startupTimeoutMs);
    slot.startTimer.unref();
    worker.on('message', (reply: RenderReply | WorkerReady) => {
      if (slot.worker !== worker) return;
      if ('ready' in reply) {
        clearTimeout(slot.startTimer);
        slot.ready = true;
        this.schedule();
        return;
      }
      if (reply.id !== slot.requestId) return; // a late answer of an ended job
      const task = this.finish(slot);
      slot.backoffMs = 50;
      if (task) {
        if (reply.ok) task.resolve(reply.html);
        else task.reject(new RenderError(reply.code, reply.message));
      }
      this.schedule();
    });
    worker.on('error', (e) => {
      if (slot.worker !== worker) return;
      const oom = (e as { code?: string }).code === 'ERR_WORKER_OUT_OF_MEMORY';
      void this.recycle(slot, new RenderError('RENDER_CRASHED', oom ? 'the template used too much memory' : 'the renderer crashed'));
    });
    worker.on('exit', () => {
      if (slot.worker === worker && !this.closed) void this.recycle(slot, new RenderError('RENDER_CRASHED', 'the renderer exited'));
    });
    this.schedule();
  }

  /** Stop every worker; every caller gets the same promise, settled when all workers have exited. */
  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    const pending = [...this.terminating];
    for (const [, q] of [...this.queues]) for (const t of [...q]) if (this.dequeue(t)) t.reject(new RenderError('RENDER_CLOSED', 'the rendering pool is closed'));
    await Promise.all(
      this.slots.map(async (slot) => {
        this.finish(slot)?.reject(new RenderError('RENDER_CLOSED', 'the rendering pool is closed'));
        clearTimeout(slot.startTimer);
        const w = slot.worker;
        slot.worker = null;
        if (w) {
          w.removeAllListeners();
          await w.terminate();
        }
      }),
    );
    await Promise.allSettled(pending);
  }
}
