import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { astroSites, deploymentTargets, ensureRenderRole, schema, siteContentSettings, siteDomains, sites, staticDeploys, type Database } from '@heopress/database';
import { EnvKeyProvider } from '@heopress/runtime';
import { exportPageData } from '@heopress/site-classic/page-data';
import { buildDir, buildSiteGeneration, liveGeneration, type SiteBuildOptions } from '@heopress/site-astro';
import type { PageDataSnapshot } from '@heopress/contracts/page-data';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { AstroEngine } from '../services/astro/astro-engine';
import { encryptToken } from '../services/deployment/token-vault';
import type { DeploymentProvider, DeploymentRef, StaticFile } from '../services/deployment/providers';
import { reconcileStaticDeploys, requestStaticDeploy, requestStaticRollback, StaticDeployer, type StaticDeployerOptions } from '../services/deployment/static/static-deployer';
import { configureStaticSite, staticSiteView } from '../services/deployment/static/static-site';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Static deployments against the real data path (HeoPress P11 tasks 4.3–4.5, 5.1, 5.2; spec publishing/frontend-deployments).
 * Real Astro builds of two sites; the providers are in-memory stand-ins recording what they were sent (the adapters' own
 * requests are covered by `static-providers.contract.test.ts`). Each acceptance rule of task 5.1 is one test.
 *
 * Needs DATABASE_OWNER_URL (to provision this suite's rendering role).
 */

const RENDER_ROLE = 'heopress_render_static_deploy';
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;
const NOW = Date.parse('2026-10-01T12:00:00Z');
const A = { id: 'site_p11_deploy_a', host: 'deploy-a.example.com', name: 'Deploy A' };
const B = { id: 'site_p11_deploy_b', host: 'deploy-b.example.com', name: 'Deploy B' };
const IDS = [A.id, B.id];
const KEYS = new EnvKeyProvider(new Map([['v0', Buffer.alloc(32, 5).toString('base64')]]), 'v0');

/** An in-memory provider: what it was sent, and how it answers. */
class FakeProvider implements DeploymentProvider {
  readonly deployments = new Map<string, { marker: string; files: StaticFile[]; status: DeploymentRef['status']; projectId: string; token: string }>();
  uploads = 0;
  /** `ok`; `fail` (the provider reports an error); `lose` (it takes the upload, then the answer is lost). */
  mode: 'ok' | 'fail' | 'lose' = 'ok';
  constructor(readonly key: string) {}
  verifyToken = () => Promise.resolve({ ok: true });
  trigger = () => Promise.reject(new Error('no'));
  getLogs = () => Promise.resolve('stage deploy: upload interrupted (Authorization: Bearer nf-secret-xyz)');
  verifyWebhook = () => Promise.resolve(false);
  parseWebhook = () => null;
  getStatus(_t: string, _p: unknown, id: string): Promise<DeploymentRef> {
    const d = this.deployments.get(id)!;
    return Promise.resolve({ providerDeploymentId: id, status: d.status, url: `https://${id}.${this.key}.example.net`, errorMessage: d.status === 'error' ? 'upload interrupted' : undefined });
  }
  deployStatic(token: string, target: { projectId: string }, files: StaticFile[], opts: { marker: string }): Promise<DeploymentRef> {
    this.uploads++;
    const id = `d${this.deployments.size + 1}`;
    this.deployments.set(id, { marker: opts.marker, files, status: this.mode === 'fail' ? 'error' : 'ready', projectId: target.projectId, token });
    if (this.mode === 'lose') return Promise.reject(new Error('socket hang up'));
    return Promise.resolve({ providerDeploymentId: id, status: 'building' });
  }
  findByMarker(_t: string, _p: unknown, marker: string): Promise<DeploymentRef | null> {
    for (const [id, d] of this.deployments) if (d.marker === marker) return Promise.resolve({ providerDeploymentId: id, status: d.status });
    return Promise.resolve(null);
  }
  last() {
    return [...this.deployments.values()].at(-1)!;
  }
  fileOf(path: string) {
    const f = this.last().files.find((x) => x.path === path);
    return f ? Buffer.from(f.bytes).toString('utf8') : null;
  }
}

describe.skipIf(!hasDbIntegrationUrl)('Static deployments — DB integration (P11 tasks 4.3–4.5, 5.1, 5.2)', () => {
  let db: Database;
  let owner: postgres.Sql;
  let renderClient: postgres.Sql;
  let renderDb: Database;
  let root: string;
  const clock = NOW;
  const now = () => new Date(clock);
  const providers = { 'cloudflare-pages': new FakeProvider('cloudflare-pages'), netlify: new FakeProvider('netlify'), vercel: new FakeProvider('vercel') };
  const targets: Record<string, string> = {};
  let reach: StaticDeployerOptions['reachability'];

  const items = (siteId: string) => new ItemService({ db, siteId });
  const publish = async (siteId: string, slug: string, title: string, status = 'published') =>
    ((await items(siteId).create('articles', { data: { title, slug, locale: 'en', body: `<p>${title}.</p>` }, status, publishedAt: new Date('2026-09-20T00:00:00Z') })) as { id: string }).id;
  const exportSnapshot = (siteId: string) => exportPageData({ db: renderDb, siteId, now: () => NOW });
  const engine = (over: Partial<ConstructorParameters<typeof AstroEngine>[0]> = {}) =>
    new AstroEngine({ db, renderDb, root, now, exportSnapshot, onActivated: (s, g, snap) => deployer().afterActivate(s, g, snap), ...over });
  const deployer = (over: Partial<StaticDeployerOptions> = {}) =>
    new StaticDeployer({
      db,
      keys: KEYS,
      root,
      exportSnapshot,
      providerOf: (k) => providers[k as keyof typeof providers],
      reachability: (...a) => reach!(...a),
      sleep: () => Promise.resolve(),
      now,
      ...over,
    });
  const site = async (id = A.id) => (await db.select().from(astroSites).where(eq(astroSites.siteId, id)))[0]!;
  const deploys = (id = A.id) => db.select().from(staticDeploys).where(eq(staticDeploys.siteId, id));
  /** A build and its deploy, end to end. */
  async function buildAndDeploy(e = engine()) {
    const report = await e.buildNow(A.id, 'event');
    expect(report.status, report.error).toBe('succeeded');
    const [row] = await deployer().runPending();
    return { report, row: row! };
  }

  beforeAll(async () => {
    expect(OWNER_URL, 'DATABASE_OWNER_URL is required to provision the rendering role').toBeDefined();
    db = await connectDbIntegration('static-deploy');
    owner = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
    const password = randomBytes(18).toString('hex');
    await owner.begin((tx) => ensureRenderRole(tx, { role: RENDER_ROLE, password }));
    const url = new URL(dbIntegrationUrl!);
    url.username = RENDER_ROLE;
    url.password = password;
    renderClient = postgres(url.toString(), { max: 2, onnotice: () => {} });
    renderDb = drizzle(renderClient, { schema }) as unknown as Database;
    root = await mkdtemp(join(tmpdir(), 'heopress-static-deploy-'));

    await db.delete(sites).where(inArray(sites.id, IDS));
    await db.insert(sites).values([
      { id: A.id, name: A.name, defaultLanguage: 'en' },
      { id: B.id, name: B.name, defaultLanguage: 'en' },
    ]);
    for (const s of [A, B]) {
      await upgradeSitePreset(db, s.id);
      await db.insert(siteDomains).values({ siteId: s.id, hostname: s.host, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date('2026-09-01T00:00:00Z') });
      const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, s.id));
      await new ContentSettingsService({ db, siteId: s.id, actor: { userId: null } }).update({
        availableLocales: ['en'],
        timezone: 'UTC',
        siteType: 'blog',
        trailingSlash: 'always',
        localeStrategy: 'subdirectory',
        localePrefixMode: 'default_at_root',
        localePrefixes: {},
        permalinks: { articles: '/:slug', pages: '/:slug', categories: '/category/:slug', tags: '/tag/:slug', authors: '/author/:slug' },
        allowCrossSiteTranslations: r!.allowCrossSiteTranslations,
        sponsorDisclosure: r!.sponsorDisclosure,
        sponsorRel: r!.sponsorRel,
        version: r!.version,
      } as never);
      await rebuildSiteProjection(db, s.id);
      await publish(s.id, 'first', `${s.name} first`);
    }
    // Targets: each site its own, tokens sealed to their site.
    for (const [siteId, provider, projectId, token] of [
      [A.id, 'cloudflare-pages', '0123456789abcdef0123456789abcdef/deploy-a', 'cf-a-token'],
      [A.id, 'netlify', 'netlify-site-a', 'nf-a-token'],
      [A.id, 'vercel', 'prj_a', 'vc-a-token'],
      [B.id, 'netlify', 'netlify-site-b', 'nf-b-token'],
    ] as const) {
      const enc = await encryptToken(KEYS, token, siteId);
      const [t] = await db
        .insert(deploymentTargets)
        .values({ siteId, provider, name: `${provider} ${siteId}`, projectId, tokenCiphertext: enc.ciphertext, tokenKeyId: enc.keyId })
        .returning({ id: deploymentTargets.id });
      targets[`${siteId}:${provider}`] = t!.id;
    }
    await configureStaticSite(db, A.id, { enabled: true, theme: 'official:starter', deployTargetId: targets[`${A.id}:cloudflare-pages`] });
  }, 180_000);

  afterAll(async () => {
    await db?.delete(sites).where(inArray(sites.id, IDS));
    await renderClient?.end({ timeout: 2 });
    await owner?.end({ timeout: 2 });
    if (root) await rm(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    for (const p of Object.values(providers)) p.mode = 'ok';
    reach = () => Promise.resolve({ status: 'passed', summary: { errors: 0, warnings: 0, passed: 12, skipped: 0 }, issues: [] });
  });

  it('task 4.1: a successful build is uploaded to Cloudflare Pages; the record shows success and the address', async () => {
    const { report, row } = await buildAndDeploy();
    expect(row).toMatchObject({ provider: 'cloudflare-pages', kind: 'deploy', generation: report.generation, status: 'succeeded', url: expect.stringContaining('cloudflare-pages.example.net') });
    const sent = providers['cloudflare-pages'].last();
    expect(sent.projectId).toBe('0123456789abcdef0123456789abcdef/deploy-a');
    expect(sent.token).toBe('cf-a-token');
    expect(sent.files.map((f) => f.path)).toEqual(expect.arrayContaining(['/index.html', '/first/index.html', '/robots.txt', '/_headers', '/_redirects']));
    expect(providers['cloudflare-pages'].fileOf('/_headers')).toMatch(/\/first\.md\n  Content-Type: text\/markdown/);
    expect((await site()).deployedGeneration).toBe(report.generation);
  });

  it('task 4.4: the deploy carries the static response contract — 301 for an old address, 410 for a withdrawn one', async () => {
    await configureStaticSite(db, A.id, { enabled: true, deployTargetId: targets[`${A.id}:netlify`] });
    await deployer().runPending(); // the move to a new target deploys the live build first
    const moved = await publish(A.id, 'old-name', 'Moved');
    const current = (await items(A.id).detail('articles', moved)) as { version: number };
    await items(A.id).patch('articles', moved, { data: { slug: 'new-name' }, expectedVersion: current.version } as never);
    const gone = await publish(A.id, 'withdrawn', 'Withdrawn');
    await items(A.id).softDelete('articles', gone);
    const { row } = await buildAndDeploy();
    expect(row.status, row.error ?? '').toBe('succeeded');
    const redirects = providers.netlify.fileOf('/_redirects') ?? '';
    expect(redirects).toMatch(/^\/old-name\/ \S*\/new-name\/ 301!$/m);
    expect(redirects).toContain('/withdrawn/ /404.html 410!');
    expect(providers.netlify.last().files.some((f) => f.path === '/withdrawn/index.html')).toBe(false);
  });

  it('task 4.3 / spec "部署失败": an upload Netlify fails keeps the live version; the record is failed with an error summary, secrets masked', async () => {
    const before = await site();
    providers.netlify.mode = 'fail';
    const { row } = await buildAndDeploy();
    expect(row).toMatchObject({ status: 'failed', error: 'upload interrupted' });
    expect(row.log).toContain('Bearer ***');
    expect(row.log).not.toContain('nf-secret-xyz');
    const after = await site();
    expect(after.deployedGeneration).toBe(before.deployedGeneration);
    expect(after.deployedRevision).toBe(before.deployedRevision);
  });

  it('task 4.3: rollback puts the previous successful deploy back and adds a rollback record', async () => {
    const { report } = await buildAndDeploy();
    const prior = (await deploys()).filter((d) => d.status === 'succeeded' && d.generation !== report.generation).sort((x, y) => +y.finishedAt! - +x.finishedAt!)[0]!;
    const requested = await requestStaticRollback(db, A.id, 'user_admin');
    expect(requested).toMatchObject({ kind: 'rollback', generation: prior.generation, rollbackOf: prior.id, status: 'requested' });
    const [done] = await deployer().runPending();
    expect(done).toMatchObject({ kind: 'rollback', status: 'succeeded' });
    expect((await site()).deployedGeneration).toBe(prior.generation);
    // The reconciliation does not undo it: the live build was deployed already.
    expect(await reconcileStaticDeploys(db)).not.toContain(A.id);
  });

  it('task 4.4: a rollback that would put withdrawn content back online is refused', async () => {
    const id = await publish(A.id, 'soon-gone', 'Soon gone');
    const { report } = await buildAndDeploy();
    await items(A.id).softDelete('articles', id);
    await buildAndDeploy();
    const row = await requestStaticDeploy(db, A.id, { kind: 'rollback', generation: report.generation, revision: report.revision });
    const [done] = await deployer().runPending();
    expect(done!.id).toBe(row.id);
    expect(done).toMatchObject({ status: 'refused', error: expect.stringMatching(/no longer publishes \(.*\/soon-gone\/.*\): rebuild instead/) });
  });

  it('task 4.5: the post-deploy reachability check runs with the platform\'s advice and its issues land in the record', async () => {
    let asked: string | null = null;
    reach = (siteId, platform) => {
      asked = `${siteId}:${platform}`;
      return Promise.resolve({ status: 'issues' });
    };
    await buildAndDeploy();
    expect(asked).toBe(`${A.id}:netlify`);
    // The real P07 check, its requests answered in-process: the Markdown copy comes back as text/plain.
    reach = undefined as never;
    const real = deployer({
      reachability: undefined,
      reachabilityDeps: {
        sleep: () => Promise.resolve(),
        sampleScan: 5,
        fetch: (url) => {
          const u = new URL(url);
          if (u.pathname.endsWith('.md')) return Promise.resolve(new Response('# x', { status: 200, headers: { 'content-type': 'text/plain' } }));
          const type = u.pathname.endsWith('.txt') ? 'text/plain' : u.pathname.endsWith('.xml') ? (u.pathname.includes('feed') ? 'application/rss+xml' : u.pathname.includes('atom') ? 'application/atom+xml' : 'application/xml') : 'text/html';
          return Promise.resolve(new Response(u.pathname === '/robots.txt' ? 'User-agent: *\nAllow: /\n' : '<html></html>', { status: 200, headers: { 'content-type': type } }));
        },
      },
    });
    const report = await engine().buildNow(A.id, 'event');
    expect(report.status).toBe('succeeded');
    const [row] = await real.runPending();
    const r = row!.reachability as { status: string; issues: Array<{ url: string; code: string; advice: string }> };
    expect(r.status).toBe('issues');
    const md = r.issues.find((i) => i.url.endsWith('.md'))!;
    expect(md.code).toBe('wrong-type');
    expect(md.advice).toContain('_headers');
  });

  it('task 5.2: an output carrying a sample secret is refused before it leaves the server', async () => {
    const { report } = await buildAndDeploy();
    await writeFile(join(buildDir(root, A.id, report.generation), 'leak.txt'), 'JWT_SECRET=s3cr3t-sample');
    const uploads = providers.netlify.uploads;
    const row = await requestStaticDeploy(db, A.id, { kind: 'deploy', generation: report.generation, revision: report.revision });
    const [done] = await deployer().runPending();
    expect(done).toMatchObject({ id: row.id, status: 'refused', error: expect.stringContaining('leak.txt (secret-assignment)') });
    expect(done!.log).not.toContain('s3cr3t-sample');
    expect(providers.netlify.uploads).toBe(uploads);
    await rm(join(buildDir(root, A.id, report.generation), 'leak.txt'));
  });

  // ── Task 5.1: one test per acceptance rule ────────────────────────────────

  it('5.1 a content edit during the build does not enter this snapshot', async () => {
    const e = engine({
      build: async (o: SiteBuildOptions) => {
        // Published after the snapshot was pinned, while the build runs.
        await publish(A.id, 'mid-build', 'Mid build');
        return buildSiteGeneration(o);
      },
    });
    const { report, row } = await buildAndDeploy(e);
    expect(providers.netlify.last().files.some((f) => f.path === '/mid-build/index.html')).toBe(false);
    expect(row.revision).toBe(report.revision);
    const view = await staticSiteView(db, A.id);
    expect(view.publishedRevision).toBeGreaterThan(report.revision!);
  });

  it('5.1 unpublished content enters neither HTML, JSON, the search index nor the sitemap', async () => {
    await publish(A.id, 'draft-secret', 'Draft only words', 'draft');
    const snapshot: PageDataSnapshot = await exportSnapshot(A.id);
    expect(JSON.stringify(snapshot)).not.toContain('Draft only words');
    expect(snapshot.unsupported).toContain('search');
    await buildAndDeploy();
    for (const f of providers.netlify.last().files) {
      const text = Buffer.from(f.bytes).toString('utf8');
      expect(text, f.path).not.toContain('Draft only words');
      expect(text, f.path).not.toContain('draft-secret');
    }
    expect(providers.netlify.last().files.some((f) => /search.*\.json$/i.test(f.path))).toBe(false);
  });

  it('5.1 a failed build does not overwrite the last valid output, here or at the target', async () => {
    const before = await site();
    const uploads = providers.netlify.uploads;
    const report = await engine({ build: async () => ({ ok: false, stage: 'build', error: 'template error' }) }).buildNow(A.id, 'event');
    expect(report.status).toBe('failed');
    expect(await deployer().runPending()).toEqual([]);
    expect(providers.netlify.uploads).toBe(uploads);
    expect(await liveGeneration(root, A.id)).toBe(before.activeGeneration);
    expect((await site()).deployedGeneration).toBe(before.deployedGeneration);
  });

  it('5.1 a deploy of site A never writes B\'s directory, project or credentials', async () => {
    const s = await site();
    // A record of site A naming site B's target (a tampered or confused row): not found in A's scope.
    const [row] = await db
      .insert(staticDeploys)
      .values({ siteId: A.id, targetId: targets[`${B.id}:netlify`], provider: 'netlify', kind: 'deploy', generation: s.activeGeneration!, revision: s.activeRevision, marker: 'heopress-cross' })
      .returning();
    const uploads = providers.netlify.uploads;
    const [done] = await deployer().runPending();
    expect(done).toMatchObject({ id: row!.id, status: 'failed', error: expect.stringContaining('not one of this site\'s targets') });
    expect(providers.netlify.uploads).toBe(uploads);
    // Every deploy of A went to A's project with A's token, from A's directory only.
    for (const d of providers.netlify.deployments.values()) {
      expect(d.projectId).toBe('netlify-site-a');
      expect(d.token).toBe('nf-a-token');
      expect(d.files.some((f) => Buffer.from(f.bytes).toString('utf8').includes(B.host))).toBe(false);
    }
    expect(await readFile(join(root, B.id, 'current', 'index.html'), 'utf8').catch(() => null)).toBeNull();
  });

  it('5.1 publishedRevision and deployedRevision are apart; a lost confirmation is checked at the provider before any retry', async () => {
    await publish(A.id, 'confirm', 'Confirm');
    providers.netlify.mode = 'lose';
    const uploads = providers.netlify.uploads;
    const { report, row } = await buildAndDeploy();
    // The answer was lost, but the provider has it under the marker: taken, not uploaded again.
    expect(row).toMatchObject({ status: 'succeeded', generation: report.generation });
    expect(providers.netlify.uploads).toBe(uploads + 1);
    const view = await staticSiteView(db, A.id);
    expect(view.deployedRevision).toBe(report.revision);
    expect(view.publishedRevision).toBeGreaterThanOrEqual(view.deployedRevision!);

    // A deploy left `uploading` past its lease with nothing at the provider: failed, then asked again (once).
    const [stuck] = await db
      .insert(staticDeploys)
      .values({ siteId: A.id, targetId: targets[`${A.id}:netlify`], provider: 'netlify', kind: 'deploy', generation: report.generation, revision: report.revision, marker: 'heopress-never-sent', status: 'uploading', startedAt: new Date(NOW - 60 * 60_000) })
      .returning();
    const done = await deployer().runPending();
    expect(done.find((d) => d.id === stuck!.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('confirmation was lost') });
    const retry = (await deploys()).find((d) => d.status === 'requested' && d.generation === report.generation);
    expect(retry).toBeDefined();
    providers.netlify.mode = 'ok';
    await deployer().runPending();
    expect((await db.select().from(staticDeploys).where(and(eq(staticDeploys.id, retry!.id))))[0]!.status).toBe('succeeded');
  });

  it('the view: target, revisions, rollback candidate and the support matrix', async () => {
    const view = await staticSiteView(db, A.id);
    expect(view).toMatchObject({ enabled: true, theme: 'official:starter', platform: 'netlify', deployTargetId: targets[`${A.id}:netlify`] });
    expect(view.support.vercel.search.support).toBe('no');
    expect(view.rollbackCandidate).not.toBeNull();
    expect(JSON.stringify(view.deploys)).not.toMatch(/marker|token/i);
    await expect(configureStaticSite(db, A.id, { enabled: true, deployTargetId: targets[`${B.id}:netlify`] })).rejects.toThrow(/not found/);
  });
});
