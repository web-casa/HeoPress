import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { themesRouter } from '../themes';
import { PermissionService } from '../../services/permission-service';
import { ThemeService } from '../../services/themes/theme-service';
import type { AppEnv } from '../../env';

/** Installing a starter theme over HTTP (HeoPress P06 task 5.1): site administrators only, into the request's site. */

function appFor(siteId: string) {
  const app = new Hono<AppEnv>();
  const cache = { get: async () => null, set: async () => undefined, delete: async () => undefined };
  app.use('*', async (c, next) => {
    c.set('siteId', siteId);
    c.set('auth', { userId: 'u1', roles: ['editor'], raw: {} } as never);
    c.set('db', {} as never);
    c.set('runtime', { cache } as never);
    await next();
  });
  app.route('/themes', themesRouter);
  return app;
}

const post = (app: Hono<AppEnv>, name: string) => app.request(`/themes/starters/${name}`, { method: 'POST' });

describe('POST /themes/starters/:name', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is refused to a member who does not administer the site, before anything is installed', async () => {
    vi.spyOn(PermissionService.prototype, 'bundle').mockResolvedValue({ admin: false } as never);
    const install = vi.spyOn(ThemeService.prototype, 'installStarter');
    expect((await post(appFor('site-a'), 'news')).status).toBe(403);
    expect(install).not.toHaveBeenCalled();
  });

  it('installs into the request site for an administrator: 201 with the new version', async () => {
    vi.spyOn(PermissionService.prototype, 'bundle').mockResolvedValue({ admin: true } as never);
    let site: string | undefined;
    vi.spyOn(ThemeService.prototype, 'installStarter').mockImplementation(async function (this: ThemeService, name: string) {
      site = (this as unknown as { deps: { siteId: string } }).deps.siteId;
      return { id: 'v1', name } as never;
    });
    const res = await post(appFor('site-b'), 'tech');
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ data: { id: 'v1', name: 'tech' } });
    expect(site).toBe('site-b');
  });

  it('an unknown or inherited name is 404, not a lookup on the prototype', async () => {
    vi.spyOn(PermissionService.prototype, 'bundle').mockResolvedValue({ admin: true } as never);
    for (const name of ['nope', '__proto__', 'constructor', 'toString']) {
      const res = await post(appFor('site-a'), name);
      expect(res.status, name).toBe(404);
      expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('NOT_FOUND');
    }
  });
});
