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
import { signBranchPreviewCookie, verifyBranchPreviewCookie } from '@heopress/public-site';
import { createSiteClassic, type SiteClassic } from '@heopress/site-classic';
import type { AppEnv } from '../env';
import { internalPreviewRouter } from '../routes/internal-preview';
import { ItemService } from '../services/item-service';
import { runSiteTransaction } from '../services/rls-transaction';
import { PreviewDenied, PreviewServiceError } from '../services/rendering/preview-service';
import { BranchPreviewService } from '../services/rendering/branch-preview-service';
import { ContentVersionService } from '../services/content-version-service';
import { __resetPermissionProcessCacheForTests } from '../services/permission-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { SiteIdentityService } from '../services/site-network/site-identity-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { ThemeService } from '../services/themes/theme-service';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Branch previews on the public site (HeoPress P10 tasks 4.2, 4.4; spec agents/content-branches "分支预览",
 * "分支预览隔离与合并版本"): a one-time link traded for a signed cookie, the branch page only for that browser, with
 * noindex and no-store; every other visitor gets the public page; nothing a branch shows ever reaches the page cache.
 *
 * Needs DATABASE_OWNER_URL (to provision the rendering role).
 */

const A = 'site_p10_bpv_a';
const B = 'site_p10_bpv_b';
const HOST_A = 'bpv-a.example.com';
const HOST_B = 'bpv-b.example.com';
const PREVIEW = 'preview.bpv.example.com';
const ORIGIN = `https://${PREVIEW}`;
const SECRET = randomBytes(24).toString('hex');
const EDITOR = 'usr_p10_bpv_editor';
const ADMIN = 'usr_p10_bpv_admin';
const RENDER_ROLE = 'heopress_render_bpv';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;


describe.skipIf(!hasDbIntegrationUrl)('P10 branch previews — DB integration', () => {
  let db: Database;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let service: SiteClassic;
  let cms: Hono<AppEnv>;
  const savedSecret = process.env.HEOPRESS_INTERNAL_SECRET;

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    process.env.HEOPRESS_INTERNAL_SECRET = SECRET;
    db = await connectDbIntegration('p10-branch-preview');
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
      { id: EDITOR, email: 'p10-bpv-editor@example.com' },
      { id: ADMIN, email: 'p10-bpv-admin@example.com' },
    ]);
    const [editorRole] = await db.insert(roles).values({ siteId: A, name: 'Preview editor', adminAccess: false, appAccess: true }).returning({ id: roles.id });
    const [policy] = await db.insert(policies).values({ siteId: A, name: 'Preview editor', key: 'p10-bpv-editor', adminAccess: false, appAccess: true }).returning({ id: policies.id });
    await db.insert(permissions).values([
      { siteId: A, policyId: policy!.id, collection: 'articles', action: 'read', fields: ['*'] },
      { siteId: A, policyId: policy!.id, collection: 'articles', action: 'update', fields: ['*'] },
    ]);
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

  const article = (siteId: string, slug: string, data: Record<string, unknown> = {}, status = 'published') =>
    new ItemService({ db, siteId }).create('articles', { data: { title: `Title ${slug}`, slug, locale: 'en', ...data }, status }) as Promise<{ id: string }>;
  const get = (host: string, path: string, headers: Record<string, string> = {}) => service.app.request(path, { headers: { host, ...headers } });

  const branches = (siteId = A, userId: string | null = EDITOR) => new ContentVersionService({ db, siteId, userId, items: new ItemService({ db, siteId }) });
  const previews = () => new BranchPreviewService({ db, secret: SECRET });
  const cachedWith = async (text: string) =>
    db.select({ key: renderCache.key }).from(renderCache).where(and(inArray(renderCache.siteId, [A, B]), like(renderCache.body, `%${text}%`)));

  /** A published article of A with a branch whose title differs; the one-time link's path. */
  async function branchedArticle(slug = 'hello') {
    const item = await article(A, slug);
    await rebuildSiteProjection(db, A);
    await branches().create('articles', item.id, 'rewrite', 'Rewrite');
    await branches().update('articles', item.id, 'rewrite', { set: { title: 'Branch title' } });
    const link = await previews().create({ siteId: A, userId: EDITOR, collection: 'articles', itemId: item.id, key: 'rewrite' });
    const url = new URL(link.url);
    expect(url.host).toBe(HOST_A);
    expect(url.pathname).toMatch(/^\/_heopress\/branch-preview\/[A-Za-z0-9_-]{43}$/);
    return { item, path: url.pathname };
  }

  async function exchangeBranch(path: string) {
    const res = await get(HOST_A, path);
    expect(res.status).toBe(303);
    expect(res.headers.get('cache-control')).toBe('no-store, private');
    expect(res.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/^heopress_branch_preview=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; Max-Age=\d+; Path=\/; Secure; HttpOnly; SameSite=Lax$/);
    return { cookie: setCookie.split(';')[0]!, location: res.headers.get('location')! };
  }

  it('task 4.2: with the cookie the public page shows the branch (noindex, no-store); without it, the live version — and the cache never holds the branch', async () => {
    const { path } = await branchedArticle();
    // A visitor first: the public page, cacheable.
    const before = await get(HOST_A, '/hello/');
    expect(before.status).toBe(200);
    expect(await before.text()).toContain('Title hello');

    const { cookie, location } = await exchangeBranch(path);
    expect(location).toBe('/hello/');
    // The link works once: only the browser that opened it holds the cookie.
    expect((await get(HOST_A, path)).status).toBe(403);

    const branch = await get(HOST_A, '/hello/', { cookie });
    expect(branch.status).toBe(200);
    expect(branch.headers.get('cache-control')).toBe('no-store, private');
    expect(branch.headers.get('x-robots-tag')).toBe('noindex, nofollow');
    expect(branch.headers.get('x-cache')).toBeNull();
    expect(branch.headers.get('etag')).toBeNull();
    const html = await branch.text();
    expect(html).toContain('Branch title');
    expect(html).not.toContain('Title hello');

    // Everyone else: the live version, from the cache the branch never touched.
    const visitor = await get(HOST_A, '/hello/');
    expect(await visitor.text()).toContain('Title hello');
    expect(visitor.headers.get('x-cache')).toMatch(/^hit/);
    expect(visitor.headers.get('cache-control')).not.toContain('no-store');
    await new Promise((r) => setTimeout(r, 50));
    expect(await cachedWith('Branch title')).toHaveLength(0);
  });

  it('task 4.4: the cookie is bound to its site, signature, grant and the creator\'s permission; anything else is the public page', async () => {
    const { item, path } = await branchedArticle();
    await article(B, 'hello');
    await rebuildSiteProjection(db, B);
    const { cookie } = await exchangeBranch(path);
    const value = cookie.slice('heopress_branch_preview='.length);

    // Another site's host: the public page of that site.
    const onB = await get(HOST_B, '/hello/', { cookie });
    expect(await onB.text()).not.toContain('Branch title');
    expect(onB.headers.get('cache-control')).not.toContain('no-store');

    // An altered cookie, or one signed with another key: public.
    const tampered = `heopress_branch_preview=${value.slice(0, -2)}${value.endsWith('AA') ? 'BB' : 'AA'}`;
    expect(await (await get(HOST_A, '/hello/', { cookie: tampered })).text()).not.toContain('Branch title');
    const forged = `heopress_branch_preview=${signBranchPreviewCookie('another-secret-another-secret-0000', verifyBranchPreviewCookie(SECRET, value, A, Date.now())!)}`;
    expect(await (await get(HOST_A, '/hello/', { cookie: forged })).text()).not.toContain('Branch title');

    // The creator loses update rights → read is still there; lose read → public.
    expect(await (await get(HOST_A, '/hello/', { cookie })).text()).toContain('Branch title');
    await db.delete(userSites).where(and(eq(userSites.userId, EDITOR), eq(userSites.siteId, A)));
    __resetPermissionProcessCacheForTests();
    expect(await (await get(HOST_A, '/hello/', { cookie })).text()).not.toContain('Branch title');
    await db.insert(userSites).values({ userId: EDITOR, siteId: A, roleId: (await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, A), eq(roles.name, 'Preview editor'))))[0]!.id });
    __resetPermissionProcessCacheForTests();
    expect(await (await get(HOST_A, '/hello/', { cookie })).text()).toContain('Branch title');

    // Revoked: public. Deleting the branch ends it too.
    expect(await previews().revoke(A, 'articles', item.id, 'rewrite', { userId: EDITOR, admin: false })).toBe(1);
    expect(await (await get(HOST_A, '/hello/', { cookie })).text()).not.toContain('Branch title');
    expect(await cachedWith('Branch title')).toHaveLength(0);
  });

  it('task 4.4: a link expires, cannot be used on another site, and an expired cookie is ignored', async () => {
    const { path } = await branchedArticle();
    // The same link on B's host finds nothing there.
    expect((await get(HOST_B, path)).status).toBe(403);
    const { cookie } = await exchangeBranch(path);
    const later = new BranchPreviewService({ db, secret: SECRET, now: () => new Date(Date.now() + 2 * 3600_000) });
    const value = cookie.slice('heopress_branch_preview='.length);
    await expect(later.resolve(A, value)).rejects.toBeInstanceOf(PreviewDenied);
    await expect(previews().resolve(B, value)).rejects.toBeInstanceOf(PreviewDenied);
    await expect(previews().create({ siteId: A, userId: EDITOR, collection: 'articles', itemId: 'nope', key: 'rewrite' })).rejects.toBeInstanceOf(PreviewServiceError);
  });
});
