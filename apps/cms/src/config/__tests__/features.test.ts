import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import app from '../../index';
import { enabledFeatures, FEATURE_ENV, isFeatureEnabled, requireFeature, type Feature } from '../features';

/**
 * Default-off features (P02 task 5.1; spec platform/feature-surface
 * "默认关闭的功能"). One case per feature: off → its HTTP surface answers 404
 * and its work does not run or is not scheduled; on → the original behaviour
 * (the upstream suites for each feature run with the flag set).
 */

const FEATURES = Object.keys(FEATURE_ENV) as Feature[];
const src = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');

describe('feature switches', () => {
  beforeEach(() => {
    for (const name of Object.values(FEATURE_ENV)) vi.stubEnv(name, '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('every feature is off on a fresh install', () => {
    expect(enabledFeatures()).toEqual(Object.fromEntries(FEATURES.map((f) => [f, false])));
  });

  it.each(FEATURES)('%s turns on with "true" or "1" and stays off for anything else', (feature) => {
    const name = FEATURE_ENV[feature];
    expect(isFeatureEnabled(feature, { [name]: 'true' })).toBe(true);
    expect(isFeatureEnabled(feature, { [name]: '1' })).toBe(true);
    for (const value of ['false', '0', 'yes', '']) expect(isFeatureEnabled(feature, { [name]: value })).toBe(false);
  });

  it('request bindings win over the process environment', () => {
    vi.stubEnv('HEOPRESS_ENABLE_GRAPHQL', 'true');
    expect(isFeatureEnabled('graphql')).toBe(true);
    expect(isFeatureEnabled('graphql', { HEOPRESS_ENABLE_GRAPHQL: 'false' })).toBe(false);
  });

  it('requireFeature answers 404 while off and passes through while on', async () => {
    const mini = new Hono();
    mini.use('/x', requireFeature('graphql'));
    mini.get('/x', (c) => c.text('ok'));
    const off = await mini.request('/x', {}, {});
    expect(off.status).toBe(404);
    expect(await off.json()).toEqual({ errors: [{ code: 'NOT_FOUND', message: 'Not Found' }] });
    expect((await mini.request('/x', {}, { HEOPRESS_ENABLE_GRAPHQL: 'true' })).status).toBe(200);
  });

  describe('metrics (real app)', () => {
    it('GET /metrics answers 404 by default and the exposition when enabled', async () => {
      expect((await app.request('/metrics', {}, { HEOPRESS_ENV: 'development' })).status).toBe(404);
      const on = await app.request('/metrics', {}, { HEOPRESS_ENV: 'development', HEOPRESS_ENABLE_METRICS: 'true' });
      expect(on.status).toBe(200);
      expect(await on.text()).toContain('# HELP');
    });

    it('requests are not recorded while metrics are off', () => {
      expect(src('routes/metrics.ts')).toMatch(/if \(c\.req\.path === '\/metrics' \|\| !isFeatureEnabled\('metrics'/);
    });
  });

  describe('gated routes in src/index.ts (registered before the routes they guard)', () => {
    const index = src('index.ts');
    const gate = (path: string, feature: Feature, route: string) => {
      const guardAt = index.indexOf(`api.use('${path}', requireFeature('${feature}'))`);
      expect(guardAt, `${path} is gated by ${feature}`).toBeGreaterThan(-1);
      expect(guardAt).toBeLessThan(index.indexOf(route));
    };

    it('graphql', () => {
      expect(index).toContain("api.all('/graphql', requireFeature('graphql'), (c) => handleGraphQL(c));");
    });
    it('contentGoals: /agent/intents', () => {
      gate('/agent/intents', 'contentGoals', "api.route('/agent/intents', intentsRouter);");
      gate('/agent/intents/*', 'contentGoals', "api.route('/agent/intents', intentsRouter);");
    });
    it('agentNewsroom: roles, decompose, settle', () => {
      gate('/agent/roles', 'agentNewsroom', "api.route('/agent', agentRouter);");
      gate('/agent/roles/*', 'agentNewsroom', "api.route('/agent', agentRouter);");
      gate('/agent/goals/:id/decompose', 'agentNewsroom', "api.route('/agent', agentRouter);");
      gate('/agent/goals/:id/settle', 'agentNewsroom', "api.route('/agent', agentRouter);");
    });
    it('externalIssuers: /admin/auth/issuers', () => {
      gate('/admin/auth/issuers', 'externalIssuers', "api.route('/admin/auth/issuers', adminAuthIssuersRouter);");
      gate('/admin/auth/issuers/*', 'externalIssuers', "api.route('/admin/auth/issuers', adminAuthIssuersRouter);");
    });
  });

  describe('work that does not run while off', () => {
    it('externalIssuers: withAuth skips the trusted-issuer lookup', () => {
      expect(src('middleware/auth.ts')).toMatch(
        /isFeatureEnabled\('externalIssuers'[^)]*\)\s*\?\s*await tryExternalJwt\(c, bearerToken\)\s*:\s*\(\{ kind: 'skip' \} as const\)/,
      );
    });
    it('loginAnomaly: login skips the detectors and the baseline write', () => {
      const auth = src('routes/auth.ts');
      expect(auth).toMatch(/if \(!anomalyScoring\) \{\n\s*anomaly = \{ score: 0, baselineWarmup: false \};\n\s*\} else try \{\n\s*anomaly = await runDetectors\(/);
      expect(auth).toContain('...(anomalyScoring ? {} : { updateBaseline: async () => undefined })');
    });
    it('contentGoals: serve.ts does not schedule the goal dispatch tick', () => {
      expect(src('serve.ts')).toContain('goalDispatchTask = !contentGoalsEnabled ? undefined : cron.schedule(');
    });
  });
});
