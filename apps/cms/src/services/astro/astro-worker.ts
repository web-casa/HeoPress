import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema, type Database } from '@heopress/database';
import type { EventConsumerDefinition } from '../../modules/events/consumer-runner';
import { AstroEngine, astroBuildConsumer, astroReconciliation, type ReconciliationHook, type AstroReconcileReport } from './astro-engine';

/**
 * The Astro engine in the worker process (HeoPress P11 tasks 3.2, 3.5), on when `HEOPRESS_ASTRO_ROOT` and
 * `HEOPRESS_ASTRO_RENDER_DATABASE_URL` (the rendering role: public projection only) are set:
 *
 *   HEOPRESS_ASTRO_ROOT                      the sites' build directories
 *   HEOPRESS_ASTRO_RENDER_DATABASE_URL       the rendering role's connection
 *   HEOPRESS_ASTRO_DEBOUNCE_MS               debounce window (default 60000)
 *   HEOPRESS_ASTRO_CONCURRENCY               builds at a time (default 1)
 *   HEOPRESS_ASTRO_BUILD_MEMORY_MB           V8 heap of a build (default 1024)
 *   HEOPRESS_ASTRO_BUILD_TIMEOUT_MS          wall time of a build (default 600000)
 *   HEOPRESS_ASTRO_BUILD_CPU_SECONDS         CPU time of a build (default 600)
 *   HEOPRESS_ASTRO_BUILD_UID / _GID          the unprivileged user builds run as when the CMS runs as root
 *   HEOPRESS_ASTRO_OPERATOR_THEMES           the operator's own themes
 *   HEOPRESS_ASTRO_INTEGRATIONS              approved theme integrations (comma-separated)
 *   HEOPRESS_ASTRO_REGISTRY                  the package registry builds may use
 */
export interface AstroWorker {
  consumer: EventConsumerDefinition;
  reconciliation: ReconciliationHook<AstroReconcileReport>;
  stop(): Promise<void>;
}

const int = (v: string | undefined, d: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export function startAstroWorker(db: Database, env: NodeJS.ProcessEnv = process.env): AstroWorker | null {
  const root = env.HEOPRESS_ASTRO_ROOT?.trim();
  const renderUrl = env.HEOPRESS_ASTRO_RENDER_DATABASE_URL?.trim();
  if (!root || !renderUrl) return null;
  const client = postgres(renderUrl, { max: 2, onnotice: () => {} });
  const uid = int(env.HEOPRESS_ASTRO_BUILD_UID, 0);
  const engine = new AstroEngine({
    db,
    renderDb: drizzle(client, { schema }) as unknown as Database,
    root,
    debounceMs: int(env.HEOPRESS_ASTRO_DEBOUNCE_MS, 60_000),
    concurrency: int(env.HEOPRESS_ASTRO_CONCURRENCY, 1),
    limits: {
      memoryMb: int(env.HEOPRESS_ASTRO_BUILD_MEMORY_MB, 1024),
      timeoutMs: int(env.HEOPRESS_ASTRO_BUILD_TIMEOUT_MS, 600_000),
      cpuSeconds: int(env.HEOPRESS_ASTRO_BUILD_CPU_SECONDS, 600),
    },
    user: uid ? { uid, gid: int(env.HEOPRESS_ASTRO_BUILD_GID, uid) } : undefined,
    operatorThemesDir: env.HEOPRESS_ASTRO_OPERATOR_THEMES?.trim() || undefined,
    approvedIntegrations: (env.HEOPRESS_ASTRO_INTEGRATIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    registry: env.HEOPRESS_ASTRO_REGISTRY?.trim() || undefined,
  });
  const reconciliation = astroReconciliation(engine);
  const due = setInterval(() => void engine.runDue().catch((err: unknown) => console.error('[astro] build pass failed', (err as Error).message)), 10_000);
  const recon = setInterval(() => void reconciliation.run().catch((err: unknown) => console.error('[astro] reconciliation failed', (err as Error).message)), reconciliation.intervalMs);
  due.unref();
  recon.unref();
  return {
    consumer: astroBuildConsumer(engine),
    reconciliation,
    stop: async () => {
      clearInterval(due);
      clearInterval(recon);
      await client.end({ timeout: 2 });
    },
  };
}
