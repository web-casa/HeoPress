/**
 * `/api/v1/plugins` — plugin admin panels, settings, private storage and job status (HeoPress P12 tasks 3.1, 3.5–3.7).
 *
 * The active site only (`X-HeoPress-Site`), and only for a person who may see it: panels need site membership, changing
 * settings, exporting or purging storage, the callback secret and job status need site administration. A person without
 * access to site B gets 403 for B and never sees B's data.
 */
import { Hono, type Context } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { pluginJobRuns, pluginJobs } from '@heopress/database';
import type { AppEnv } from '../env';
import { requireSiteMember } from '../middleware/site-member';
import { requireSiteAdmin } from '../middleware/site-admin';
import { PluginPanelError, PluginPanels, pluginStorageFor } from '../extensions/runtime/admin-panels';
import { PluginStorageError } from '../extensions/runtime/storage';
import { grantsPoint, isRunnable } from '../extensions/runtime/plugin-host';
import { rotateCallbackSecret } from '../extensions/runtime/endpoints';
import { AuditLogger } from '../modules/audit/logger';

export const pluginAdminRouter = new Hono<AppEnv>();

function fail(c: Context<AppEnv>, e: unknown) {
  if (e instanceof PluginPanelError || e instanceof PluginStorageError) {
    return c.json({ errors: [{ code: e.code, message: e.message }] }, e.status);
  }
  throw e;
}

const panels = (c: Context<AppEnv>) => new PluginPanels(c.get('db'), c.get('siteId'));

pluginAdminRouter.get('/', requireSiteMember(), async (c) => c.json({ data: await panels(c).list() }));

pluginAdminRouter.get('/:name/pages/:page', requireSiteMember(), async (c) => {
  try {
    return c.json({ data: await panels(c).page(c.req.param('name'), c.req.param('page'), { after: c.req.query('after') }) });
  } catch (e) {
    return fail(c, e);
  }
});

pluginAdminRouter.get('/:name/settings', requireSiteMember(), async (c) => {
  try {
    return c.json({ data: await panels(c).settings(c.req.param('name')) });
  } catch (e) {
    return fail(c, e);
  }
});

pluginAdminRouter.put('/:name/settings', requireSiteAdmin(), async (c) => {
  try {
    const body = await c.req.json().catch(() => null);
    return c.json({ data: await panels(c).saveSettings(c.req.param('name'), (body as { values?: unknown } | null)?.values ?? body) });
  } catch (e) {
    return fail(c, e);
  }
});

/** Everything the plugin stored on this site — also after it was disabled or uninstalled. */
pluginAdminRouter.get('/:name/storage/export', requireSiteAdmin(), async (c) => {
  const { storage } = await pluginStorageFor(c.get('db'), c.get('siteId'), c.req.param('name'));
  const data = await storage.exportAll();
  c.header('Content-Disposition', `attachment; filename="${c.req.param('name').replace(/[^a-z0-9_-]/gi, '_')}-storage.json"`);
  return c.json({ data });
});

/**
 * Delete the plugin's storage on this site: a separate, deliberate step — never part of disabling. The plugin must not
 * be enabled, and `confirm` must repeat its name.
 */
pluginAdminRouter.delete('/:name/storage', requireSiteAdmin(), async (c) => {
  const name = c.req.param('name');
  if (c.req.query('confirm') !== name) {
    return c.json({ errors: [{ code: 'CONFIRMATION_REQUIRED', message: 'Repeat the plugin name in "confirm"; export the storage first.' }] }, 400);
  }
  const { storage, row } = await pluginStorageFor(c.get('db'), c.get('siteId'), name);
  if (row?.enabled) return c.json({ errors: [{ code: 'PLUGIN_ENABLED', message: 'Disable the plugin before deleting its storage.' }] }, 409);
  const deleted = await storage.purge();
  const auth = c.get('auth');
  await new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') })
    .write({ event: 'plugin_storage_purged', actorEmail: auth?.email ?? null, ip: null, userAgent: null, requestId: null, metadata: { extensionName: name, deleted } })
    .catch(() => {});
  return c.json({ data: { deleted } });
});

/** A new signing secret for the plugin's server callbacks on this site, shown once. */
pluginAdminRouter.post('/:name/callback-secret', requireSiteAdmin(), async (c) => {
  const name = c.req.param('name');
  const { row } = await pluginStorageFor(c.get('db'), c.get('siteId'), name);
  if (!row || !grantsPoint(row, 'endpoints')) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'No plugin with endpoints of that name.' }] }, 404);
  const keys = c.get('runtime')?.keys;
  if (!keys) return c.json({ errors: [{ code: 'KEYS_UNAVAILABLE', message: 'No key provider is configured.' }] }, 503);
  const secret = await rotateCallbackSecret(c.get('db'), keys, c.get('siteId'), name);
  c.header('Cache-Control', 'no-store');
  return c.json({ data: { secret } });
});

/** Job state and recent runs of a plugin on this site. */
pluginAdminRouter.get('/:name/jobs', requireSiteAdmin(), async (c) => {
  const db = c.get('db');
  const siteId = c.get('siteId');
  const name = c.req.param('name');
  const { row } = await pluginStorageFor(db, siteId, name);
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'No such plugin.' }] }, 404);
  const jobs = await db
    .select({
      jobName: pluginJobs.jobName,
      nextRunAt: pluginJobs.nextRunAt,
      lastRunAt: pluginJobs.lastRunAt,
      lastStatus: pluginJobs.lastStatus,
      lastError: pluginJobs.lastError,
      attempts: pluginJobs.attempts,
      running: pluginJobs.leaseToken,
    })
    .from(pluginJobs)
    .where(and(eq(pluginJobs.siteId, siteId), eq(pluginJobs.extensionName, name)));
  const runs = await db
    .select()
    .from(pluginJobRuns)
    .where(and(eq(pluginJobRuns.siteId, siteId), eq(pluginJobRuns.extensionName, name)))
    .orderBy(desc(pluginJobRuns.startedAt))
    .limit(20);
  return c.json({
    data: {
      runnable: isRunnable(row) && grantsPoint(row, 'jobs'),
      jobs: jobs.map((j) => ({ ...j, running: Boolean(j.running) })),
      runs,
    },
  });
});
