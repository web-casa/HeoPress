// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { RetentionService, resolveRetentionDays } from '../modules/data-rights/retention-service';
import { AuditLogger } from '../modules/audit/logger';
import { retentionPolicyFromEnv } from '../services/retention/policy';
import { RetentionHoldError, RetentionHoldService } from '../services/retention/snapshot-retention';

/**
 * `retentionRouter` — admin-triggered general data-retention pruning
 * (`/api/v1/retention`). Site-admin only. Horizons come from
 * `HEOPRESS_ACTIVITY_RETENTION_DAYS` / `HEOPRESS_NOTIFICATION_RETENTION_DAYS`
 * (0/unset disables pruning for that table).
 *
 * HeoPress P13 task 5.1 (spec ops/data-retention):
 *   GET  /                      also reports the instance retention policy (`policy`).
 *   GET  /holds?state=open|all  retention holds: open disputes that keep a raw fetch snapshot past its period.
 *   POST /holds                 body `{ snapshotId, reason }` — open a hold.
 *   POST /holds/:id/release     the dispute ended; the snapshot goes through retention again.
 */
export const retentionRouter = new Hono<AppEnv>();
retentionRouter.use('*', requireSiteAdmin());

function readEnv(c: import('hono').Context<AppEnv>, key: string): string | undefined {
  const env = c.env as unknown as Record<string, string | undefined>;
  return env?.[key] ?? process.env[key];
}

// GET /api/v1/retention — report the configured horizons.
retentionRouter.get('/', (c) => {
  return c.json({
    data: {
      activityRetentionDays: resolveRetentionDays(readEnv(c, 'HEOPRESS_ACTIVITY_RETENTION_DAYS')),
      notificationRetentionDays: resolveRetentionDays(readEnv(c, 'HEOPRESS_NOTIFICATION_RETENTION_DAYS')),
      policy: retentionPolicyFromEnv(process.env),
    },
  });
});

const holds = (c: import('hono').Context<AppEnv>) =>
  new RetentionHoldService({ db: c.get('db'), siteId: c.get('siteId'), userId: c.get('auth')?.userId ?? null });

const holdError = (c: import('hono').Context<AppEnv>, err: unknown) => {
  if (err instanceof RetentionHoldError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
  throw err;
};

retentionRouter.get('/holds', async (c) => {
  const state = c.req.query('state') === 'all' ? 'all' : 'open';
  return c.json({ data: await holds(c).list(state) });
});

retentionRouter.post('/holds', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { snapshotId?: unknown; reason?: unknown } | null;
  if (typeof body?.snapshotId !== 'string' || typeof body.reason !== 'string' || body.reason.length > 500) {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Give `snapshotId` and a `reason` (at most 500 characters).' }] }, 400);
  }
  try {
    return c.json({ data: await holds(c).open({ snapshotId: body.snapshotId, reason: body.reason }) }, 201);
  } catch (err) {
    return holdError(c, err);
  }
});

retentionRouter.post('/holds/:id/release', async (c) => {
  try {
    return c.json({ data: await holds(c).release(c.req.param('id')) });
  } catch (err) {
    return holdError(c, err);
  }
});

// POST /api/v1/retention/run — prune expired rows for this site.
retentionRouter.post('/run', async (c) => {
  const siteId = c.get('siteId');
  const service = new RetentionService({
    db: c.get('db'),
    activityRetentionDays: resolveRetentionDays(readEnv(c, 'HEOPRESS_ACTIVITY_RETENTION_DAYS')),
    notificationRetentionDays: resolveRetentionDays(readEnv(c, 'HEOPRESS_NOTIFICATION_RETENTION_DAYS')),
  });
  const result = await service.purge({ siteId });

  if (result.activity > 0 || result.notifications > 0) {
    await new AuditLogger({ db: c.get('db'), siteId }).write({
      event: 'retention_pruned',
      actorEmail: c.get('auth')?.email ?? null,
      ip: c.get('ip') ?? null,
      userAgent: c.get('userAgent') ?? null,
      requestId: c.get('requestId') ?? null,
      metadata: { ...result },
    });
  }

  return c.json({ data: result });
});
