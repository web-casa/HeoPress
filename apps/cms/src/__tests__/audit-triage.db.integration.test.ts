import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { auditIssueResolutions, auditIssueStates, auditIssues, auditLog, collections, items, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { runSiteTransaction } from '../services/rls-transaction';
import { purgeAuditTriage, runSiteAudit, type AuditFinding } from '../services/site-network/site-audit';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/** Audit triage (HeoPress P07a tasks 10.1–10.3; spec seo/audit-triage). */

const JWT_SECRET = 'audit-triage-secret';

describe.skipIf(!hasDbIntegrationUrl)('audit triage', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let pageIds: string[] = [];
  let hiddenIds: string[] = [];

  beforeAll(async () => {
    db = await connectDbIntegration('audit-triage');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'audtri', jwtSecret: JWT_SECRET });
    const site = fx.sites.a;
    const [articles] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, site), eq(collections.name, SHARED.collection)));
    const [locked] = await db.insert(collections).values({ siteId: site, name: 'locked', label: 'Locked' }).returning({ id: collections.id });
    pageIds = (await db.insert(items).values(Array.from({ length: 2 }, (_, i) => ({ siteId: site, collectionId: articles!.id, status: 'published', data: { title: `Page ${i}` } }))).returning({ id: items.id })).map((r) => r.id);
    hiddenIds = (await db.insert(items).values(Array.from({ length: 20 }, (_, i) => ({ siteId: site, collectionId: locked!.id, status: 'published', data: { title: `Locked ${i}` } }))).returning({ id: items.id })).map((r) => r.id);
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const site = () => fx.sites.a;
  const page = (itemId: string, title: string) => ({ itemId, collection: 'x', title, url: `https://a.example.com/${title.replace(/\s/g, '-')}/` });
  const finding = (fingerprint: string, ids: string[], extra: Partial<AuditFinding> = {}): AuditFinding => ({
    rule: 'links/broken',
    fingerprint,
    itemIds: ids,
    evidence: { pages: ids.map((id, i) => page(id, `P${i}`)) },
    ...extra,
  });
  const run = (found: AuditFinding[], truncated = false) => runSiteAudit(db, site(), { findings: { found, truncated } });
  const issueId = async (fingerprint: string) =>
    (await runSiteTransaction(db, site(), (tx) => tx.select({ id: auditIssues.id }).from(auditIssues).where(and(eq(auditIssues.siteId, site()), eq(auditIssues.fingerprint, fingerprint)))))[0]?.id;
  const call = async (who: 'adminA' | 'onlyA', method: string, path: string, body?: unknown) =>
    app.request(`/api/v1/site${path}`, { method, headers: fx.headers('a', await fx.session(who, 'a')), body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const ignore = async (fp: string, body: unknown = {}) => call('adminA', 'POST', `/audit/issues/${await issueId(fp)}/ignore`, body);
  type View = { data: { issues: Array<{ id: string; state: { status: string } }>; total: number } };
  const view = async (who: 'adminA' | 'onlyA', status = '') => ((await (await call(who, 'GET', `/audit${status ? `?status=${status}` : ''}`)).json()) as View).data;
  type Resolved = { data: { issues: Array<{ fingerprint?: string; pages: Array<{ itemId: string }> }>; total: number } };
  const resolved = async (who: 'adminA' | 'onlyA') => ((await (await call(who, 'GET', '/audit/resolved')).json()) as Resolved).data;
  const resolutionRows = () => runSiteTransaction(db, site(), (tx) => tx.select().from(auditIssueResolutions).where(eq(auditIssueResolutions.siteId, site())));

  it('authors and API keys cannot ignore; an administrator can, once per multi-page issue, and it is audited', async () => {
    await run([finding('links/broken:multi/page', pageIds)]);
    const id = await issueId('links/broken:multi/page');
    expect((await call('onlyA', 'POST', `/audit/issues/${id}/ignore`, {})).status).toBe(403);
    const key = await app.request(`/api/v1/site/audit/issues/${id}/ignore`, { method: 'POST', headers: fx.headers('a', fx.apiKeys.aEditor.token), body: '{}' }, env);
    expect(key.status).toBe(403);
    // A fingerprint with "/" is addressed by the row id.
    expect((await ignore('links/broken:multi/page', { reason: 'known', days: 30 })).status).toBe(200);
    const states = await runSiteTransaction(db, site(), (tx) => tx.select().from(auditIssueStates).where(eq(auditIssueStates.siteId, site())));
    expect(states).toHaveLength(1);
    expect((await view('adminA', 'ignored')).total).toBe(1);
    expect((await view('adminA', 'open')).total).toBe(0);
    const logged = await runSiteTransaction(db, site(), (tx) => tx.select({ event: auditLog.event }).from(auditLog).where(and(eq(auditLog.siteId, site()), sql`${auditLog.event} LIKE 'audit_issue_%'`)));
    expect(logged.map((l) => l.event)).toContain('audit_issue_ignored');
    expect((await call('adminA', 'DELETE', `/audit/issues/${id}/ignore`)).status).toBe(200);
    expect((await view('adminA', 'open')).total).toBe(1);
  });

  it('an ignore past its time is open again; a re-run keeps an ignore in force', async () => {
    await run([finding('links/broken:a', [pageIds[0]!])]);
    await ignore('links/broken:a');
    await run([finding('links/broken:a', [pageIds[0]!])]);
    expect((await view('adminA', 'ignored')).total).toBe(1);
    await runSiteTransaction(db, site(), (tx) => tx.update(auditIssueStates).set({ until: new Date(Date.now() - 1000) }).where(eq(auditIssueStates.siteId, site())));
    expect((await view('adminA', 'open')).total).toBe(1);
    expect((await view('adminA', 'ignored')).total).toBe(0);
  });

  it('fixed: resolved; ignored → resolved → back again is open; recurring leaves two records', async () => {
    await run([finding('links/broken:a', [pageIds[0]!])]);
    await ignore('links/broken:a');
    await run([]);
    expect(await issueId('links/broken:a')).toBeUndefined();
    expect(await resolutionRows()).toHaveLength(1);
    expect(await runSiteTransaction(db, site(), (tx) => tx.select().from(auditIssueStates).where(eq(auditIssueStates.siteId, site())))).toHaveLength(0);
    await run([finding('links/broken:a', [pageIds[0]!])]);
    expect((await view('adminA', 'open')).total).toBe(1);
    await run([]);
    expect(await resolutionRows()).toHaveLength(2);
  });

  it('a truncated run removes nothing: no resolution, the ignore kept, the first sighting unchanged', async () => {
    await run([finding('links/broken:a', [pageIds[0]!]), finding('links/broken:b', [pageIds[1]!])]);
    const before = await runSiteTransaction(db, site(), (tx) => tx.select().from(auditIssues).where(eq(auditIssues.siteId, site())));
    await ignore('links/broken:b');
    await run([finding('links/broken:a', [pageIds[0]!])], true);
    const after = await runSiteTransaction(db, site(), (tx) => tx.select().from(auditIssues).where(eq(auditIssues.siteId, site())));
    expect(after.map((a) => a.fingerprint).sort()).toEqual(['links/broken:a', 'links/broken:b']);
    expect(after.find((a) => a.fingerprint === 'links/broken:b')!.firstSeenAt.toISOString()).toBe(before.find((b) => b.fingerprint === 'links/broken:b')!.firstSeenAt.toISOString());
    expect(await resolutionRows()).toHaveLength(0);
    expect((await view('adminA', 'ignored')).total).toBe(1);
  });

  it('resolved records follow visibility: readable pages only; admin-only ones for administrators; the 21st page counts', async () => {
    await run([
      finding('links/broken:mixed', [pageIds[0]!, hiddenIds[0]!]),
      finding('links/broken:hidden', [hiddenIds[1]!]),
      finding('links/broken:admin', [], { adminOnly: true, evidence: { pages: [] } }),
      finding('links/broken:twentyfirst', [...hiddenIds.slice(0, 20), pageIds[1]!]),
    ]);
    await run([]);
    const member = await resolved('onlyA');
    expect(member.total).toBe(2);
    const pagesSeen = member.issues.flatMap((i) => i.pages.map((p) => p.itemId));
    expect(pagesSeen.sort()).toEqual([pageIds[0]!, pageIds[1]!].sort());
    expect(JSON.stringify(member)).not.toContain('Locked');
    expect((await resolved('adminA')).total).toBe(4);
  });

  it('the export carries each issue\'s state', async () => {
    await run([finding('links/broken:a', [pageIds[0]!])]);
    await ignore('links/broken:a');
    const res = await call('adminA', 'GET', '/audit/export?format=csv');
    expect(await res.text()).toContain(',ignored');
  });

  it('task 10.3: resolutions older than 90 days and lapsed ignores are purged', async () => {
    await run([finding('links/broken:a', [pageIds[0]!]), finding('links/broken:b', [pageIds[1]!])]);
    await ignore('links/broken:b');
    await run([finding('links/broken:b', [pageIds[1]!])]);
    await runSiteTransaction(db, site(), async (tx) => {
      await tx.update(auditIssueResolutions).set({ resolvedAt: new Date(Date.now() - 91 * 86_400_000) }).where(eq(auditIssueResolutions.siteId, site()));
      await tx.update(auditIssueStates).set({ until: new Date(Date.now() - 1000) }).where(eq(auditIssueStates.siteId, site()));
    });
    const purged = await purgeAuditTriage(db);
    expect(purged.resolutions).toBeGreaterThanOrEqual(1);
    expect(purged.states).toBeGreaterThanOrEqual(1);
    expect(await resolutionRows()).toHaveLength(0);
  });
});
