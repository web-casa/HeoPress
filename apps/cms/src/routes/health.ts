// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Hono, type Context } from 'hono';
import type { RuntimeContext } from '@heopress/runtime';
import {
  capabilityRequirementsFromEnv,
  evaluateCapabilities,
  getDatabaseCapabilities,
  getMigrationReadiness,
  type CapabilityReport,
  type MigrationStatusQuery,
} from '@heopress/database';
import type { AppEnv } from '../env';
import { canReadObservabilityDetail } from './metrics';
import {
  getCacheOperationalStatus,
  markCacheConnectivityProbeFailed,
  markCacheConnectivityProbeSucceeded,
} from '../services/cache-observability';

type ServiceStatus = 'healthy' | 'unhealthy';
type CacheServiceStatus = 'healthy' | 'degraded' | 'unhealthy';
type OverallStatus = 'healthy' | 'degraded';
type ServiceName = keyof HealthResponse['services'];

interface HealthResponse {
  status: OverallStatus;
  services: {
    database: ServiceStatus;
    migrations: ServiceStatus;
    /** Extensions required by the enabled capabilities (P03 task 1.2). */
    extensions: ServiceStatus;
    cache: CacheServiceStatus;
    search: ServiceStatus;
    storage: ServiceStatus;
    queue: ServiceStatus;
  };
  /** What is missing or degraded; only shown to trusted callers. */
  capabilities?: Pick<CapabilityReport, 'missing' | 'notices' | 'chineseSearch'>;
}

/**
 * Health check route.
 *
 * Cache probe returns `healthy` / `degraded` / `unhealthy` based on
 * connectivity plus a 60s operational error-rate window (>50% errors →
 * degraded). `/health/ready` returns 503 when cache is degraded or down.
 *
 * HeoPress (P01 runtime baseline): `/health/live` answers 200 without probing
 * any dependency, and readiness also requires every bundled database migration
 * to be applied (`migrations` probe).
 */
export const healthRouter = new Hono<AppEnv>();

const HEALTH_PROBE_TIMEOUT_MS = 750;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('health probe timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function probeService(
  check: () => Promise<boolean>,
  timeoutMs = HEALTH_PROBE_TIMEOUT_MS,
): Promise<ServiceStatus> {
  try {
    return (await withTimeout(check(), timeoutMs)) ? 'healthy' : 'unhealthy';
  } catch {
    return 'unhealthy';
  }
}

async function probeCache(runtime: RuntimeContext): Promise<CacheServiceStatus> {
  try {
    const healthKey = '__heopress_health_check__';
    await runtime.cache.set(healthKey, JSON.stringify('ok'), { ttl: 60 });
    const val = await runtime.cache.get(healthKey);
    if (val === null) {
      markCacheConnectivityProbeFailed();
      return 'unhealthy';
    }
    markCacheConnectivityProbeSucceeded();
  } catch {
    markCacheConnectivityProbeFailed();
    return 'unhealthy';
  }

  const operational = getCacheOperationalStatus();
  if (operational === 'down') return 'unhealthy';
  if (operational === 'degraded') return 'degraded';
  return 'healthy';
}

export async function collectHealth(c: Context<AppEnv>): Promise<HealthResponse> {
  const runtime = c.get('runtime');

  let capabilities: CapabilityReport | undefined;
  const [database, migrations, extensions, cache, search, storage, queue] = await Promise.all([
    probeService(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sql = runtime.database.getConnection() as any;
      await sql`SELECT 1`;
      return true;
    }, 3000),
    probeService(async () => {
      const sql = runtime.database.getConnection() as unknown as MigrationStatusQuery;
      return (await getMigrationReadiness(sql)).upToDate;
    }, 3000),
    probeService(async () => {
      const sql = runtime.database.getConnection() as unknown as MigrationStatusQuery;
      capabilities = evaluateCapabilities(
        await getDatabaseCapabilities(sql),
        capabilityRequirementsFromEnv(c.env as unknown as Record<string, unknown>),
      );
      return capabilities.ready;
    }, 3000),
    probeCache(runtime),
    probeService(async () => {
      try {
        await runtime.search.getIndex('_health');
        return true;
      } catch (err: unknown) {
        // Only MeiliSearch's own "no such index" answer means it is up; a
        // connection or DNS failure must show as unhealthy (P03 task 7.2).
        const code = (err as { cause?: { code?: string } })?.cause?.code;
        const message = err instanceof Error ? err.message : String(err);
        return code === 'index_not_found' || message.includes('index_not_found') || /\bIndex `_health` not found\b/.test(message);
      }
    }),
    probeService(async () => {
      await runtime.storage.list('__health__');
      return true;
    }),
    probeService(async () => {
      // A ping when the queue offers one: enqueueing a probe job on every
      // check would pile up jobs nobody processes (P03).
      if (runtime.queue.ping) return runtime.queue.ping();
      const jobId = await runtime.queue.enqueue(
        '_health',
        'health_check',
        { ts: Date.now() },
        { attempts: 1 },
      );
      return Boolean(jobId);
    }, 3000),
  ]);

  const results: HealthResponse['services'] = {
    database,
    migrations,
    extensions,
    cache,
    search,
    storage,
    queue,
  };

  const cacheBlocksReady = cache === 'unhealthy' || cache === 'degraded';
  const otherUnhealthy = Object.entries(results)
    .filter(([name]) => name !== 'cache')
    .some(([, status]) => status === 'unhealthy');

  const response: HealthResponse = {
    status: cacheBlocksReady || otherUnhealthy ? 'degraded' : 'healthy',
    services: results,
    ...(capabilities
      ? {
          capabilities: {
            missing: capabilities.missing,
            notices: capabilities.notices,
            chineseSearch: capabilities.chineseSearch,
          },
        }
      : {}),
  };

  return response;
}

/** Strip the per-subsystem detail unless the caller is trusted. */
function shapeHealth(c: Context<AppEnv>, full: HealthResponse): HealthResponse | { status: OverallStatus } {
  if (canReadObservabilityDetail(c.env, c.req.header('authorization'))) {
    return full;
  }
  return { status: full.status };
}

function isReady(response: HealthResponse): boolean {
  return response.services.cache !== 'degraded' && response.services.cache !== 'unhealthy'
    && Object.entries(response.services)
      .filter(([name]) => name !== 'cache')
      .every(([, status]) => status === 'healthy');
}

healthRouter.get('/', async (c) => c.json(shapeHealth(c, await collectHealth(c)), 200));

// Liveness: the process is up and serving HTTP. Deliberately probes nothing, so
// a database or cache outage never gets a healthy process restarted.
healthRouter.get('/live', (c) => c.json({ status: 'alive' }, 200));

healthRouter.get('/ready', async (c) => {
  const response = await collectHealth(c);
  return c.json(shapeHealth(c, response), isReady(response) ? 200 : 503);
});
