/**
 * Per-run limits of plugin code (HeoPress P12 task 3.2, spec extensions/runtime-extensions "插件定时任务"): a job run, an
 * endpoint call, an event delivery or a pre-publish hook runs inside a scope with a deadline and an outbound request
 * budget. The scope follows the run's async work (AsyncLocalStorage), so the sandbox context the plugin captured at load
 * time is limited too: `ctx.fetch` counts against the budget, and once the scope is over its limit, out of time or
 * stopped (plugin disabled, kill switch) every further context call throws — the run is terminated, not extended.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export type RunStopReason = 'timeout' | 'limit' | 'stopped';

export class RunLimitError extends Error {
  constructor(
    readonly reason: RunStopReason,
    message: string,
  ) {
    super(message);
    this.name = 'RunLimitError';
  }
}

export interface RunLimits {
  /** Wall-clock budget (ms). */
  durationMs: number;
  /** Outbound requests allowed. */
  maxRequests: number;
  /** What runs (for messages): `job:<name>`, `endpoint:<name>`, … */
  label: string;
}

export class RunScope {
  readonly controller = new AbortController();
  readonly deadline: number;
  requests = 0;
  stopReason: RunLimitError | null = null;

  constructor(readonly limits: RunLimits) {
    this.deadline = Date.now() + limits.durationMs;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Stop the run: later context calls throw `error`. */
  stop(error: RunLimitError): void {
    if (this.stopReason) return;
    this.stopReason = error;
    this.controller.abort(error);
  }

  /** Throws when the run is over (stopped, past its deadline). */
  assertActive(): void {
    if (!this.stopReason && Date.now() > this.deadline) {
      this.stop(new RunLimitError('timeout', `${this.limits.label} ran past its ${this.limits.durationMs} ms limit`));
    }
    if (this.stopReason) throw this.stopReason;
  }

  /** Count one outbound request; over the budget the run is stopped. */
  chargeRequest(): void {
    this.assertActive();
    this.requests += 1;
    if (this.requests > this.limits.maxRequests) {
      this.stop(new RunLimitError('limit', `${this.limits.label} exceeded its limit of ${this.limits.maxRequests} outbound requests`));
      throw this.stopReason!;
    }
  }

  timeLeft(): number {
    return Math.max(0, this.deadline - Date.now());
  }
}

const storage = new AsyncLocalStorage<RunScope>();

/** The scope of the plugin run the current async work belongs to, if any. */
export function currentRunScope(): RunScope | undefined {
  return storage.getStore();
}

/**
 * Run `fn` inside a new scope. Resolves with its value, or rejects with RunLimitError when the deadline passes first
 * (the scope is stopped, so the abandoned work cannot keep using the context) or when `fn` hit a limit.
 */
export async function withRunScope<T>(limits: RunLimits, fn: (scope: RunScope) => Promise<T> | T): Promise<{ value: T; scope: RunScope }> {
  const scope = new RunScope(limits);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new RunLimitError('timeout', `${limits.label} ran past its ${limits.durationMs} ms limit`);
      scope.stop(err);
      reject(err);
    }, limits.durationMs);
  });
  const stopped = new Promise<never>((_, reject) => {
    scope.signal.addEventListener('abort', () => reject(scope.stopReason ?? new RunLimitError('stopped', `${limits.label} was stopped`)), { once: true });
  });
  try {
    const value = await Promise.race([storage.run(scope, () => Promise.resolve().then(() => fn(scope))), timeout, stopped]);
    // A plugin that caught the limit error and returned normally is still over its limit.
    if (scope.stopReason) throw scope.stopReason;
    return { value, scope };
  } finally {
    clearTimeout(timer);
  }
}
