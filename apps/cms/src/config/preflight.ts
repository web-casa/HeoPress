/**
 * Startup preflight for the HeoPress Node entrypoint (`serve.ts`).
 *
 * Runs before any other startup work so an unsupported runtime or a stale
 * configuration fails fast with an actionable message instead of a confusing
 * error later on (P01 `platform/runtime-baseline`).
 */

/** Lowest supported Node.js major version (ADR-0003). */
export const MIN_NODE_MAJOR = 24;

/**
 * Environment prefix used by the upstream LumiBase project. HeoPress no longer
 * reads these variables; the preflight only detects them to point at the new
 * names.
 */
export const LEGACY_ENV_PREFIX = 'LUMIBASE_';

/** Environment prefix read by HeoPress. */
export const ENV_PREFIX = 'HEOPRESS_';

export class PreflightError extends Error {
  override name = 'PreflightError';
}

export function assertSupportedNode(version: string = process.versions.node): void {
  const major = Number.parseInt(version.replace(/^v/, '').split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major < MIN_NODE_MAJOR) {
    throw new PreflightError(
      `HeoPress requires Node.js >= ${MIN_NODE_MAJOR} (需要 Node.js >= ${MIN_NODE_MAJOR}); current version is ${version}.`,
    );
  }
}

export interface LegacyEnvVar {
  legacy: string;
  replacement: string;
}

export function findLegacyEnv(env: NodeJS.ProcessEnv = process.env): LegacyEnvVar[] {
  return Object.keys(env)
    .filter((name) => name.startsWith(LEGACY_ENV_PREFIX) && env[name] !== undefined)
    .sort()
    .map((legacy) => ({ legacy, replacement: ENV_PREFIX + legacy.slice(LEGACY_ENV_PREFIX.length) }));
}

export function assertNoLegacyEnv(env: NodeJS.ProcessEnv = process.env): void {
  const found = findLegacyEnv(env);
  if (found.length === 0) return;
  throw new PreflightError(
    [
      `Environment variables with the legacy ${LEGACY_ENV_PREFIX} prefix are no longer read. Rename them:`,
      ...found.map(({ legacy, replacement }) => `  ${legacy} -> ${replacement}`),
    ].join('\n'),
  );
}

/**
 * `HEOPRESS_RUNTIME` may be unset or `docker`. The Cloudflare Workers runtime
 * was removed in P02 (ADR-0002), so `cloudflare` (or any other value) is a
 * stale configuration that must not start.
 */
export function assertSupportedRuntime(env: NodeJS.ProcessEnv = process.env): void {
  const mode = env.HEOPRESS_RUNTIME?.trim();
  if (mode && mode !== 'docker') {
    throw new PreflightError(
      `HEOPRESS_RUNTIME="${mode}" is not supported: HeoPress runs only on Node.js. Unset it or set it to "docker".`,
    );
  }
}

/** LLM providers removed in HeoPress P02: Cloudflare Workers AI and Google Vertex AI. */
export const REMOVED_LLM_PROVIDERS: readonly string[] = ['vertex', 'workers-ai'];

export function removedLlmProviderMessage(provider: string): string {
  return `LLM_PROVIDER="${provider}" was removed in HeoPress P02 (supported: openai, anthropic, claude, gemini, nvidia, echo).`;
}

export function assertSupportedLlmProvider(env: NodeJS.ProcessEnv = process.env): void {
  const provider = env.LLM_PROVIDER?.trim();
  if (provider && REMOVED_LLM_PROVIDERS.includes(provider)) {
    throw new PreflightError(removedLlmProviderMessage(provider));
  }
}

export function runStartupPreflight(
  options: { env?: NodeJS.ProcessEnv; nodeVersion?: string } = {},
): void {
  assertSupportedNode(options.nodeVersion);
  assertNoLegacyEnv(options.env);
  assertSupportedRuntime(options.env);
  assertSupportedLlmProvider(options.env);
}

/** Lowest supported PostgreSQL major version (ADR-0002). */
export const MIN_POSTGRES_MAJOR = 18;

/** Minimal tagged-template query shape; a postgres.js `Sql` is called this way (cast at the call site). */
export type PreflightQuery = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => PromiseLike<ReadonlyArray<Record<string, unknown>>>;

export interface PostgresVersionCheckOptions {
  /** How long to keep retrying while the server is not reachable yet. */
  connectTimeoutMs?: number;
  retryIntervalMs?: number;
  /**
   * Least time one attempt may take, even when the connect deadline is closer
   * (or already past, as with `connectTimeoutMs: 0`), so a reachable server is
   * always asked at least once.
   */
  minAttemptMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Rejects when `promise` has not settled after `ms`; the timer never outlives the race. */
function withDeadline<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(promise),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), Math.max(ms, 0));
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Refuse to start against PostgreSQL older than 18.
 *
 * A server that is not reachable yet (container still booting) is retried until
 * `connectTimeoutMs`; a server that answers with an unsupported version fails at
 * once, since waiting cannot fix it. Each attempt is bounded by the time left
 * (but at least `minAttemptMs`), so a connection that is accepted but never
 * answers fails instead of hanging startup.
 */
export async function assertSupportedPostgres(
  sql: PreflightQuery,
  options: PostgresVersionCheckOptions = {},
): Promise<{ versionNum: number; version: string }> {
  const timeoutMs = options.connectTimeoutMs ?? 30_000;
  const intervalMs = options.retryIntervalMs ?? 1_000;
  const minAttemptMs = options.minAttemptMs ?? 5_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;

  let rows: ReadonlyArray<Record<string, unknown>>;
  for (;;) {
    try {
      rows = await withDeadline(
        sql`SELECT current_setting('server_version_num') AS num, current_setting('server_version') AS version`,
        Math.max(deadline - now(), minAttemptMs),
      );
      break;
    } catch (err) {
      if (now() >= deadline) {
        throw new PreflightError(
          `Could not reach PostgreSQL within ${timeoutMs} ms to check its version: ${(err as Error)?.message ?? String(err)}`,
        );
      }
      await sleep(Math.min(intervalMs, Math.max(deadline - now(), 0)));
    }
  }

  const versionNum = Number(rows[0]?.num);
  const version = String(rows[0]?.version ?? 'unknown');
  if (!Number.isInteger(versionNum) || Math.floor(versionNum / 10_000) < MIN_POSTGRES_MAJOR) {
    throw new PreflightError(
      `HeoPress requires PostgreSQL >= ${MIN_POSTGRES_MAJOR} (需要 PostgreSQL >= ${MIN_POSTGRES_MAJOR}); connected server is ${version}.`,
    );
  }
  return { versionNum, version };
}
