import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { crawlDaily, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';
import type { AiTrafficReport } from '../services/site-network/ai-traffic';

/** The AI traffic API (HeoPress P07 task 6.2; spec analytics/ai-traffic "越权查看"): a site's members read its own; another site's people cannot. */

const JWT_SECRET = 'ai-traffic-secret';

describe.skipIf(!hasDbIntegrationUrl)('AI traffic — HTTP', () => {
  // THROWAWAY fail-closed probe for the sharded db-suites: never merged.
  it('fail-closed probe: a failing test in shard 4', () => {
    expect('shard 4').toBe('a failing shard');
  });

  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('ai-traffic-http');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'aitr', jwtSecret: JWT_SECRET });
    const today = new Date().toISOString().slice(0, 10);
    for (const [site, path] of [
      [fx.sites.a, '/only-a/'],
      [fx.sites.b, '/only-b/'],
    ] as const) {
      await runSiteTransaction(db, site, (tx) =>
        tx.insert(crawlDaily).values([
          { siteId: site, day: today, kind: 'crawler', agent: 'gptbot', operator: 'OpenAI', purpose: 'training', resource: 'page', path, hits: 3 },
          { siteId: site, day: today, kind: 'referral', agent: 'chatgpt', operator: 'OpenAI', purpose: '', resource: 'page', path, hits: 2 },
        ]),
      );
    }
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const get = (headers: Record<string, string>) => app.request('/api/v1/site/ai-traffic?days=7', { headers }, env);

  it('a member reads its site\'s figures; another site\'s administrator cannot; each site its own', async () => {
    const res = await get(fx.headers('a', await fx.session('onlyA', 'a')));
    expect(res.status, await res.clone().text()).toBe(200);
    const data = ((await res.json()) as { data: AiTrafficReport }).data;
    expect(data.totals).toEqual({ crawler: 3, referral: 2 });
    expect(data.topCrawled).toEqual([{ path: '/only-a/', resource: 'page', hits: 3 }]);
    expect(data.topLanding).toEqual([{ path: '/only-a/', hits: 2, sources: ['chatgpt'] }]);
    expect(JSON.stringify(data)).not.toContain('only-b');
    // Site B's administrator asking for A: refused.
    // Another site's administrator (spec "越权查看"): refused, and nothing of the site in the answer.
    const foreign = await get(fx.headers('a', await fx.session('adminB', 'b')));
    expect([401, 403, 404]).toContain(foreign.status);
    expect(await foreign.text()).not.toMatch(/"data"/);
    const b = ((await (await get(fx.headers('b', await fx.session('adminB', 'b')))).json()) as { data: AiTrafficReport }).data;
    expect(JSON.stringify(b)).not.toContain('only-a');
  });
});
