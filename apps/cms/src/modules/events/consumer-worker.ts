/**
 * Runs the event consumers in a worker process (HeoPress P04, spec
 * platform/event-consumption). Each tick runs every consumer once, in turn;
 * a consumer that fails or is slow only delays itself on the next tick —
 * never another consumer's position or records. Writes wake the loop through
 * the `cdc-dispatch` queue (latency only: the tick is the backstop).
 */
import type { QueueProvider } from '@heopress/runtime';
import type { Database } from '@heopress/database';
import { formatSafeError } from '@heopress/contracts/utils';
import { EventConsumerRunner, type EventConsumerDefinition } from './consumer-runner';

const EVENT_WAKE_QUEUE = 'cdc-dispatch';
const EVENT_TICK_MS = 1_000;

export interface EventConsumerWorkerDeps {
  db: Database;
  queue?: QueueProvider;
  /** Framework consumers to run every tick. */
  consumers: () => EventConsumerDefinition[] | Promise<EventConsumerDefinition[]>;
  /** Other work driven by the same wake-ups (Change Feed subscription lanes). */
  alsoOnTick?: () => Promise<void>;
  tickMs?: number;
  /**
   * The process write gate (HeoPress P13 upgrade write freeze): while frozen no lane starts or repeats; a running pass
   * counts as a write in flight until it ends.
   */
  gate?: { isFrozen(): boolean; enter(): (() => void) | null };
}

/**
 * Start the loop; returns a stop function. Every consumer — and the
 * subscription dispatch — runs in its own lane: a lane that is slow, hangs
 * or sleeps through a retry backoff only delays itself; the others keep
 * their own pace (Codex review P04-2 #6).
 */
export function registerEventConsumers(deps: EventConsumerWorkerDeps): () => void {
  const runner = new EventConsumerRunner(deps.db);
  let stopped = false;
  const lanes = new Map<string, { running: boolean; again: boolean }>();

  const lane = (name: string, work: () => Promise<unknown>): void => {
    if (deps.gate?.isFrozen()) return;
    const state = lanes.get(name) ?? { running: false, again: false };
    lanes.set(name, state);
    if (state.running) {
      state.again = true;
      return;
    }
    const leave = deps.gate ? deps.gate.enter() : () => {};
    if (!leave) return;
    state.running = true;
    void (async () => {
      try {
        do {
          state.again = false;
          try {
            await work();
          } catch (err) {
            console.error(`[events] ${name} failed`, formatSafeError(err));
          }
        } while (state.again && !stopped && !deps.gate?.isFrozen());
      } finally {
        state.running = false;
        leave();
      }
    })();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    for (const def of await deps.consumers()) lane(`consumer:${def.name}`, () => runner.runOnce(def));
    if (deps.alsoOnTick) lane('subscriptions', deps.alsoOnTick);
  };

  deps.queue?.process(EVENT_WAKE_QUEUE, async () => {
    await tick();
  });
  const interval = setInterval(() => void tick().catch(() => {}), deps.tickMs ?? EVENT_TICK_MS);
  (interval as unknown as { unref?: () => void }).unref?.();
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}
