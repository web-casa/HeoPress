// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { AppEnv } from '../../env';
import { LATEST_MIGRATION } from '@heopress/database';
import { healthRouter } from '../health';

interface BuildOptions {
  unhealthy?: boolean;
  searchError?: string;
  migrationsPending?: boolean;
  onDatabaseQuery?: () => void;
}

function buildApp(options?: BuildOptions) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('runtime', {
      runtime: 'docker',
      database: {
        getConnection: () => async (strings: TemplateStringsArray) => {
          options?.onDatabaseQuery?.();
          if (options?.unhealthy) throw new Error('db down');
          if (strings.join('?').includes('__drizzle_migrations')) {
            return [{ latest: String(LATEST_MIGRATION.when - (options?.migrationsPending ? 1 : 0)) }];
          }
          if (strings.join('?').includes('pg_extension')) {
            // P03: pg_trgm installed; vector search off, so nothing else is required.
            return [{ trgm: true, vector: false, zhparser: false, zh_config: false }];
          }
          return [{ ok: 1 }];
        },
        close: async () => {},
      },
      cache: {
        get: async () => (options?.unhealthy ? null : 'ok'),
        set: async () => {},
        delete: async () => {},
      },
      search: {
        getIndex: async () => {
          if (options?.unhealthy) throw new Error('connection refused');
          if (options?.searchError) throw new Error(options.searchError);
          throw new Error('index_not_found');
        },
      },
      storage: {
        list: async () => {
          if (options?.unhealthy) throw new Error('storage down');
          return [];
        },
      },
      queue: {
        enqueue: async () => (options?.unhealthy ? '' : 'job_1'),
      },
    } as never);
    await next();
  });
  app.route('/health', healthRouter);
  return app;
}

function buildAppWithEnv(env: Record<string, string>, options?: BuildOptions) {
  const app = buildApp(options);
  // Layer a middleware that populates c.env (Workers-style bindings). The
  // healthy-runtime middleware from buildApp runs first via app.use, so both are
  // present by the time the route executes.
  const wrapped = new Hono<AppEnv>();
  wrapped.use('*', async (c, next) => {
    c.env = { ...(c.env ?? {}), ...env } as AppEnv['Bindings'];
    await next();
  });
  wrapped.route('/', app);
  return wrapped;
}

describe('health routes', () => {
  it('an unreachable search service is unhealthy, not mistaken for a missing index (P03 task 7.2)', async () => {
    for (const searchError of ['getaddrinfo ENOTFOUND meilisearch', 'Request to http://meili:7700/indexes/_health has failed', 'host not found']) {
      const res = await buildApp({ searchError }).request('/health/ready');
      expect(res.status, searchError).toBe(503);
      expect(await res.json(), searchError).toMatchObject({ services: { search: 'unhealthy' } });
    }
  });

  it('keeps /health as a 200 degraded-info endpoint', async () => {
    const res = await buildApp({ unhealthy: true }).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'degraded' });
  });

  it('exposes /health/ready with a 503 when dependencies are degraded', async () => {
    const res = await buildApp({ unhealthy: true }).request('/health/ready');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: 'degraded' });
  });

  it('returns 200 from /health/ready when all probes are healthy', async () => {
    const res = await buildApp().request('/health/ready');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'healthy' });
  });

  it('hides per-subsystem detail from anonymous callers when a token is configured', async () => {
    const app = buildAppWithEnv({ METRICS_TOKEN: 'sekret' });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: 'healthy' });
    expect(body.services).toBeUndefined();
  });

  it('reveals per-subsystem detail to a caller with the observability token', async () => {
    const app = buildAppWithEnv({ METRICS_TOKEN: 'sekret' });
    const res = await app.request('/health', {
      headers: { authorization: 'Bearer sekret' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; services?: Record<string, string> };
    expect(body.status).toBe('healthy');
    expect(body.services).toMatchObject({ database: 'healthy' });
  });

  it('denies detail to a caller with a wrong token', async () => {
    const app = buildAppWithEnv({ METRICS_TOKEN: 'sekret' });
    const res = await app.request('/health', {
      headers: { authorization: 'Bearer nope' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.services).toBeUndefined();
  });

  it('answers /health/live with 200 without probing any dependency, even when everything is down', async () => {
    let queries = 0;
    const res = await buildApp({ unhealthy: true, onDatabaseQuery: () => { queries += 1; } }).request('/health/live');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'alive' });
    expect(queries).toBe(0);
  });

  it('reports the database as the failing dependency to a trusted caller when it is down', async () => {
    const app = buildAppWithEnv({ METRICS_TOKEN: 'sekret' }, { unhealthy: true });
    const res = await app.request('/health/ready', { headers: { authorization: 'Bearer sekret' } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { services?: Record<string, string> };
    expect(body.services).toMatchObject({ database: 'unhealthy' });
  });

  it('fails /health/ready when bundled migrations have not been applied', async () => {
    const app = buildAppWithEnv({ METRICS_TOKEN: 'sekret' }, { migrationsPending: true });
    const res = await app.request('/health/ready', { headers: { authorization: 'Bearer sekret' } });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { services?: Record<string, string> };
    expect(body.services).toMatchObject({ database: 'healthy', migrations: 'unhealthy' });
  });
});
