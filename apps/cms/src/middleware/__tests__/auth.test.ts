// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Database } from '@heopress/database';
import type { AppEnv } from '../../env';
import { withAuth } from '../auth';

function makeFakeDb(): Database {
  const fluent = {
    from: () => fluent,
    where: () => fluent,
    limit: () => Promise.resolve([]),
  };

  return {
    select: () => fluent,
  } as unknown as Database;
}

function buildApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('db', makeFakeDb());
    await next();
  });
  app.use('*', withAuth());
  app.get('/protected', (c) => c.json({ auth: c.get('auth') }));
  return app;
}

const ORIGINAL_ENV = {
  HEOPRESS_DEV_AUTH: process.env.HEOPRESS_DEV_AUTH,
  HEOPRESS_ENV: process.env.HEOPRESS_ENV,
  NODE_ENV: process.env.NODE_ENV,
  JWT_SECRET: process.env.JWT_SECRET,
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('withAuth dev-token gate', () => {
  it('accepts dev tokens when dev auth is explicitly enabled in a development runtime', async () => {
    process.env.HEOPRESS_DEV_AUTH = 'true';
    process.env.NODE_ENV = 'development';
    delete process.env.HEOPRESS_ENV;
    process.env.JWT_SECRET = 'test-secret';

    const res = await buildApp().request(
      '/protected',
      {
        headers: { authorization: 'Bearer dev:admin@example.com:admin' },
      },
      {},
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      auth: {
        email: 'admin@example.com',
        roles: ['admin'],
        raw: { dev: true },
      },
    });
  });

  it('does not honor process.env HEOPRESS_DEV_AUTH in production', async () => {
    process.env.HEOPRESS_DEV_AUTH = 'true';
    process.env.NODE_ENV = 'production';
    delete process.env.HEOPRESS_ENV;
    process.env.JWT_SECRET = 'test-secret';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await buildApp().request(
      '/protected',
      {
        headers: { authorization: 'Bearer dev:attacker@example.com:admin' },
      },
      {},
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({
      errors: [{ code: 'UNAUTHENTICATED', message: 'Invalid bearer token.' }],
    });
  });

  it('requires an explicit development runtime before accepting dev tokens', async () => {
    process.env.HEOPRESS_DEV_AUTH = 'true';
    delete process.env.NODE_ENV;
    delete process.env.HEOPRESS_ENV;
    process.env.JWT_SECRET = 'test-secret';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await buildApp().request(
      '/protected',
      {
        headers: { authorization: 'Bearer dev:attacker@example.com:admin' },
      },
      {},
    );

    expect(res.status).toBe(401);
  });

  it('lets production markers override development bindings', async () => {
    process.env.HEOPRESS_DEV_AUTH = 'true';
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = 'test-secret';
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await buildApp().request(
      '/protected',
      {
        headers: { authorization: 'Bearer dev:attacker@example.com:admin' },
      },
      { HEOPRESS_ENV: 'development', HEOPRESS_DEV_AUTH: 'true' },
    );

    expect(res.status).toBe(401);
  });
});
