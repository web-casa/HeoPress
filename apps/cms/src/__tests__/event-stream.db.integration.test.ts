import { SignJWT } from 'jose';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, authSessions, cdcChangeEvents, contentReviews, policies, systemEvents, userPolicies, users, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { AuditLogger } from '../modules/audit/logger';
import { createLoginSession } from '../services/auth/login-sessions';
import { TOKEN_AUDIENCE } from '../services/auth/token-audience';
import { readEvents, SINCE_LOOKBACK_MS, type StreamEvent } from '../services/ops/event-stream';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/** The event stream, its counts and the status cards (HeoPress P07a tasks 11.3–11.6; spec ops/event-log). */

const JWT_SECRET = 'event-stream-secret';

describe.skipIf(!hasDbIntegrationUrl)('event stream', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('event-stream');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'evstr', jwtSecret: JWT_SECRET });
    await new AuditLogger({ db, siteId: fx.sites.a }).write({ event: 'site_job_run', ip: '203.0.113.9', userAgent: 'Bot', metadata: { job: 'site-audit', status: 'failed', token: 'secret-token' } });
    await new AuditLogger({ db, siteId: fx.sites.b }).write({ event: 'site_job_run', metadata: { job: 'only-on-b', status: 'succeeded' } });
    await db.insert(systemEvents).values({ level: 'error', source: 'scheduler', event: 'scheduled_job_failed', message: 'evstr: failed', data: { job: 'evstr' } });
    await new Promise((r) => setTimeout(r, 300));
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const get = async (bearer: string, path: string) => app.request(`/api/v1/studio${path}`, { headers: { ...fx.headers('a', bearer), 'x-heopress-client': 'studio' } }, env);
  const events = async (bearer: string, query = '') => {
    const res = await get(bearer, `/events${query}`);
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as { data: StreamEvent[]; meta: { nextCursor: string | null; earliest: string | null; earliestBySource: Record<string, string> } };
  };
  async function bootstrapToken(): Promise<string> {
    const [b] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.isBootstrap, true)).limit(1);
    const [p] = await db.insert(policies).values({ siteId: fx.sites.a, name: 'Instance', key: 'evstr-instance', adminAccess: true, appAccess: true }).onConflictDoNothing().returning({ id: policies.id });
    if (p) await db.insert(userPolicies).values({ userId: b!.id, siteId: fx.sites.a, policyId: p.id }).onConflictDoNothing();
    const login = await createLoginSession(db, { userId: b!.id, mfaVerified: false, amr: ['pwd'], source: 'password' });
    await db.update(authSessions).set({ expiresAt: new Date(Date.now() + 86_400_000) }).where(eq(authSessions.id, login.id));
    return new SignJWT({ userId: b!.id, email: b!.email, roles: ['admin'], siteId: fx.sites.a, tokenVersion: 0, sid: login.id, authTime: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(TOKEN_AUDIENCE.studio)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(new TextEncoder().encode(JWT_SECRET));
  }

  it('a site administrator gets this site\'s events, redacted, without instance events or other sites', async () => {
    const { data } = await events(await fx.session('adminA', 'a'));
    const run = data.find((e) => e.event === 'site_job_run')!;
    expect(run).toMatchObject({ source: 'run', level: 'error' });
    expect(JSON.stringify(run)).not.toContain('203.0.113.9');
    expect(JSON.stringify(run)).not.toContain('secret-token');
    expect(data.some((e) => e.source === 'system')).toBe(false);
    expect(JSON.stringify(data)).not.toContain('only-on-b');
  });

  it('members without administration and API keys get 403', async () => {
    expect((await get(await fx.session('onlyA', 'a'), '/events')).status).toBe(403);
    expect((await get(fx.apiKeys.aEditor.token, '/events')).status).toBe(403);
    expect((await get(await fx.session('onlyA', 'a'), '/events/stats')).status).toBe(403);
    expect((await get(await fx.session('onlyA', 'a'), '/service-status')).status).toBe(403);
  });

  it('spec "超出保留期": a window reaching past a source\'s record says where each source begins', async () => {
    const DAY = 86_400_000;
    // The audit record reaches back 50 days; content changes only 20 (its older ones were removed by retention).
    await db.update(auditLog).set({ timestamp: new Date(Date.now() - 50 * DAY) }).where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'site_job_run')));
    const twentyDaysAgo = new Date(Date.now() - 20 * DAY);
    await db.insert(cdcChangeEvents).values({ siteId: fx.sites.a, collection: 'articles', itemId: 'evstr-item', operation: 'update', actorType: 'user', source: 'api', occurredAt: twentyDaysAgo });
    const from = new Date(Date.now() - 60 * DAY).toISOString();
    const { data, meta } = await events(await fx.session('adminA', 'a'), `?from=${encodeURIComponent(from)}`);
    expect(Date.parse(meta.earliestBySource.content!)).toBeLessThanOrEqual(twentyDaysAgo.getTime() + 1000);
    expect(Date.parse(meta.earliestBySource.content!)).toBeGreaterThan(Date.now() - 21 * DAY);
    expect(Date.parse(meta.earliestBySource.run!)).toBeLessThan(Date.now() - 49 * DAY);
    // Nothing of a source from before its record begins; the overall earliest is the oldest of them.
    for (const e of data) expect(Date.parse(e.at)).toBeGreaterThanOrEqual(Date.parse(meta.earliestBySource[e.source]!) - 1000);
    expect(meta.earliest).toBe(meta.earliestBySource.run);
    // A site administrator is not told about instance events.
    expect(meta.earliestBySource.system).toBeUndefined();
  });

  it('the bootstrap administrator also gets instance events', async () => {
    const { data } = await events(await bootstrapToken(), '?source=system');
    expect(data.some((e) => e.source === 'system' && e.message === 'evstr: failed')).toBe(true);
  });

  it('a review submitted long before it was approved shows both events, each at its own time', async () => {
    const submitted = new Date(Date.now() - 5 * 60_000);
    await db.insert(contentReviews).values({ siteId: fx.sites.a, itemId: fx.items.a, status: 'approved', createdAt: submitted, decidedAt: new Date() });
    const { data } = await events(await fx.session('adminA', 'a'), '?source=content');
    const ids = data.map((e) => e.id);
    expect(ids.some((id) => id.endsWith(':submitted'))).toBe(true);
    expect(ids.some((id) => id.endsWith(':approved'))).toBe(true);
    const approved = data.find((e) => e.id.endsWith(':approved'))!;
    expect(Date.parse(approved.at)).toBeGreaterThan(submitted.getTime() + 60_000);
  });

  it('reading since a time looks back 60 seconds: a late commit is neither lost nor duplicated', async () => {
    const lastSeen = new Date();
    // Written with a time just before what the reader saw last (a transaction that committed late).
    await new AuditLogger({ db, siteId: fx.sites.a }).write({ event: 'login_failed', metadata: { late: true } });
    await new Promise((r) => setTimeout(r, 300));
    const first = await readEvents(db, { siteId: fx.sites.a, platform: false }, {}, { since: new Date(lastSeen.getTime() + SINCE_LOOKBACK_MS / 2) });
    expect(first.events.some((e) => e.event === 'login_failed')).toBe(true);
    const again = await readEvents(db, { siteId: fx.sites.a, platform: false }, {}, { since: new Date(lastSeen.getTime() + SINCE_LOOKBACK_MS / 2) });
    const ids = new Set(first.events.map((e) => e.id));
    expect(again.events.filter((e) => !ids.has(e.id))).toEqual([]);
  });

  it('paging: no event twice, none skipped', async () => {
    for (let i = 0; i < 7; i += 1) await new AuditLogger({ db, siteId: fx.sites.a }).write({ event: 'login_succeeded', metadata: { i } });
    await new Promise((r) => setTimeout(r, 300));
    const all = (await events(await fx.session('adminA', 'a'), '?limit=200')).data.map((e) => e.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await events(await fx.session('adminA', 'a'), `?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.data.map((e) => e.id));
      cursor = page.meta.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
  });

  it('paging: events within one millisecond (the database keeps microseconds) are neither skipped nor repeated', async () => {
    const base = new Date(Date.now() - 60_000);
    for (let i = 0; i < 7; i += 1) {
      await db.insert(auditLog).values({ siteId: fx.sites.a, event: 'login_succeeded', metadata: { µs: i }, timestamp: sql`${base.toISOString()}::timestamptz + ${i} * interval '1 microsecond'` } as never);
    }
    const token = await fx.session('adminA', 'a');
    const all = (await events(token, '?limit=200')).data.map((e) => e.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await events(token, `?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.data.map((e) => e.id));
      cursor = page.meta.nextCursor;
    } while (cursor);
    expect(seen).toEqual(all);
  });

  it('stats: level counts ignore the level filter; the 60-minute histogram counts errors', async () => {
    const res = await get(await fx.session('adminA', 'a'), '/events/stats?level=info');
    const { data } = (await res.json()) as { data: { levels: Record<string, number>; minutes: Array<{ total: number; errors: number }> } };
    expect(data.levels.error).toBeGreaterThanOrEqual(1);
    expect(data.minutes).toHaveLength(60);
    expect(data.minutes.reduce((n, m) => n + m.errors, 0)).toBeGreaterThanOrEqual(1);
    const runOnly = (await (await get(await fx.session('adminA', 'a'), '/events/stats?source=content')).json()) as { data: { levels: Record<string, number> } };
    expect(runOnly.data.levels.error).toBe(0);
  });

  it('service status: a site administrator gets the site group only; the bootstrap administrator the instance group too', async () => {
    const admin = (await (await get(await fx.session('adminA', 'a'), '/service-status')).json()) as { data: Record<string, unknown> };
    expect(admin.data.site).toMatchObject({ reachability: { status: 'unknown', checkedAt: null } });
    expect(admin.data).not.toHaveProperty('instance');
    const boot = (await (await get(await bootstrapToken(), '/service-status')).json()) as { data: { instance: { services: Record<string, string> } } };
    expect(Object.keys(boot.data.instance.services)).toContain('database');
  });
});
