import { describe, expect, it } from 'vitest';

import { createWorkerHealthApp, databaseReadinessProbe } from '../worker-health';

/**
 * Worker health endpoints (P01 `platform/runtime-baseline`): liveness never
 * probes; readiness follows the probe and fails closed when it throws or hangs.
 * The real-database states are covered in
 * `routes/__tests__/health-readiness.db.integration.test.ts`.
 */

const neverSettles = () => new Promise<never>(() => {});

describe('worker health', () => {
  it('liveness answers 200 without running the readiness probe', async () => {
    let probed = false;
    const app = createWorkerHealthApp(async () => {
      probed = true;
      return { database: false, migrations: false, extensions: false };
    });
    expect((await app.request('/health/live')).status).toBe(200);
    expect(probed).toBe(false);
  });

  it('readiness is 200 only when the database is up, migrated and has the required extensions', async () => {
    const status = async (database: boolean, migrations: boolean, extensions = true) =>
      (await createWorkerHealthApp(async () => ({ database, migrations, extensions })).request('/health/ready')).status;
    expect(await status(true, true)).toBe(200);
    expect(await status(true, true, false)).toBe(503);
    expect(await status(true, false)).toBe(503);
    expect(await status(false, false)).toBe(503);
  });

  it('readiness is 503 when the probe throws', async () => {
    const app = createWorkerHealthApp(async () => {
      throw new Error('boom');
    });
    const res = await app.request('/health/ready');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable', role: 'worker', service: 'heopress-cms' });
  });

  it('a hung database connection reports not ready within the timeout', async () => {
    const sql = (() => neverSettles()) as never;
    const started = Date.now();
    expect(await databaseReadinessProbe(sql, 20)()).toEqual({ database: false, migrations: false, extensions: false });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('a reachable database whose migration and extension queries hang is reachable but not ready', async () => {
    let calls = 0;
    const sql = ((strings: TemplateStringsArray) => {
      calls += 1;
      return strings.join('').includes('SELECT 1') ? Promise.resolve([{ '?column?': 1 }]) : neverSettles();
    }) as never;
    expect(await databaseReadinessProbe(sql, 20)()).toEqual({ database: true, migrations: false, extensions: false });
    expect(calls).toBe(3);
  });
});
