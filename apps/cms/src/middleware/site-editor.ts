import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { PermissionService } from '../services/permission-service';
import { requireSiteAdmin } from './site-admin';

/**
 * Require an editor of the active site (HeoPress P05): a site administrator,
 * or a principal (user or API key) that may create or update content in some
 * collection of the site. For site-wide editorial settings such as the
 * editorial profile, which belong to no one collection.
 */
export const requireSiteEditor = (): MiddlewareHandler<AppEnv> => async (c, next) => {
  const auth = c.get('auth');
  const siteId = c.get('siteId');
  if (siteId && auth && auth.type !== 'anonymous' && (auth.userId || auth.apiKeyId)) {
    const bundle = await new PermissionService({
      db: c.get('db'),
      cache: c.get('runtime')?.cache,
      ctx: {
        userId: auth.userId ?? null,
        siteId,
        roleId: auth.roleId ?? null,
        user: auth.userId ? { id: auth.userId, email: auth.email ?? null, roles: auth.roles ?? [], ...(auth.raw ?? {}) } : undefined,
        ip: c.get('ip') ?? null,
        headers: {},
        apiKey: auth.apiKey ?? null,
      },
    }).bundle();
    if (bundle.admin || Object.values(bundle.byKey).some((p) => p.action === 'create' || p.action === 'update')) return next();
  }
  // Administrators by the other routes (dev tokens, Cloudflare Access) are editors too.
  return requireSiteAdmin()(c, next);
};
