import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import {
  ensureRenderRole,
  permissions,
  policies,
  previewLinks,
  renderCache,
  rolePolicies,
  roles,
  schema,
  siteContentSettings,
  siteDomains,
  sites,
  userSites,
  users,
  type Database,
} from '@heopress/database';
import { BUILTIN_THEME, THEME_CHECKS_VERSION } from '@heopress/public-site';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import type { AppEnv } from '../env';
import { internalPreviewRouter } from '../routes/internal-preview';
import { ItemService } from '../services/item-service';
import { runSiteTransaction } from '../services/rls-transaction';
import { PreviewService, PreviewServiceError } from '../services/rendering/preview-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { SiteIdentityService } from '../services/site-network/site-identity-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { ThemeService } from '../services/themes/theme-service';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Error isolation and previews (HeoPress P06 tasks 4.1–4.3, 7.2; spec rendering/classic-engine
 * "站点之间的错误隔离", rendering/preview): a theme failing on one site leaves the other site served and
 * shows no internals; preview links exchanged on the preview origin, checked by the CMS on every request
 * (expiry, revocation, the site, the creator's current permission), never cached, never on a public host.
 *
 * Needs DATABASE_OWNER_URL (to provision the rendering role).
 */

const A = 'site_p06_preview_a';
const B = 'site_p06_preview_b';
const HOST_A = 'pv-a.example.com';
const HOST_B = 'pv-b.example.com';
const PREVIEW = 'preview.pv.example.com';
const ORIGIN = `https://${PREVIEW}`;
const SECRET = randomBytes(24).toString('hex');
const EDITOR = 'usr_p06_preview_editor';
const ADMIN = 'usr_p06_preview_admin';
const RENDER_ROLE = 'heopress_render_it';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;

const PREVIEW_HEADERS = {
  'cache-control': 'no-store, private',
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'no-referrer',
};

describe.skipIf(!hasDbIntegrationUrl)('error isolation and previews — DB integration', () => {
  let db: Database;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let service: SiteClassic;
  let cms: Hono<AppEnv>;
  const savedSecret = process.env.HEOPRESS_INTERNAL_SECRET;

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    process.env.HEOPRESS_INTERNAL_SECRET = SECRET;
    db = await connectDbIntegration('preview');
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderClient = postgres(url.toString(), { max: 2, onnotice: () => {} });
    // The CMS's internal preview endpoint, as the rendering service reaches it.
    cms = new Hono<AppEnv>();
    cms.use('*', async (c, next) => {
      c.set('db', db);
      await next();
    });
    cms.route('/internal/preview', internalPreviewRouter);
    service = createSiteClassic({
      db: drizzle(renderClient, { schema }) as unknown as Database,
      preview: {
        origin: ORIGIN,
        cmsUrl: 'http://cms.internal',
        secret: SECRET,
        media: ['https://media.example.com'],
        fetch: (input, init) => Promise.resolve(cms.request(String(input), init as RequestInit)),
      },
    });
  });
  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.HEOPRESS_INTERNAL_SECRET;
    else process.env.HEOPRESS_INTERNAL_SECRET = savedSecret;
    await db?.delete(sites).where(inArray(sites.id, [A, B]));
    await db?.delete(users).where(inArray(users.id, [EDITOR, ADMIN]));
    await service?.close();
    await renderClient?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
  });

  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [A, B]));
    await db.delete(users).where(inArray(users.id, [EDITOR, ADMIN]));
    await db.insert(sites).values([
      { id: A, name: 'Preview Alpha', defaultLanguage: 'en' },
      { id: B, name: 'Preview Beta', defaultLanguage: 'en' },
    ]);
    for (const id of [A, B]) await upgradeSitePreset(db, id);
    await db.insert(siteDomains).values([
      { siteId: A, hostname: HOST_A, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
      { siteId: B, hostname: HOST_B, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
    ]);
    for (const id of [A, B]) await settings(id, { permalinks: { articles: '/:slug', pages: '/:slug' } });
    for (const id of [A, B]) await rebuildSiteProjection(db, id);
    // An editor who may read A's articles, and an administrator of A.
    await db.insert(users).values([
      { id: EDITOR, email: 'p06-preview-editor@example.com' },
      { id: ADMIN, email: 'p06-preview-admin@example.com' },
    ]);
    const [editorRole] = await db.insert(roles).values({ siteId: A, name: 'Preview editor', adminAccess: false, appAccess: true }).returning({ id: roles.id });
    const [policy] = await db.insert(policies).values({ siteId: A, name: 'Preview editor', key: 'p06-preview-editor', adminAccess: false, appAccess: true }).returning({ id: policies.id });
    await db.insert(permissions).values({ siteId: A, policyId: policy!.id, collection: 'articles', action: 'read', fields: ['*'] });
    await db.insert(rolePolicies).values({ roleId: editorRole!.id, policyId: policy!.id });
    const [adminRole] = await db.insert(roles).values({ siteId: A, name: 'Preview admin', adminAccess: true, appAccess: true }).returning({ id: roles.id });
    await db.insert(userSites).values([
      { userId: EDITOR, siteId: A, roleId: editorRole!.id },
      { userId: ADMIN, siteId: A, roleId: adminRole!.id },
    ]);
  });

  async function settings(siteId: string, over: Record<string, unknown>) {
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    return new ContentSettingsService({ db, siteId, actor: { userId: null } }).update({
      availableLocales: r!.availableLocales,
      timezone: r!.timezone,
      siteType: 'blog',
      trailingSlash: r!.trailingSlash as 'always',
      localeStrategy: r!.localeStrategy as 'subdirectory',
      localePrefixMode: r!.localePrefixMode as 'default_at_root',
      localePrefixes: r!.localePrefixes,
      permalinks: r!.permalinks,
      allowCrossSiteTranslations: false,
      sponsorDisclosure: r!.sponsorDisclosure,
      sponsorRel: r!.sponsorRel,
      version: r!.version,
      ...over,
    } as never);
  }

  const svc = () => new PreviewService({ db });
  const article = (siteId: string, slug: string, data: Record<string, unknown> = {}, status = 'published') =>
    new ItemService({ db, siteId }).create('articles', { data: { title: `Title ${slug}`, slug, locale: 'en', ...data }, status }) as Promise<{ id: string }>;
  const get = (host: string, path: string, headers: Record<string, string> = {}) => service.app.request(path, { headers: { host, ...headers } });
  const expectPreviewHeaders = (res: Response) => {
    for (const [k, v] of Object.entries(PREVIEW_HEADERS)) expect(res.headers.get(k), k).toBe(v);
    const csp = res.headers.get('content-security-policy') ?? '';
    for (const d of ["default-src 'none'", "script-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) expect(csp).toContain(d);
    expect(csp).toContain('https://media.example.com');
  };
  /** Exchange a link's token for the cookie; the cookie header to send after. */
  const exchange = async (siteId: string, token: string) => {
    const res = await get(PREVIEW, `/${siteId}/${token}`);
    expect(res.status).toBe(303);
    expectPreviewHeaders(res);
    expect(res.headers.get('location')).toBe(`/${siteId}/view`);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(new RegExp(`^heopress_preview=${token}; Max-Age=\\d+; Path=/${siteId}/; Secure; HttpOnly; SameSite=Strict$`));
    return cookie.split(';')[0]!;
  };
  const link = (input: { userId?: string; kind?: 'item' | 'theme'; collection?: string; targetId: string; siteId?: string }) =>
    svc().create({ siteId: input.siteId ?? A, userId: input.userId ?? EDITOR, kind: input.kind ?? 'item', collection: input.kind === 'theme' ? undefined : (input.collection ?? 'articles'), targetId: input.targetId });

  /** A sealed, published version made active directly (past the publication checks: a theme that fails at run time, though recorded as checked). */
  async function forceTheme(siteId: string, versionId: string, templates: Record<string, string>) {
    await runSiteTransaction(db, siteId, async (tx) => {
      await tx.execute(sql`INSERT INTO lumibase_themes (id, site_id, name) VALUES (${`${versionId}_t`}, ${siteId}, 'broken')`);
      await tx.execute(sql`INSERT INTO lumibase_theme_versions (id, site_id, theme_id, number, templates, assets)
                           VALUES (${versionId}, ${siteId}, ${`${versionId}_t`}, 1, ${JSON.stringify(templates)}::jsonb, '[]'::jsonb)`);
      await tx.execute(sql`SELECT heopress_seal_theme_version(${versionId}, ${siteId})`);
      // As if the current checker had passed it (the rendering view serves only such versions, P07 migration 0066).
      const checks = { validator: THEME_CHECKS_VERSION, contentHash: 'forced', ok: true, disclosureOk: true, issues: [], checkedAt: new Date().toISOString() };
      await tx.execute(sql`UPDATE lumibase_theme_versions SET published_at = now(), checks = ${JSON.stringify(checks)}::jsonb WHERE id = ${versionId}`);
      await tx.execute(sql`INSERT INTO lumibase_site_themes (site_id, theme_version_id) VALUES (${siteId}, ${versionId})
                           ON CONFLICT (site_id) DO UPDATE SET theme_version_id = EXCLUDED.theme_version_id`);
    });
    await rebuildSiteProjection(db, siteId);
  }

  it('task 4.1: a theme failing at run time on site A gives A its error page, no internals; B is served meanwhile', async () => {
    await article(A, 'hello');
    await article(B, 'hello-b');
    // Site A's item template names an asset its version does not have: it fails on every item page.
    await forceTheme(A, 'p06_pv_broken', { ...BUILTIN_THEME, item: `${BUILTIN_THEME['partials/top']}{{ 'missing.css' | asset_url }}{% item_body %}${BUILTIN_THEME['partials/bottom']}` });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const [a, b, aHome] = await Promise.all([get(HOST_A, '/hello/'), get(HOST_B, '/hello-b/'), get(HOST_A, '/')]);
      expect(a.status).toBe(500);
      expect(a.headers.get('cache-control')).toBe('no-store');
      const body = await a.text();
      expect(body).toContain('Preview Alpha');
      for (const leak of ['asset_url', 'missing.css', 'Error:', '    at ', '.ts', 'node_modules', '/home/', 'liquid']) expect(body, leak).not.toContain(leak);
      expect(b.status).toBe(200);
      expect(await b.text()).toContain('Title hello-b');
      // A's other pages, which the failing template does not render, still work.
      expect(aHome.status).toBe(200);
      // The failure is not cached: the next request renders again (and fails again), still 500.
      expect((await get(HOST_A, '/hello/')).status).toBe(500);
    } finally {
      errors.mockRestore();
    }
  });

  it('task 4.2: an item preview is exchanged for a cookie, rendered with the draft, private, not indexed, never cached', async () => {
    const draft = await article(A, 'draft-one', {
      body: '<p>Draft secret <a href="https://elsewhere.example.org/">away</a> <img src="https://tracker.example.org/p.png" alt="t"><img src="https://media.example.com/ok.png" alt="m"></p>',
    }, 'draft');
    const { token, expiresAt } = await link({ targetId: draft.id });
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(3500_000);
    // Public hosts have no preview routes: the same path is just a path there.
    const onPublic = await get(HOST_A, `/${A}/${token}`);
    expect(onPublic.status).toBe(404);
    expect(onPublic.headers.get('set-cookie')).toBeNull();

    const cookie = await exchange(A, token);
    const res = await get(PREVIEW, `/${A}/view`, { cookie });
    expect(res.status).toBe(200);
    expectPreviewHeaders(res);
    const html = await res.text();
    expect(html).toContain('Title draft-one');
    expect(html).toContain('Draft secret <a>away</a>');
    expect(html).toContain('https://media.example.com/ok.png');
    expect(html).not.toContain('tracker.example.org');
    expect(html).not.toContain(token);

    // Without the cookie: 403, same headers. The token never appears in a later URL.
    const bare = await get(PREVIEW, `/${A}/view`);
    expect(bare.status).toBe(403);
    expectPreviewHeaders(bare);
    expect((await get(PREVIEW, `/${A}/elsewhere`, { cookie })).status).toBe(404);
    expect((await service.app.request(`/${A}/view`, { method: 'POST', headers: { host: PREVIEW, cookie } })).status).toBe(405);

    // Task 7.2: the draft is in no cache and not public.
    expect((await get(HOST_A, '/draft-one/')).status).toBe(404);
    const cached = await db.select({ key: renderCache.key }).from(renderCache).where(and(eq(renderCache.siteId, A), like(renderCache.body, '%Draft secret%')));
    expect(cached).toHaveLength(0);
    expect((await get(PREVIEW, `/${A}/view`, { cookie })).headers.get('x-cache')).toBeNull();
  });

  it('P07: a preview\'s structured data names the site\'s one identity, on its primary host, also for a language on its own host (Codex review of batch 5a)', async () => {
    const JA_HOST = 'ja.pv-a.example.com';
    await db.insert(siteDomains).values({ siteId: A, hostname: JA_HOST, kind: 'custom', status: 'active', isPrimary: false, entryLocale: 'ja', verifiedAt: new Date() });
    await settings(A, { availableLocales: ['en', 'ja'], localeStrategy: 'subdomain' });
    await new SiteIdentityService({ db, siteId: A, actor: { userId: null } }).update({ version: 0, kind: 'organization', name: 'Preview Org' });
    const draft = await article(A, 'ja-draft', { locale: 'ja' }, 'draft');
    const { token } = await link({ targetId: draft.id });
    const res = await get(PREVIEW, `/${A}/view`, { cookie: await exchange(A, token) });
    expect(res.status).toBe(200);
    const graph = (JSON.parse(/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(await res.text())![1]!) as { '@graph': Array<Record<string, unknown>> })['@graph'];
    expect(graph.find((n) => n['@type'] === 'Organization')).toMatchObject({ '@id': `https://${HOST_A}/#identity`, url: `https://${HOST_A}/` });
    expect(graph.find((n) => n['@type'] === 'WebSite')!['@id']).toBe(`https://${JA_HOST}/#website`);
  });

  it('task 4.3: expired, revoked, reused on another site or after the creator lost access → 403; the token is never logged', async () => {
    const draft = await article(A, 'draft-two', { body: '<p>Second draft</p>' }, 'draft');
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m));
    const tokens: string[] = [];
    try {
      // Cross-site reuse: A's token under B's path finds nothing (looked up in B only).
      const one = await link({ targetId: draft.id });
      tokens.push(one.token);
      const cross = await get(PREVIEW, `/${B}/${one.token}`);
      expect(cross.status).toBe(403);
      expectPreviewHeaders(cross);
      expect(cross.headers.get('set-cookie')).toBeNull();
      const crossView = await get(PREVIEW, `/${B}/view`, { cookie: `heopress_preview=${one.token}` });
      expect(crossView.status).toBe(403);
      expect(await crossView.text()).not.toContain('Second draft');

      // A wrong or truncated token, a forged cookie: 403.
      expect((await get(PREVIEW, `/${A}/${one.token.slice(0, -2)}xx`)).status).toBe(403);
      expect((await get(PREVIEW, `/${A}/view`, { cookie: `heopress_preview=${'a'.repeat(43)}` })).status).toBe(403);

      // Valid now; expired → 403 even with the cookie already set.
      const cookie = await exchange(A, one.token);
      expect((await get(PREVIEW, `/${A}/view`, { cookie })).status).toBe(200);
      await runSiteTransaction(db, A, (tx) => tx.update(previewLinks).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(previewLinks.id, one.id)));
      expect((await get(PREVIEW, `/${A}/view`, { cookie })).status).toBe(403);
      expect((await get(PREVIEW, `/${A}/${one.token}`)).status).toBe(403);

      // Revoked → 403.
      const two = await link({ targetId: draft.id });
      tokens.push(two.token);
      const cookie2 = await exchange(A, two.token);
      await svc().revoke(A, two.id, { userId: EDITOR, admin: false });
      expect((await get(PREVIEW, `/${A}/view`, { cookie: cookie2 })).status).toBe(403);

      // The creator loses read access (membership removed) → 403 at once; an account no longer active → 403.
      const three = await link({ targetId: draft.id });
      tokens.push(three.token);
      const cookie3 = await exchange(A, three.token);
      await db.delete(userSites).where(and(eq(userSites.userId, EDITOR), eq(userSites.siteId, A)));
      expect((await get(PREVIEW, `/${A}/view`, { cookie: cookie3 })).status).toBe(403);
      const four = await link({ userId: ADMIN, targetId: draft.id });
      tokens.push(four.token);
      const cookie4 = await exchange(A, four.token);
      await db.update(users).set({ status: 'suspended' }).where(eq(users.id, ADMIN));
      expect((await get(PREVIEW, `/${A}/view`, { cookie: cookie4 })).status).toBe(403);

      // Only the hash is stored.
      const stored = await runSiteTransaction(db, A, (tx) => tx.select({ hash: previewLinks.tokenHash }).from(previewLinks).where(eq(previewLinks.siteId, A)));
      for (const t of tokens) expect(stored.map((s) => s.hash)).not.toContain(t);

      const logged = spies.flatMap((s) => s.mock.calls).map((args) => args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a) ?? String(a))).join(' '));
      for (const t of tokens) for (const line of logged) expect(line).not.toContain(t);
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it('task 4.3: who may create a link — readers of the item for drafts, site administrators for theme versions; never across sites', async () => {
    const draft = await article(A, 'draft-three', {}, 'draft');
    const draftB = await article(B, 'draft-b', {}, 'draft');
    // The editor has no role on B, and B's item is not in A.
    await expect(link({ siteId: B, targetId: draftB.id })).rejects.toThrow(PreviewServiceError);
    await expect(link({ targetId: draftB.id })).rejects.toThrow(PreviewServiceError);
    await expect(link({ targetId: draft.id, collection: 'pages' })).rejects.toThrow(PreviewServiceError);
    await expect(svc().create({ siteId: A, userId: null, kind: 'item', collection: 'articles', targetId: draft.id })).rejects.toThrow(/signed-in/);
    await expect(svc().create({ siteId: A, userId: EDITOR, kind: 'item', collection: 'articles', targetId: draft.id, ttlSeconds: 10 * 86400 })).rejects.toThrow(/ttl_seconds/);
    // A theme version: administrators only.
    const v = await new ThemeService({ db, siteId: A, actor: { userId: ADMIN } }).createVersion({ name: 'next', templates: BUILTIN_THEME });
    await expect(link({ kind: 'theme', targetId: v.id })).rejects.toThrow(PreviewServiceError);
    await expect(link({ userId: ADMIN, kind: 'theme', targetId: v.id })).resolves.toMatchObject({ token: expect.any(String) });
  });

  it('task 4.2: a theme version preview renders the site with that version and serves its assets under the preview only', async () => {
    await article(A, 'published-one');
    const top = BUILTIN_THEME['partials/top']!.replace('</head>', `<link rel="stylesheet" href="{{ 'site.css' | asset_url }}"></head>`).replace('<main>', '<main><p class="marker">NEXT-VERSION</p>');
    const v = await new ThemeService({ db, siteId: A, actor: { userId: ADMIN } }).createVersion({
      name: 'next',
      templates: { ...BUILTIN_THEME, 'partials/top': top },
      assets: [{ path: 'site.css', contentType: 'text/css', base64: Buffer.from('body{color:#123}').toString('base64') }],
    });
    const { token } = await link({ userId: ADMIN, kind: 'theme', targetId: v.id });
    const cookie = await exchange(A, token);
    const res = await get(PREVIEW, `/${A}/view`, { cookie });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('NEXT-VERSION');
    expect(html).toContain('Title published-one');
    const href = /href="(\/[^"]+\.css)"/.exec(html)?.[1];
    expect(href).toMatch(new RegExp(`^/${A}/assets/${v.id}/[0-9a-f]{64}\\.css$`));
    const css = await get(PREVIEW, href!, { cookie });
    expect(css.status).toBe(200);
    expectPreviewHeaders(css);
    expect(await css.text()).toBe('body{color:#123}');
    expect((await get(PREVIEW, href!)).status).toBe(403);
    // The public site still runs its own theme; the unpublished version's assets are not public.
    expect(await (await get(HOST_A, '/')).text()).not.toContain('NEXT-VERSION');
    expect((await get(HOST_A, href!.replace(`/${A}/assets/`, '/_theme/'))).status).toBe(404);
  });

  it('a failure on the preview origin keeps the preview headers (Codex review, batch 6)', async () => {
    // The database fails before the preview route starts, and the CMS answers something that is not JSON.
    const failingDb = { select: () => { throw new Error('db down'); } } as unknown as Database;
    const broken = createSiteClassic({
      db: failingDb,
      sweepIntervalMs: 0,
      preview: { origin: ORIGIN, cmsUrl: 'http://cms.internal', secret: SECRET, media: ['https://media.example.com'], fetch: () => Promise.resolve(new Response('not json', { status: 200 })) },
    });
    const late = createSiteClassic({
      db: drizzle(renderClient, { schema }) as unknown as Database,
      sweepIntervalMs: 0,
      preview: { origin: ORIGIN, cmsUrl: 'http://cms.internal', secret: SECRET, media: ['https://media.example.com'], fetch: () => Promise.resolve(new Response('not json', { status: 200 })) },
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const app of [broken.app, late.app]) {
        const res = await app.request(`/${A}/${'t'.repeat(43)}`, { headers: { host: PREVIEW } });
        expect(res.status).toBe(500);
        expectPreviewHeaders(res);
        expect(res.headers.get('set-cookie')).toBeNull();
      }
    } finally {
      errors.mockRestore();
      await broken.close();
      await late.close();
    }
  });

  it('the internal endpoint: the shared secret, no proxied requests, the same 403 for every refused link', async () => {
    const body = JSON.stringify({ site_id: A, token: 'x'.repeat(43) });
    const post = (headers: Record<string, string>) => cms.request('/internal/preview/resolve', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
    expect((await post({})).status).toBe(403);
    expect((await post({ 'x-heopress-internal-secret': `${SECRET}x` })).status).toBe(403);
    expect((await post({ 'x-heopress-internal-secret': SECRET, 'x-forwarded-for': '203.0.113.9' })).status).toBe(403);
    const denied = await post({ 'x-heopress-internal-secret': SECRET });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ errors: [{ code: 'PREVIEW_DENIED', message: 'Preview not allowed.' }] });
    process.env.HEOPRESS_INTERNAL_SECRET = '';
    try {
      expect((await post({ 'x-heopress-internal-secret': '' })).status).toBe(404);
    } finally {
      process.env.HEOPRESS_INTERNAL_SECRET = SECRET;
    }
  });
});
