import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { PermissionService } from '../services/permission-service';
import { requireSiteAdmin } from './site-admin';

/**
 * Require a member of the active site (HeoPress P07a task 8.1): a principal (user or API key) whose roles or policies
 * give it Studio access to the site, or a site administrator. For read-only views of site-wide SEO settings (structured
 * data, root files, redirects) that every member may see while only administrators change them.
 */
export const requireSiteMember = (): MiddlewareHandler<AppEnv> => async (c, next) => {
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
    if (bundle.admin || bundle.appAccess) return next();
  }
  return requireSiteAdmin()(c, next);
};
