// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import type { RuntimeContext } from '@heopress/runtime';
import { recordCacheOperationEvent } from '../services/cache-observability';

/**
 * Cached singleton runtime. It holds long-lived connections (pg pools, the queue
 * client), so it is created once per process and reused across requests.
 */
let dockerRuntime: RuntimeContext | null = null;

/**
 * Optional factory override, set by long-running Node entry points.
 *
 * `serve.ts` already builds a runtime of its own (it needs one outside the
 * request path, for cron and queue consumers). Before this existed it injected
 * that runtime with a second middleware registered *after* `withRuntime`, so
 * Docker mode built **two** runtimes per process — two queue clients, two
 * pg pools — and threw the first away on every request. Registering the factory
 * here means one runtime per process, and it keeps this module free of any
 * static import of the Docker adapters.
 */
type RuntimeFactory = (env: Record<string, unknown>) => RuntimeContext;
let runtimeFactory: RuntimeFactory | null = null;

/** Overrides how `withRuntime` obtains its RuntimeContext. Node entries only. */
export function setRuntimeFactory(factory: RuntimeFactory | null): void {
  runtimeFactory = factory;
  dockerRuntime = null;
}

function wireCacheObservability(runtime: RuntimeContext): void {
  const previous = runtime.cache.onEvent;
  runtime.cache.onEvent = (event) => {
    recordCacheOperationEvent(event);
    previous?.(event);
  };
}

function prepareRuntime(runtime: RuntimeContext): RuntimeContext {
  wireCacheObservability(runtime);
  return runtime;
}

/**
 * Middleware that creates a RuntimeContext and injects it into the Hono
 * context as `c.get('runtime')`.
 */
export const withRuntime = () =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!dockerRuntime) {
      const envVars = { ...process.env, ...c.env };
      // `serve.ts` registers its own runtime via `setRuntimeFactory` before
      // serving; this fallback is for Node contexts that mount `src/index.ts`
      // directly (the golden-path E2E suite). The dynamic import keeps the
      // Docker adapters out of modules that only need the app.
      const factory = runtimeFactory ?? (await import('@heopress/runtime/node')).createRuntime;
      dockerRuntime = prepareRuntime(factory(envVars as unknown as Record<string, unknown>));
    }
    c.set('runtime', dockerRuntime);
    await next();
  });
