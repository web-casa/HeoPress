import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agentRuns, auditLog, editorialProfileVersions, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { AgentRunService } from '../services/agent-run-service';
import { EditorialProfileService } from '../services/site-network/editorial-profile-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Editorial profiles (HeoPress P05 tasks 2.1, 2.2; spec
 * content/editorial-profiles; design C): every save is a new version and the
 * history stays readable; one version is in effect; runs record the version
 * in effect when they start; members read it, editors save, administrators
 * publish; another site's is out of reach.
 */

const JWT_SECRET = 'editorial-profile-secret';

describe.skipIf(!hasDbIntegrationUrl)('editorial profiles — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('editorial-profile');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'epr', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const profiles = (siteId = fx.sites.a) => new EditorialProfileService({ db, siteId, actor: { userId: null } });
  const content = (tone: string) => ({ audience: 'Site operators', tone, glossary: [{ term: 'site network', preferred: '站群' }], forbiddenTopics: ['gambling'] });
  const as = async (who: 'adminA' | 'adminB' | 'onlyA' | 'both', site: 'a' | 'b' = 'a') => fx.headers(site, await fx.session(who, site));
  const call = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);

  it('spec "修改编辑策略": a change is a new version; the previous one stays readable; publishing supersedes', async () => {
    const svc = profiles();
    expect(await svc.current()).toBeNull();
    const v1 = await svc.create(content('Plain and direct'));
    expect(v1).toMatchObject({ version: 1, status: 'draft' });
    await svc.publish(1);
    const v2 = await svc.create(content('Warm and practical'));
    expect(v2).toMatchObject({ version: 2, status: 'draft' });
    expect((await svc.current())?.content.tone).toBe('Plain and direct');
    await svc.publish(2);
    expect(await svc.current()).toMatchObject({ version: 2, status: 'published', content: { tone: 'Warm and practical' } });
    expect(await svc.get(1)).toMatchObject({ version: 1, status: 'superseded', content: { tone: 'Plain and direct' } });
    expect((await svc.list()).map((v) => [v.version, v.status])).toEqual([
      [2, 'published'],
      [1, 'superseded'],
    ]);
    // An earlier version can be put back in effect.
    await svc.publish(1);
    expect((await svc.current())?.version).toBe(1);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.siteId, fx.sites.a), eq(auditLog.event, 'editorial_profile_published')));
    expect(audits.map((a) => (a.metadata as { version: number; previous: number | null }).previous)).toEqual([null, 1, 2]);
  });

  it('content is validated; one version in effect per site; concurrent saves get distinct numbers', async () => {
    const svc = profiles();
    expect(await svc.create({ tone: 'x', unknownField: true }).catch((e: { code?: string }) => e.code)).toBe('VALIDATION');
    const saved = await Promise.all([svc.create(content('a')), svc.create(content('b')), svc.create(content('c'))]);
    expect(saved.map((s) => s.version).sort()).toEqual([1, 2, 3]);
    await svc.publish(1);
    await svc.publish(3);
    const published = await db
      .select()
      .from(editorialProfileVersions)
      .where(and(eq(editorialProfileVersions.siteId, fx.sites.a), eq(editorialProfileVersions.status, 'published')));
    expect(published.map((p) => p.version)).toEqual([3]);
    // The database holds the rule too.
    const second = await db.insert(editorialProfileVersions).values({ siteId: fx.sites.a, version: 9, content: {}, status: 'published' }).catch((e: unknown) => e);
    expect(String((second as { cause?: { code?: string } }).cause?.code ?? (second as { code?: string }).code)).toBe('23505');
  });

  it('spec "追溯文风来源": a run records the version in effect when it starts (none: null)', async () => {
    const runs = new AgentRunService(db, fx.sites.a);
    const before = await runs.ensureRun({ title: 'rewrite' });
    await profiles().create(content('Plain'));
    await profiles().publish(1);
    const after = await runs.ensureRun({ title: 'rewrite again' });
    const rows = await db.select({ id: agentRuns.id, v: agentRuns.editorialProfileVersion }).from(agentRuns).where(eq(agentRuns.siteId, fx.sites.a));
    expect(rows.find((r) => r.id === before.runId)?.v).toBeNull();
    expect(rows.find((r) => r.id === after.runId)?.v).toBe(1);
  });

  it('spec "越权读取": members read the profile in effect; editors save; administrators publish; another site is out of reach', async () => {
    await profiles(fx.sites.b).create(content('Site B voice'));
    await profiles(fx.sites.b).publish(1);
    const editorA = await as('onlyA');
    // Site A's principals asking for site B's profile: refused (spec: 401 for credentials of another site,
    // 403/404 for a principal of the site without membership), and B's profile never in the answer.
    for (const headers of [
      fx.headers('b', fx.apiKeys.aEditor.token),
      { ...editorA, 'x-heopress-site': fx.sites.b },
      fx.headers('b', await fx.session('onlyA', 'b')),
    ]) {
      const res = await call('/api/v1/editorial-profile', 'GET', headers);
      expect([401, 403, 404]).toContain(res.status);
      expect(await res.text()).not.toContain('Site B voice');
    }
    // An editor of A saves; publishing needs an administrator.
    const saved = await call('/api/v1/editorial-profile/versions', 'POST', editorA, { content: content('Site A voice') });
    expect(saved.status, await saved.clone().text()).toBe(201);
    expect((await call('/api/v1/editorial-profile/versions/1/publish', 'POST', editorA)).status).toBe(403);
    const adminA = await as('adminA');
    expect((await call('/api/v1/editorial-profile/versions/1/publish', 'POST', adminA)).status).toBe(200);
    const current = (await (await call('/api/v1/editorial-profile', 'GET', editorA)).json()) as { data: { version: number; content: { tone: string } } };
    expect(current.data).toMatchObject({ version: 1, content: { tone: 'Site A voice' } });
    // A reader of B (no write permission there) cannot save in B.
    const readerB = await as('both', 'b');
    expect((await call('/api/v1/editorial-profile/versions', 'POST', readerB, { content: content('x') })).status).toBe(403);
    expect((await call('/api/v1/editorial-profile', 'GET', readerB)).status).toBe(200);
  });
});
