import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditIssues, auditSites, collections, items, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';
import type { AuditView } from '../services/site-network/site-audit';

/**
 * The audit over HTTP (HeoPress P07 task 5.2; spec seo/site-audit "审计结果的读取与导出"): a member sees the issues of the
 * pages it may read, and of those pages only — in the view and in the export (JSON, CSV); issues about what administrators
 * alone see, to them; nothing of another site; a run asked for by administrators only.
 */

const JWT_SECRET = 'site-audit-secret';

describe.skipIf(!hasDbIntegrationUrl)('site audit — HTTP', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let pageId: string;

  beforeAll(async () => {
    db = await connectDbIntegration('site-audit-http');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'audith', jwtSecret: JWT_SECRET });
    const a = fx.sites.a;
    const article = fx.items.a;
    pageId = await runSiteTransaction(db, a, async (tx) => {
      const [coll] = await tx.insert(collections).values({ siteId: a, name: 'pages', label: 'Pages' }).returning({ id: collections.id });
      const [page] = await tx.insert(items).values({ siteId: a, collectionId: coll!.id, status: 'published', data: { title: 'A page' } }).returning({ id: items.id });
      const ref = (itemId: string, collection: string) => ({ itemId, collection, title: itemId, url: `https://audith-a.example.com/${itemId}/` });
      await tx.insert(auditIssues).values([
        // A value a spreadsheet would run as a formula (the page's address column).
        { siteId: a, rule: 'links/broken', severity: 'error', fingerprint: 'f-article', itemIds: [article], evidence: { pages: [{ ...ref(article, 'articles'), url: '=HYPERLINK("https://example.org")' }], href: '/gone/', reason: 'missing' } },
        { siteId: a, rule: 'links/broken', severity: 'error', fingerprint: 'f-page', itemIds: [page!.id], evidence: { pages: [ref(page!.id, 'pages')], href: '/x/', reason: 'missing' } },
        { siteId: a, rule: 'meta/duplicate-title', severity: 'warning', fingerprint: 'f-dup', itemIds: [article, page!.id], evidence: { value: 'Same', pages: [ref(article, 'articles'), ref(page!.id, 'pages')] } },
        { siteId: a, rule: 'links/broken', severity: 'error', fingerprint: 'f-nav', itemIds: [], adminOnly: true, evidence: { navigation: { linkId: 'n1', label: 'Footer' }, href: '/gone/' } },
      ]);
      return page!.id;
    });
    await db.insert(auditSites).values({ siteId: a, lastRunAt: new Date(), status: 'done', issues: 4 });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const call = (path: string, method: string, headers: Record<string, string>) => app.request(path, { method, headers }, env);
  const viewAs = async (headers: Record<string, string>) => {
    const res = await call('/api/v1/site/audit', 'GET', headers);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { data: AuditView }).data;
  };

  it('a member sees the issues of the pages it may read, and of those pages only; administrators all', async () => {
    const admin = await viewAs(fx.headers('a', await fx.session('adminA', 'a')));
    expect(admin.total).toBe(4);
    expect(admin.issues[0]!.severity).toBe('error');
    const editor = await viewAs(fx.headers('a', await fx.session('onlyA', 'a')));
    expect(editor.total).toBe(2);
    expect(editor.issues.map((i) => i.rule).sort()).toEqual(['links/broken', 'meta/duplicate-title']);
    // The duplicate is shown with the page it may read only.
    expect(editor.issues.find((i) => i.rule === 'meta/duplicate-title')!.pages.map((p) => p.itemId)).toEqual([fx.items.a]);
    expect(JSON.stringify(editor)).not.toContain(pageId);
    expect(JSON.stringify(editor)).not.toContain('Footer');
    expect(editor.run.lastRunAt).not.toBeNull();
  });

  it('the export holds the same, as JSON or CSV (a formula is text); another site nothing; a run is for administrators', async () => {
    const editor = fx.headers('a', await fx.session('onlyA', 'a'));
    const json = await call('/api/v1/site/audit/export', 'GET', editor);
    expect(json.status).toBe(200);
    expect(json.headers.get('content-disposition')).toContain('attachment');
    const body = (await json.json()) as { version: number; siteId: string; issues: Array<{ rule: string }> };
    expect(body.version).toBe(1);
    expect(body.siteId).toBe(fx.sites.a);
    expect(body.issues).toHaveLength(2);
    expect(JSON.stringify(body)).not.toContain(pageId);
    const csv = await call('/api/v1/site/audit/export?format=csv', 'GET', editor);
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    const text = await csv.text();
    // The triage state of each issue is part of the export (HeoPress P07a task 10.4): nothing is ignored here.
    expect(text.split('\r\n')[0]).toBe('rule,severity,title,item_id,url,evidence,state');
    expect(text.split('\r\n').slice(1).filter(Boolean).every((line) => line.endsWith(',open'))).toBe(true);
    expect(text).not.toContain(pageId);
    // No cell begins with `=` (a spreadsheet formula).
    expect(text).toContain('"\'=HYPERLINK(""https://example.org"")"');
    expect(text).not.toMatch(/(^|,)"?=/m);
    // Site B's administrator: its own (empty) list; site A's header with B's session: refused.
    const b = await viewAs(fx.headers('b', await fx.session('adminB', 'b')));
    expect(b.total).toBe(0);
    const foreign = await call('/api/v1/site/audit/export', 'GET', fx.headers('a', await fx.session('adminB', 'b')));
    expect([401, 403, 404]).toContain(foreign.status);
    expect(await foreign.text()).not.toMatch(/"data"|rule,|^[a-z_]+,/m);
    // A run: administrators only.
    expect((await call('/api/v1/site/audit/run', 'POST', editor)).status).toBe(403);
    expect((await call('/api/v1/site/audit/run', 'POST', fx.headers('a', await fx.session('adminA', 'a')))).status).toBe(202);
    expect((await db.select().from(auditSites).where(eq(auditSites.siteId, fx.sites.a)))[0]?.requestedAt).not.toBeNull();
  });

  it('spec "无权限站点": with an issue on site B too, nothing of B reaches site A\'s view or export — whoever asks, a member of both included', async () => {
    const b = fx.sites.b;
    await runSiteTransaction(db, b, (tx) =>
      tx.insert(auditIssues).values({
        siteId: b, rule: 'meta/duplicate-title', severity: 'warning', fingerprint: 'f-b-only', itemIds: [fx.items.b],
        evidence: { value: 'B only', pages: [{ itemId: fx.items.b, collection: 'articles', title: 'B only', url: 'https://audith-b.example.com/b-only/' }] },
      }),
    );
    // B's own administrator sees it: the issue is there to leak.
    expect((await viewAs(fx.headers('b', await fx.session('adminB', 'b')))).total).toBe(1);
    for (const user of ['onlyA', 'adminA', 'both'] as const) {
      const headers = fx.headers('a', await fx.session(user, 'a'));
      const view = JSON.stringify(await viewAs(headers));
      const json = await call('/api/v1/site/audit/export', 'GET', headers);
      expect(json.status, user).toBe(200);
      const csv = await call('/api/v1/site/audit/export?format=csv', 'GET', headers);
      expect(csv.status, user).toBe(200);
      for (const text of [view, await json.text(), await csv.text()]) {
        expect(text, user).not.toContain('audith-b.example.com');
        expect(text, user).not.toContain('B only');
        expect(text, user).not.toContain(fx.items.b);
      }
    }
  });
});
