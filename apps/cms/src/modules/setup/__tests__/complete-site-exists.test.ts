import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { MemoryCacheProvider } from '@heopress/runtime';

import type { AppEnv } from '../../../env';
import { siteExists } from '../../../services/domains/site-exists-cache';
import { setupRouter } from '../routes';
import { DEFAULT_SITE_ID } from '../site-constants';

/**
 * A request made before setup caches "no such site" for the default site.
 * Completing setup must drop that verdict, or the new administrator cannot
 * sign in until the negative TTL runs out (found by the P03 minimal-deploy
 * smoke test: 404 TENANT_NOT_FOUND for ~30 s after setup).
 */

type SetupOverride = NonNullable<AppEnv['Variables']['setupServiceOverride']>;

describe('setup completion and the site-exists cache', () => {
  it('a cached "unknown site" for the default site is gone once setup completes', async () => {
    const cache = new MemoryCacheProvider();
    let siteCreated = false;
    // The database answers "no site" until setup has run.
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => (siteCreated ? [{ id: DEFAULT_SITE_ID }] : []) }) }) }),
    } as never;
    expect(await siteExists(db, cache, DEFAULT_SITE_ID)).toBe(false); // pre-setup request, now cached

    const service: SetupOverride = {
      async complete() {
        siteCreated = true;
        return { ok: true, value: { adminPath: '/admin-x' } };
      },
    };
    const app = new Hono<AppEnv>();
    app.use('*', async (c, next) => {
      c.set('db', db);
      c.set('requestId', 'req_test');
      c.set('runtime', { cache } as never);
      c.set('setupServiceOverride', service);
      await next();
    });
    app.route('/api/v1/setup', setupRouter);
    const res = await app.request(
      '/api/v1/setup/complete',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.9' },
        body: JSON.stringify({
          account: { email: 'admin@example.com', password: 'Sup3r$ecret!Pass', firstName: 'Ada', lastName: 'Lovelace' },
          adminPath: '/admin-x',
        }),
      },
      { HEOPRESS_ENV: 'development', DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/test' } as never,
    );
    expect(res.status).toBe(201);
    expect(await siteExists(db, cache, DEFAULT_SITE_ID)).toBe(true);
  });
});
