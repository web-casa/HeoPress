import { availableParallelism } from 'node:os';

/**
 * The rendering service's numeric settings (HeoPress P13 task 3.2), read from the environment by `serve.ts`.
 */

/**
 * Render threads by default: one per CPU this process may use (its CPU affinity, as a container's `--cpuset-cpus` sets
 * it), less one for the event loop that answers cache hits — at least 2, at most 8.
 */
export function defaultRenderWorkers(cpus: number = availableParallelism()): number {
  return Math.min(8, Math.max(2, cpus - 1));
}

/** A whole-number setting within bounds, or its default when unset or blank; anything else is an error (a typo is never ignored). */
export function countSetting(env: Record<string, string | undefined>, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}
