// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { Server as HttpServer } from 'node:http';
import {
  evaluateCapabilities,
  getDatabaseCapabilities,
  getMigrationReadiness,
  type CapabilityRequirements,
  type MigrationStatusQuery,
} from '@heopress/database';

/** What a worker needs before it can take jobs (P01 `platform/runtime-baseline`). */
export interface WorkerReadiness {
  database: boolean;
  migrations: boolean;
  /** Extensions required by the enabled capabilities are installed (P03 task 1.2). */
  extensions: boolean;
}

export type WorkerReadinessProbe = () => Promise<WorkerReadiness>;

const PROBE_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve(promise),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`probe timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Readiness of the worker's database: reachable, every migration bundled with
 * this build applied, and the extensions the enabled capabilities need
 * installed. Each check is bounded so a hung connection reports "not ready"
 * instead of hanging the probe.
 */
export function databaseReadinessProbe(
  sql: MigrationStatusQuery,
  timeoutMs: number = PROBE_TIMEOUT_MS,
  requirements: CapabilityRequirements = { vectorSearch: false },
): WorkerReadinessProbe {
  return async () => {
    try {
      await withTimeout(sql`SELECT 1`, timeoutMs);
    } catch {
      return { database: false, migrations: false, extensions: false };
    }
    let migrations = false;
    try {
      migrations = (await withTimeout(getMigrationReadiness(sql), timeoutMs)).upToDate;
    } catch {
      migrations = false;
    }
    let extensions = false;
    try {
      const caps = await withTimeout(getDatabaseCapabilities(sql), timeoutMs);
      extensions = evaluateCapabilities(caps, requirements).ready;
    } catch {
      extensions = false;
    }
    return { database: true, migrations, extensions };
  };
}

/**
 * Health endpoints of a `HEOPRESS_PROCESS_ROLE=worker` process. Liveness probes
 * nothing; readiness answers 503 while the database is unreachable or not fully
 * migrated. The port is internal, so the response names no failing dependency.
 */
export function createWorkerHealthApp(checkReady: WorkerReadinessProbe): Hono {
  const app = new Hono();
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      role: 'worker',
      service: 'heopress-cms',
    }),
  );
  app.get('/health/live', (c) => c.json({ status: 'alive', role: 'worker' }));
  app.get('/health/ready', async (c) => {
    let ready = false;
    try {
      const result = await checkReady();
      ready = result.database && result.migrations && result.extensions;
    } catch {
      ready = false;
    }
    return c.json(
      { status: ready ? 'ok' : 'unavailable', role: 'worker', service: 'heopress-cms' },
      ready ? 200 : 503,
    );
  });
  return app;
}

/**
 * Minimal HTTP server for `HEOPRESS_PROCESS_ROLE=worker` processes.
 * Exposes only health endpoints so orchestrators can probe background workers.
 */
export function startWorkerHealthServer(port: number, checkReady: WorkerReadinessProbe): HttpServer {
  const app = createWorkerHealthApp(checkReady);
  const server = serve({ fetch: app.fetch, port }) as unknown as HttpServer;
  console.log(`[heopress-cms] Worker health server listening on port ${port}`);
  return server;
}
