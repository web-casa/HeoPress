import { Hono, type Context } from 'hono';
import type { Database } from '@heopress/database';
import type { AppEnv } from '../env';
import { AuditLogger } from '../modules/audit/logger';
import { isFrontendAudience } from '../services/auth/token-audience';
import { deleteHostMapping } from '../services/domains/host-cache';
import { invalidateSiteExists } from '../services/domains/site-exists-cache';
import { isValidSiteId } from '../services/identifier-guard';
import { invalidateDeliverTag } from '../services/content-invalidation';
import { forgetNegative, negativeCollectionKey, negativeSiteKey } from '../services/negative-cache';
import { PermissionService } from '../services/permission-service';
import { SchemaService } from '../services/schema-service';
import { reconcileOfficialExtensions } from '../services/official-extension-reconciler';
import { runSiteTransaction } from '../services/rls-transaction';
import { deleteSite } from '../services/site-network/delete-site';
import { dropPresetCaches } from '../services/site-network/preset-installer';
import { canCreateSite, provisionSite, SiteProvisioningError, validateNewSite } from '../services/sites/site-provisioning';

/**
 * Sites of the instance (HeoPress P07 task 0.1), on the instance control plane (`index.ts`): the request's
 * own site is only where the caller's session was issued; what decides is whether the caller may manage
 * sites at all (the bootstrap administrator, see `services/sites/site-provisioning.ts`).
 *
 *   POST   /api/v1/instance/sites       { id, name, defaultLanguage? } → the new site, the caller its Administrator
 *   DELETE /api/v1/instance/sites/:id   delete a site (and everything in it); never the last one, never the
 *                                       site the caller is signed in on
 *
 * Both are audited in the caller's own site (a deleted site's audit rows go with it).
 */
export const sitesRouter = new Hono<AppEnv>();

const failure = (c: Context<AppEnv>, err: unknown) => {
  if (err instanceof SiteProvisioningError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
  throw err;
};

/**
 * The person behind the request, when it can hold an instance capability: a Studio session or a
 * Cloudflare Access login — never an API key, an anonymous or development principal, or a session minted
 * for the public site (frontend audience).
 */
const personOf = (c: Context<AppEnv>): string | null => {
  const auth = c.get('auth');
  if (!auth?.userId || (auth.method !== 'session' && auth.method !== 'cf_access')) return null;
  if (isFrontendAudience(auth.raw?.aud)) return null;
  return auth.userId;
};

/** The audit record of a control-plane change, written in the caller's own site by `tx` (in that site's scope). */
const auditWriter = (c: Context<AppEnv>, event: 'site_created' | 'site_deleted', target: string) => (tx: Database) =>
  new AuditLogger({ db: c.get('db'), siteId: c.get('siteId') }).writeInTransaction(tx, {
    event,
    actorEmail: c.get('auth')?.email ?? null,
    requestId: c.get('requestId') ?? null,
    metadata: { targetSiteId: target },
  });

/**
 * Caches that remember a site, once it was created or deleted: best effort (each step on its own; the
 * database already holds the truth, and every entry has a TTL as the last resort — a deleted site's id is
 * not reused before those TTLs end, so what is missed here cannot be read by another site).
 */
async function forgetSiteCaches(c: Context<AppEnv>, siteId: string, gone: { hostnames: string[]; collections: string[] }): Promise<void> {
  const cache = c.get('runtime')?.cache;
  if (!cache) return;
  const schema = new SchemaService({ db: c.get('db'), siteId, cache });
  const steps: Array<() => Promise<unknown>> = [
    () => forgetNegative(cache, negativeSiteKey(siteId)),
    () => invalidateSiteExists(cache, siteId),
    // Permission bundles are versioned per site: moving the version on orphans them (never back to 1).
    () => PermissionService.bumpVersion(cache, siteId),
    () => cache.delete(`typegen:${siteId}`),
    () => cache.delete(`typegen:${siteId}:schema`),
    () => cache.delete(`perm:${siteId}:schema`),
    () => invalidateDeliverTag(cache, siteId, c.get('runtime')?.edgeCache),
    ...gone.hostnames.map((h) => () => deleteHostMapping(cache, h)),
    ...gone.collections.flatMap((name) => [() => schema.invalidate(name), () => forgetNegative(cache, negativeCollectionKey(siteId, name))]),
  ];
  for (const step of steps) {
    await step().catch((err: unknown) => console.error('[sites] cache cleanup failed', siteId, err instanceof Error ? err.message : err));
  }
}

sitesRouter.post('/', async (c) => {
  const db = c.get('db');
  try {
    const input = validateNewSite(await c.req.json().catch(() => ({})));
    const userId = personOf(c);
    if (!userId) throw new SiteProvisioningError('FORBIDDEN', 'Creating sites needs the instance administrator.', 403);
    const row = await provisionSite(db, input, userId);
    // Committed: what follows records it and repairs caches and extensions; a failure there is logged, not answered.
    // Recorded in the caller's site, in its scope (the control plane has no request-wide scope).
    await runSiteTransaction(db, c.get('siteId'), (tx) => auditWriter(c, 'site_created', row.id)(tx as unknown as Database)).catch((err: unknown) =>
      console.error('[sites] audit write failed', row.id, err instanceof Error ? err.message : err),
    );
    // A failure leaves the drop pending in the site's preset record: the worker's preset job retries it.
    await dropPresetCaches(db, row.id, c.get('runtime')?.cache).catch((err: unknown) => console.error('[sites] preset cache invalidation failed', err));
    // Official `heopress-*` extensions for the new site, in its scope; fail-soft (skips when no verified source exists).
    await runSiteTransaction(db, row.id, (tx) => reconcileOfficialExtensions(tx as unknown as Database, c.env, row.id)).catch((err: unknown) =>
      console.error('[sites] official extensions not reconciled', row.id, err instanceof Error ? err.message : err),
    );
    await forgetSiteCaches(c, row.id, { hostnames: [], collections: [] });
    return c.json({ data: row }, 201);
  } catch (err) {
    return failure(c, err);
  }
});

sitesRouter.delete('/:id', async (c) => {
  const db = c.get('db');
  const target = c.req.param('id');
  if (!isValidSiteId(target)) return c.json({ errors: [{ code: 'VALIDATION', message: 'Not a site id.' }] }, 400);
  if (!(await canCreateSite(db, personOf(c)))) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Deleting sites needs the instance administrator.' }] }, 403);
  }
  if (target === c.get('siteId')) {
    return c.json({ errors: [{ code: 'SIGNED_IN_SITE', message: 'Sign in on another site to delete this one.' }] }, 409);
  }
  // Its items leave other sites' translation groups first (P05, R44): those groups stay consistent. The caller's
  // site must still exist then, and the audit record is written there in the same transaction.
  const result = await deleteSite(db, target, { caller: { siteId: c.get('siteId'), record: auditWriter(c, 'site_deleted', target) } });
  if (result.outcome === 'missing') return c.json({ errors: [{ code: 'NOT_FOUND', message: 'No such site.' }] }, 404);
  if (result.outcome === 'last') return c.json({ errors: [{ code: 'LAST_SITE', message: 'The last site cannot be deleted.' }] }, 409);
  if (result.outcome === 'caller_gone') return c.json({ errors: [{ code: 'SIGNED_IN_SITE', message: 'The site you are signed in on is gone or is the one to delete.' }] }, 409);
  await forgetSiteCaches(c, target, result);
  return c.json({ data: { success: true } });
});
