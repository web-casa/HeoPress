// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../env';
import { PluginBriefing } from '../extensions/runtime/briefing-sections';
import { extensionsRouter } from './extensions';

function testApp(roles: string[]) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('auth', { roles, raw: {} });
    c.set('siteId', 'site-a');
    c.set('db', {} as AppEnv['Variables']['db']);
    return next();
  });
  app.route('/extensions', extensionsRouter);
  return app;
}

describe('extensions router authorization', () => {
  it('requires the admin role before extension management routes can run', async () => {
    const res = await testApp(['member']).request('/extensions', {
      method: 'POST',
      body: JSON.stringify({
        name: 'pwn',
        version: '1.0.0',
        type: 'endpoint',
        enabled: true,
        bundleUrl: 'data:text/javascript,export default {}',
        capabilities: ['db:write'],
      }),
      headers: { 'content-type': 'application/json' },
    });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }],
    });
  });

  it('requires the admin role before dynamic endpoint extension routes can run', async () => {
    const res = await testApp(['member']).request('/extensions/search/ping');

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }],
    });
  });
});

describe('extensions router: briefing sections (v1.1)', () => {
  const section = {
    plugin: 'stale-drafts',
    pluginName: 'Stale drafts',
    id: 'stale-drafts',
    title: 'Stale drafts',
    description: null,
    count: 2,
    items: [{ label: 'Draft one', href: '/content/articles/a1' }],
  };

  it('serves the briefing of the active site to a site administrator', async () => {
    const list = vi.spyOn(PluginBriefing.prototype, 'list').mockResolvedValue([section]);
    try {
      const res = await testApp(['admin']).request('/extensions/briefing-sections');
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ data: [section] });
      expect(list).toHaveBeenCalledWith('site-a');
    } finally {
      list.mockRestore();
    }
  });

  it('is a Studio view: a member who is not a site administrator is refused, not handed to the plugin-endpoint catch-all', async () => {
    // `adminOnly` (the catch-all's guard) says "Admin role required."; the briefing is guarded by site membership instead,
    // so the refusal names site administration — which is what tells the two apart here.
    const res = await testApp(['member']).request('/extensions/briefing-sections');
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      errors: [{ code: 'FORBIDDEN', message: 'Admin access for the requested site is required.' }],
    });
  });
});
