import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { linkEdges, linkScans, publicItems, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';
import type { LinkReport } from '../services/site-network/link-report';

/**
 * The link reports over HTTP (HeoPress P07 task 5.4; spec seo/site-audit "审计结果的读取与导出"): a member sees the broken
 * links and orphans of the items it may read only — an editor of articles nothing of pages; another site's administrator
 * nothing of this site; a scan and the registered links are for administrators.
 */

const JWT_SECRET = 'link-report-secret';

describe.skipIf(!hasDbIntegrationUrl)('link reports — HTTP', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('link-report-http');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'linkr', jwtSecret: JWT_SECRET });
    // Public rows and their links as the projection and the graph hold them: an article and a page, each linking nowhere.
    const host = 'linkr-a.example.com';
    await runSiteTransaction(db, fx.sites.a, async (tx) => {
      for (const [id, collection] of [
        ['linkr_article', 'articles'],
        ['linkr_page', 'pages'],
      ] as const) {
        await tx.insert(publicItems).values({
          itemId: id,
          siteId: fx.sites.a,
          collection,
          locale: 'en',
          path: `/${id}`,
          data: { title: id },
          card: { url: `https://${host}/${id}/` },
          updatedAt: new Date(),
          sanitizer: 1,
        });
        await tx.insert(linkEdges).values({
          siteId: fx.sites.a,
          origin: 'auto',
          sourceItemId: id,
          field: 'body',
          href: '/missing/',
          targetUrl: `https://${host}/missing/`,
          targetLocale: 'en',
          targetPath: '/missing',
        });
      }
    });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const call = (path: string, method: string, headers: Record<string, string>, body?: unknown) =>
    app.request(path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env);
  const reportAs = async (headers: Record<string, string>) => {
    const res = await call('/api/v1/site/links/report', 'GET', headers);
    expect(res.status, await res.clone().text()).toBe(200);
    return ((await res.json()) as { data: LinkReport }).data;
  };

  it('a member sees only what it may read; another site sees nothing of it', async () => {
    const admin = await reportAs(fx.headers('a', await fx.session('adminA', 'a')));
    expect(admin.broken.map((b) => (b.source.kind === 'item' ? b.source.itemId : b.source.label)).sort()).toEqual(['linkr_article', 'linkr_page']);
    expect(admin.orphans.map((o) => o.itemId).sort()).toEqual(['linkr_article', 'linkr_page']);
    // An editor of articles only: nothing of the page, not even in the totals.
    const editor = await reportAs(fx.headers('a', await fx.session('onlyA', 'a')));
    expect(editor.broken.map((b) => (b.source.kind === 'item' ? b.source.itemId : b.source.label))).toEqual(['linkr_article']);
    expect(editor.brokenTotal).toBe(1);
    expect(editor.orphans.map((o) => o.itemId)).toEqual(['linkr_article']);
    expect(JSON.stringify(editor)).not.toContain('linkr_page');
    // Site B's administrator: its own (empty) report; site A's header with B's session is refused.
    const b = await reportAs(fx.headers('b', await fx.session('adminB', 'b')));
    expect(b.broken).toEqual([]);
    expect(JSON.stringify(b)).not.toContain('linkr_');
    expect((await call('/api/v1/site/links/report', 'GET', fx.headers('a', await fx.session('adminB', 'b')))).status).toBeGreaterThanOrEqual(401);
  });

  it('scans and registered links: administrators only', async () => {
    const editor = fx.headers('a', await fx.session('onlyA', 'a'));
    const admin = fx.headers('a', await fx.session('adminA', 'a'));
    expect((await call('/api/v1/site/links/scan', 'POST', editor)).status).toBe(403);
    expect((await call('/api/v1/site/links/manual', 'GET', editor)).status).toBe(403);
    expect((await call('/api/v1/site/links/manual', 'POST', editor, { label: 'Menu', url: 'https://linkr-a.example.com/' })).status).toBe(403);
    const scan = await call('/api/v1/site/links/scan', 'POST', admin);
    expect(scan.status).toBe(200);
    expect(((await scan.json()) as { data: { status: string } }).data.status).toBe('running');
    expect((await db.select().from(linkScans).where(eq(linkScans.siteId, fx.sites.b))).length).toBe(0);
    // Not on the site's domains (it has none here): refused with its reason.
    const bad = await call('/api/v1/site/links/manual', 'POST', admin, { label: 'Menu', url: 'https://example.org/' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('NOT_ON_SITE');
    expect((await call('/api/v1/site/links/manual/nope', 'DELETE', admin)).status).toBe(404);
  });
});
