import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { auditLog, cdcChangeEvents, redirects, siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import type { AppEnv } from '../env';
import { redirectsRouter } from '../routes/redirects';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { resolvePublicPath } from '../services/site-network/public-path';
import { dryRunRedirectImport, importRedirects, type ImportOptions } from '../services/site-network/redirect-import';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Importing redirects (HeoPress P05 tasks 1.7, 1.8; spec
 * content/site-network-model "批量导入重定向" and its scenarios; design B,
 * R34–R36): the dry run's report, loops and unprovable rules never take
 * effect, chains end in one 301, live paths are left alone by default,
 * WordPress exports, and the report hash that binds an import to its dry run.
 */

const SITE = 'site_p05_redirect_import_it';
const MAIN = 'ri-main.example.com';
const actor = { userId: null, email: 'admin@example.com' };

describe.skipIf(!hasDbIntegrationUrl)('redirect import — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('redirect-import');
  });
  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Redirect import', defaultLanguage: 'en' });
    await upgradeSitePreset(db, SITE);
    await db.insert(siteDomains).values({ siteId: SITE, hostname: MAIN, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() });
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, SITE));
    await new ContentSettingsService({ db, siteId: SITE, actor: { userId: null } }).update({
      availableLocales: ['en'],
      timezone: 'UTC',
      siteType: 'blog',
      trailingSlash: 'always',
      localeStrategy: 'subdirectory',
      localePrefixMode: 'default_at_root',
      localePrefixes: {},
      permalinks: { ...r!.permalinks, pages: '/:slug' },
      allowCrossSiteTranslations: false,
      sponsorDisclosure: true,
      sponsorRel: true,
      version: r!.version,
    } as never);
  });
  afterAll(async () => {
    await db?.delete(sites).where(eq(sites.id, SITE));
  });

  const dry = (content: string, opts: ImportOptions = {}) => dryRunRedirectImport(db, SITE, content, opts);
  /** Dry run, then import with its hash. */
  const run = async (content: string, opts: ImportOptions = {}) => {
    const report = await dry(content, opts);
    return importRedirects(db, SITE, content, { ...opts, reportHash: report.reportHash, actor });
  };
  const stored = async () =>
    (await db.select().from(redirects).where(eq(redirects.siteId, SITE))).map((r) => `${r.fromPath} ${r.match} ${r.toPath}`).sort();
  const resolve = (path: string) => resolvePublicPath(db, { host: MAIN, path });

  it('spec "预演发现循环": /a → /b and /b → /a — the report marks the loop, neither is imported', async () => {
    const report = await dry('/a,/b\n/b,/a\n');
    expect(report.loops.map((l) => l.from).sort()).toEqual(['/a', '/b']);
    expect(report.import).toEqual([]);
    await run('/a,/b\n/b,/a\n');
    expect(await stored()).toEqual([]);
  });

  it('spec "前缀规则互相指向": prefix /a → /b and /b → /a are a loop, neither imported', async () => {
    const report = await dry('/a,/b,prefix\n/b,/a,prefix\n');
    expect(report.summary).toMatchObject({ loops: 2, import: 0 });
  });

  it('spec "去掉旧站目录前缀": /blog → / (prefix) and /foo → /bar are imported; /blog/foo is one 301 to /bar', async () => {
    const { report } = await run('/blog,/,prefix\n/foo,/bar\n');
    expect(report.summary).toMatchObject({ import: 2, loops: 0, manual: 0 });
    expect(await stored()).toEqual(['/blog prefix /', '/foo exact /bar']);
    expect(await resolve('/blog/foo')).toEqual({ kind: 'redirect', status: 301, siteId: SITE, location: `https://${MAIN}/bar/` });
  });

  it('spec "剔除规则后重新校验": /a → /b, /b → /b (exact) and /b → /a (prefix) — none takes effect', async () => {
    const report = await dry('/a,/b\n/b,/b\n/b,/a,prefix\n');
    expect(report.import).toEqual([]);
    expect(report.loops.map((l) => l.line).sort()).toEqual([1, 2, 3]);
    await run('/a,/b\n/b,/b\n/b,/a,prefix\n');
    expect(await stored()).toEqual([]);
  });

  it('spec "压平重定向链": with /old → /mid stored, importing /mid → /new — /old and /mid both one 301 to /new', async () => {
    await run('/old,/mid\n');
    const report = await dry('/mid,/new\n');
    expect(report.flattenedStored).toEqual([{ from: '/old', to: '/mid', match: 'exact', before: '/mid', final: '/new' }]);
    await run('/mid,/new\n');
    expect(await resolve('/old/')).toMatchObject({ kind: 'redirect', location: `https://${MAIN}/new/` });
    expect(await resolve('/mid/')).toMatchObject({ kind: 'redirect', location: `https://${MAIN}/new/` });
    // An imported rule whose own target is redirected further is reported too.
    expect((await dry('/older,/old\n')).flattened).toEqual([{ line: 1, from: '/older', to: '/old', match: 'exact', final: '/new' }]);
  });

  it('a source a published item answers at is a conflict, not imported by default; asked for, it is stored and the item still wins', async () => {
    const page = (await new ItemService({ db, siteId: SITE }).create('pages', { data: { title: 'About', slug: 'about', locale: 'en' }, status: 'published' })) as { id: string };
    const report = await dry('/about,/team\n');
    expect(report.conflicts).toEqual([{ line: 1, from: '/about', to: '/team', match: 'exact', itemId: page.id, collection: 'pages', address: 'en:/about', items: 1 }]);
    expect(report.import).toEqual([]);
    await run('/about,/team\n');
    expect(await stored()).toEqual([]);
    await run('/about,/team\n', { importConflicting: true });
    expect(await stored()).toEqual(['/about exact /team']);
    expect(await resolve('/about/')).toMatchObject({ kind: 'item', itemId: page.id });
  });

  it('conflicts are found on every host and under a prefix: a language entry domain\'s item, and items a prefix source covers', async () => {
    await db.update(siteContentSettings).set({ availableLocales: ['en', 'zh-CN'] }).where(eq(siteContentSettings.siteId, SITE));
    await db.insert(siteDomains).values({ siteId: SITE, hostname: 'zh.ri-main.example.com', kind: 'custom', status: 'active', entryLocale: 'zh-CN', verifiedAt: new Date() });
    const zh = (await new ItemService({ db, siteId: SITE }).create('pages', { data: { title: '关于', slug: 'guanyu', locale: 'zh-CN' }, status: 'published' })) as { id: string };
    const post = (await new ItemService({ db, siteId: SITE }).create('pages', { data: { title: 'Post', slug: 'post', locale: 'en' }, status: 'published' })) as { id: string };
    await db.update(siteContentSettings).set({ permalinks: { pages: '/blog/:slug' } }).where(eq(siteContentSettings.siteId, SITE));
    // (Routes as they were written: /guanyu in Chinese, /post in English.)
    const report = await dry('/guanyu,/x\n/,/home,prefix\n/elsewhere,/y\n');
    expect(report.conflicts.map((c) => [c.from, c.itemId])).toEqual([
      ['/guanyu', zh.id],
      ['/', expect.any(String)],
    ]);
    expect(report.conflicts[1]!.items).toBe(2);
    expect(report.import.map((r) => r.from)).toEqual(['/elsewhere']);
    void post;
  });

  it('a refused replacement gives the stored rule back, and the plan is what the import writes', async () => {
    await run('/a,/b\n');
    // /a → /a loops; with /a → /b back, /b → /a loops too: both refused, and the import goes through.
    const report = await dry('/a,/a\n/b,/a\n');
    expect(report.loops.map((l) => l.line).sort()).toEqual([1, 2]);
    expect(report.summary).toMatchObject({ import: 0, replaced: 0 });
    await run('/a,/a\n/b,/a\n');
    expect(await stored()).toEqual(['/a exact /b']);
  });

  it('where things end is answered as the public resolver does: a published item ends it; chains of stored rules are followed', async () => {
    await run('/mid,/new\n');
    await new ItemService({ db, siteId: SITE }).create('pages', { data: { title: 'Mid', slug: 'mid', locale: 'en' }, status: 'published' });
    // /mid answers itself (a live item): /old → /mid ends there.
    expect((await dry('/old,/mid\n')).flattened).toEqual([]);
    await run('/p,/q\n/q,/r\n');
    const report = await dry('/r,/s\n');
    expect(report.flattenedStored.map((f) => `${f.from}: ${f.before} → ${f.final}`).sort()).toEqual(['/p: /r → /s', '/q: /r → /s']);
  });

  it('the hash covers the file, the options and the published items', async () => {
    const a = await dry('/old,/mid\n');
    expect((await dry('/old/,/mid/\n')).reportHash).not.toBe(a.reportHash);
    expect((await dry('/old,/mid\n', { importConflicting: true })).reportHash).not.toBe(a.reportHash);
    await new ItemService({ db, siteId: SITE }).create('pages', { data: { title: 'Mid', slug: 'mid', locale: 'en' }, status: 'published' });
    expect(await importRedirects(db, SITE, '/old,/mid\n', { reportHash: a.reportHash, actor }).catch((e: { code?: string }) => e.code)).toBe('REPORT_STALE');
  });

  it('a long chain (2,000 rules) is planned without walking it again and again', async () => {
    const file = Array.from({ length: 2000 }, (_, i) => `/c${i},/c${i + 1}`).join('\n');
    const started = Date.now();
    const report = await dry(file);
    expect(report.summary.import).toBe(2000);
    expect(report.flattened).toHaveLength(1999);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('ends are reported per domain: a target live on a language entry domain ends there, elsewhere it goes on', async () => {
    await db.update(siteContentSettings).set({ availableLocales: ['en', 'zh-CN'] }).where(eq(siteContentSettings.siteId, SITE));
    await db.insert(siteDomains).values({ siteId: SITE, hostname: 'zh.ri-main.example.com', kind: 'custom', status: 'active', entryLocale: 'zh-CN', verifiedAt: new Date() });
    await new ItemService({ db, siteId: SITE }).create('pages', { data: { title: '中', slug: 'mid', locale: 'zh-CN' }, status: 'published' });
    // /mid is live on the Chinese domain: storing /mid → /new is asked for explicitly.
    await run('/mid,/new\n', { importConflicting: true });
    const report = await dry('/old,/mid\n');
    expect(report.flattened).toEqual([expect.objectContaining({ from: '/old', final: '/new', elsewhere: [{ host: 'zh.ri-main.example.com', final: '//zh.ri-main.example.com/mid' }] })]);
  });

  it('the hash covers the default language (it decides which item answers at a path)', async () => {
    const report = await dry('/old,/mid\n');
    await db.update(siteContentSettings).set({ availableLocales: ['en', 'fr'] }).where(eq(siteContentSettings.siteId, SITE));
    await new ContentSettingsService({ db, siteId: SITE, actor: { userId: null } }).updateSite({ defaultLanguage: 'fr' });
    expect(await importRedirects(db, SITE, '/old,/mid\n', { reportHash: report.reportHash, actor }).catch((e: { code?: string }) => e.code)).toBe('REPORT_STALE');
  });

  it('a rule set too densely linked to check within bounds is refused, not checked at any cost', async () => {
    const file = Array.from({ length: 3000 }, (_, i) => `/s${i},/,prefix`).join('\n');
    const started = Date.now();
    expect(await dry(file).catch((e: { code?: string; status?: number }) => [e.code, e.status])).toEqual(['TOO_COMPLEX', 413]);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('spec "WordPress 导出中的正则规则" (task 1.8): plain and simple regex rules import; other regex rules are listed with their text', async () => {
    const json = JSON.stringify({
      redirects: [
        { url: '/hello-world/', match_type: 'url', action_code: 301, action_data: { url: '/hello/' }, regex: false },
        { url: '^/blog/(.*)$', match_type: 'url', action_code: 301, action_data: { url: '/news/$1' }, regex: true },
        { url: '^/p/(\\d+)$', match_type: 'url', action_code: 301, action_data: { url: '/posts/$1' }, regex: true },
      ],
    });
    const { report } = await run(json);
    expect(report.format).toBe('redirection');
    expect(report.import.map((r) => `${r.from} ${r.match} ${r.to}`)).toEqual(['/hello-world exact /hello', '/blog prefix /news']);
    expect(report.manual).toEqual([expect.objectContaining({ line: 3, original: expect.stringContaining('^/p/(\\\\d+)$') })]);
    expect(await resolve('/blog/2019/post')).toMatchObject({ kind: 'redirect', location: `https://${MAIN}/news/2019/post/` });
  });

  it('a rule that cannot be shown to end (a prefix into its own subtree) is for a person; the rest of the file imports', async () => {
    const report = await dry('/g,/g/h,prefix\n/ok,/fine\n');
    expect(report.manual).toEqual([{ line: 1, from: '/g', to: '/g/h', match: 'prefix', reason: 'cannot be shown to end (it would keep redirecting)' }]);
    await run('/g,/g/h,prefix\n/ok,/fine\n');
    expect(await stored()).toEqual(['/ok exact /fine']);
  });

  it('a stored rule from the same source is replaced; the same rule again is unchanged', async () => {
    await run('/x,/one\n');
    const report = await dry('/x,/two\n/y,/z\n');
    expect(report.replaced).toEqual([{ line: 1, from: '/x', to: '/two', match: 'exact', previousTo: '/one' }]);
    await run('/x,/two\n/y,/z\n');
    expect(await stored()).toEqual(['/x exact /two', '/y exact /z']);
    expect((await dry('/x,/two\n')).summary).toMatchObject({ unchanged: 1, import: 0, replaced: 0 });
  });

  it('a rule that would loop with stored rules is not imported, and the stored rules stay', async () => {
    await run('/p,/q\n');
    const report = await dry('/q,/p\n');
    expect(report.loops).toEqual([{ line: 1, from: '/q', to: '/p', match: 'exact' }]);
    await run('/q,/p\n');
    expect(await stored()).toEqual(['/p exact /q']);
  });

  it('the report hash binds the import to its dry run: a change since is a 409; the import is audited with its id', async () => {
    const report = await dry('/m,/n\n');
    // The site changes after the dry run (another rule).
    await run('/other,/place\n');
    const stale = await importRedirects(db, SITE, '/m,/n\n', { reportHash: report.reportHash, actor }).catch((e: unknown) => e);
    expect(stale).toMatchObject({ code: 'REPORT_STALE', status: 409 });
    // Importing the same report twice: the second sees its own rules — stale.
    const fresh = await dry('/m,/n\n');
    const done = await importRedirects(db, SITE, '/m,/n\n', { reportHash: fresh.reportHash, actor });
    expect(await importRedirects(db, SITE, '/m,/n\n', { reportHash: fresh.reportHash, actor }).catch((e: { code?: string }) => e.code)).toBe('REPORT_STALE');
    const [row] = await db.select().from(redirects).where(and(eq(redirects.siteId, SITE), eq(redirects.fromPath, '/m')));
    expect(row).toMatchObject({ source: 'import', importId: done.importId, scope: 'url' });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'redirects_imported')));
    expect(audits.map((a) => (a.metadata as { importId: string }).importId)).toContain(done.importId);
    const events = await db.select().from(cdcChangeEvents).where(and(eq(cdcChangeEvents.siteId, SITE), eq(cdcChangeEvents.resource, 'redirect')));
    expect(events.map((e) => e.itemId)).toContain(done.importId);
  });

  describe('HTTP: POST /api/v1/redirects/import', () => {
    const api = () => {
      const app = new Hono<AppEnv>();
      app.use('*', async (c, next) => {
        c.set('db', db);
        c.set('siteId', SITE);
        c.set('auth', { type: 'user', raw: { dev: true }, roles: ['admin'] } as never);
        await next();
      });
      app.route('/api/v1/redirects', redirectsRouter);
      return app;
    };
    const post = (query: string, body: unknown) =>
      api().request(`/api/v1/redirects/import${query}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

    it('dry run, then import with the hash; no hash is refused; an unreadable file is a 400', async () => {
      const content = 'Origin,Target,Type,Format\nold,new,301,plain\n';
      const dryRes = await post('?dryRun=1', { content });
      expect(dryRes.status).toBe(200);
      const { data } = (await dryRes.json()) as { data: { reportHash: string; format: string } };
      expect(data.format).toBe('yoast');
      expect((await post('', { content })).status).toBe(428);
      const res = await post('', { content, reportHash: data.reportHash });
      expect(res.status).toBe(201);
      expect(await stored()).toEqual(['/old exact /new']);
      expect((await post('?dryRun=1', { content: '{"redirects": [', format: 'redirection' })).status).toBe(400);
    });

    it('the body is read up to the request limit by the bytes received (no Content-Length needed)', async () => {
      const prev = process.env.HEOPRESS_MAX_JSON_BODY;
      process.env.HEOPRESS_MAX_JSON_BODY = '200';
      try {
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode(JSON.stringify({ content: '/a,/b\n'.repeat(100) })));
            c.close();
          },
        });
        const res = await api().request('/api/v1/redirects/import?dryRun=1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
        expect(res.status).toBe(413);
        expect(await res.json()).toMatchObject({ errors: [{ code: 'PAYLOAD_TOO_LARGE' }] });
      } finally {
        if (prev === undefined) delete process.env.HEOPRESS_MAX_JSON_BODY;
        else process.env.HEOPRESS_MAX_JSON_BODY = prev;
      }
    });
  });
});
