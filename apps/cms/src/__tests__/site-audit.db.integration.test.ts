import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { auditIssues, auditSites, items as itemsTable, publicAlternates, publicItems, publicSites, redirects, routeTombstones, siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import { EventConsumerRunner, type EventConsumerDefinition } from '../modules/events/consumer-runner';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { linkGraphConsumer } from '../services/site-network/link-graph';
import { SeoSettingsService } from '../services/site-network/seo-settings-service';
import { SchemaService } from '../services/schema-service';
import { auditViewOf, processSiteAudits, requestSiteAudit, runSiteAudit, scheduleSiteAudits } from '../services/site-network/site-audit';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * The site audit (HeoPress P07 task 5.1; spec seo/site-audit "带稳定编号的审计规则"): each rule finds its problem and
 * not its absence; a problem fixed is gone at the next run, and a site with everything fixed has an empty list; two sites
 * apart; the worker runs what was asked for.
 */

const A = 'site_p07_audit_a';
const B = 'site_p07_audit_b';
const HOST_A = 'audit-a.example.com';
const HOST_B = 'audit-b.example.com';

describe.skipIf(!hasDbIntegrationUrl)('site audit — DB integration', () => {
  let db: Database;
  let consumer: EventConsumerDefinition;

  beforeAll(async () => {
    db = await connectDbIntegration('site-audit');
  });
  afterAll(async () => {
    await db?.delete(sites).where(inArray(sites.id, [A, B]));
  });
  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [A, B]));
    await db.insert(sites).values([
      { id: A, name: 'Audit A', defaultLanguage: 'en' },
      { id: B, name: 'Audit B', defaultLanguage: 'en' },
    ]);
    for (const id of [A, B]) await upgradeSitePreset(db, id);
    await db.insert(siteDomains).values([
      { siteId: A, hostname: HOST_A, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
      { siteId: B, hostname: HOST_B, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
    ]);
    for (const id of [A, B]) {
      const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, id));
      await new ContentSettingsService({ db, siteId: id, actor: { userId: null } }).update({
        availableLocales: r!.availableLocales, timezone: r!.timezone, siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
        localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: { articles: '/:slug', pages: '/:slug' },
        allowCrossSiteTranslations: false, sponsorDisclosure: true, sponsorRel: true, version: r!.version,
      } as never);
      await rebuildSiteProjection(db, id);
    }
    consumer = { ...linkGraphConsumer({ db }), name: `audit-links-it-${randomBytes(4).toString('hex')}` };
    await new EventConsumerRunner(db).register(consumer);
  });

  const items = (siteId: string) => new ItemService({ db, siteId });
  const article = (siteId: string, slug: string, data: Record<string, unknown> = {}) =>
    items(siteId).create('articles', { data: { title: `Title ${slug}`, slug, locale: 'en', excerpt: `Excerpt of ${slug}.`, body: `<p>Body of ${slug}.</p>`, ...data }, status: 'published' }) as Promise<{ id: string }>;
  const version = async (id: string) => (await db.select({ v: itemsTable.version }).from(itemsTable).where(eq(itemsTable.id, id)))[0]!.v;
  const patch = async (siteId: string, id: string, data: Record<string, unknown>) => items(siteId).patch('articles', id, { data, expectedVersion: await version(id) });
  const audit = async (siteId: string) => {
    await new EventConsumerRunner(db).runOnce(consumer);
    await runSiteAudit(db, siteId);
    return runSiteTransaction(db, siteId, (tx) => tx.select().from(auditIssues).where(eq(auditIssues.siteId, siteId)));
  };
  const rulesOf = (rows: Array<{ rule: string }>) => rows.map((r) => r.rule).sort();
  /** Set a public row's field as the projection holds it (content the sanitiser or the editor rarely produces). */
  const project = (siteId: string, itemId: string, set: Record<string, unknown>) =>
    runSiteTransaction(db, siteId, (tx) => tx.update(publicItems).set(set).where(and(eq(publicItems.siteId, siteId), eq(publicItems.itemId, itemId))));

  it('a site with nothing wrong has no issues', async () => {
    await article(A, 'one');
    await article(A, 'two', { body: '<p><a href="/one/">one</a></p>' });
    expect(await audit(A)).toEqual([]);
  });

  it('duplicate titles and descriptions list the pages; fixed, gone — and the list is empty again', async () => {
    const one = await article(A, 'dup-1', { title: 'Same title', excerpt: 'Same words.' });
    const two = await article(A, 'dup-2', { title: 'Same  TITLE', excerpt: 'Same words.' });
    // Not indexed: not a duplicate.
    await article(A, 'dup-3', { title: 'Same title', seo_robots: 'noindex,follow' });
    const rows = await audit(A);
    expect(rulesOf(rows)).toEqual(['meta/duplicate-description', 'meta/duplicate-title']);
    const title = rows.find((r) => r.rule === 'meta/duplicate-title')!;
    expect(title.severity).toBe('warning');
    expect([...title.itemIds].sort()).toEqual([one.id, two.id].sort());
    expect((title.evidence.pages as Array<{ url: string }>).map((p) => p.url).sort()).toEqual([`https://${HOST_A}/dup-1/`, `https://${HOST_A}/dup-2/`]);
    // The same problem keeps its row across runs.
    expect((await audit(A)).find((r) => r.rule === 'meta/duplicate-title')!.id).toBe(title.id);
    await patch(A, two.id, { title: 'Another title', excerpt: 'Other words.' });
    expect(await audit(A)).toEqual([]);
  });

  it('duplicate canonical: pages naming one address that is none of them; a page canonical to another page is not', async () => {
    await article(A, 'c1', { canonical_url: 'https://example.org/original/' });
    await article(A, 'c2', { canonical_url: 'https://example.org/original/' });
    expect(rulesOf(await audit(A))).toEqual(['meta/duplicate-canonical']);
    await article(A, 'c3', { canonical_url: `https://${HOST_A}/c4/` });
    const c4 = await article(A, 'c4', { canonical_url: `https://${HOST_A}/c4/` });
    expect(rulesOf(await audit(A))).toEqual(['meta/duplicate-canonical']);
    // Fixed: one of the two names another address — gone.
    const c2 = (await runSiteTransaction(db, A, (tx) => tx.select({ id: publicItems.itemId }).from(publicItems).where(and(eq(publicItems.siteId, A), eq(publicItems.path, '/c2')))))[0]!.id;
    await patch(A, c2, { canonical_url: `https://${HOST_A}/c4/` });
    expect(await audit(A)).toEqual([]);
    void c4;
  });

  it('descriptions as the head says them: a description template that leaves the description out makes them the same', async () => {
    await article(A, 'd1', { excerpt: 'First.' });
    await article(A, 'd2', { excerpt: 'Second.' });
    expect(await audit(A)).toEqual([]);
    const seo = new SeoSettingsService({ db, siteId: A, actor: { userId: null } });
    const { settings, version: v } = await seo.get();
    await seo.update({ ...settings, version: v, descriptionTemplate: 'Read on {site}.' });
    expect(rulesOf(await audit(A))).toEqual(['meta/duplicate-description']);
  });

  it('broken links and broken anchors; fixed, gone', async () => {
    // Published rich text keeps no ids (the sanitiser): an anchor exists only where the projection holds one — set here.
    const target = await article(A, 'target', { body: '<p>x</p>' });
    await project(A, target.id, { data: sql`${publicItems.data} || ${JSON.stringify({ body: '<h2 id="present">Part</h2><p>x</p>' })}::jsonb` });
    const src = await article(A, 'src', { body: '<p><a href="/nowhere/">a</a> <a href="/target/#missing">b</a> <a href="/target/#present">c</a> <a href="/target/#top">d</a></p>' });
    const rows = await audit(A);
    expect(rulesOf(rows)).toEqual(['links/broken', 'links/broken-anchor']);
    const anchor = rows.find((r) => r.rule === 'links/broken-anchor')!;
    expect(anchor.evidence).toMatchObject({ href: '/target/#missing', fragment: 'missing' });
    expect(anchor.itemIds).toEqual([src.id, target.id]);
    expect(rows.find((r) => r.rule === 'links/broken')!.evidence).toMatchObject({ href: '/nowhere/', reason: 'missing' });
    await patch(A, src.id, { body: '<p><a href="/target/#present">c</a> <a href="/target/#TOP">d</a></p>' });
    expect(await audit(A)).toEqual([]);
  });

  it('hreflang: a page listing a translation that does not list it back', async () => {
    const en = await article(A, 'hl-en');
    const other = await article(A, 'hl-other');
    await runSiteTransaction(db, A, (tx) =>
      tx.insert(publicAlternates).values({ siteId: A, itemId: en.id, locale: 'fr', url: `https://${HOST_A}/hl-other/`, targetItemId: other.id }),
    );
    const rows = await audit(A);
    expect(rulesOf(rows)).toEqual(['hreflang/missing-return']);
    expect(rows[0]!.severity).toBe('error');
    expect(rows[0]!.itemIds).toEqual([en.id, other.id]);
    await runSiteTransaction(db, A, (tx) =>
      tx.insert(publicAlternates).values({ siteId: A, itemId: other.id, locale: 'en', url: `https://${HOST_A}/hl-en/`, targetItemId: en.id }),
    );
    expect(await audit(A)).toEqual([]);
  });

  it('structured data left out of a page or of the site; Markdown copies that differ or whose address is taken — each fixed, gone', async () => {
    const j = await article(A, 'jsonld');
    await project(A, j.id, { structured: { diagnostics: [{ code: 'invalid', message: 'x' }] } });
    const m = await article(A, 'clip');
    await project(A, m.id, { data: sql`${publicItems.data} || ${JSON.stringify({ body: '<p>Watch</p><iframe src="https://example.org/v"></iframe>' })}::jsonb` });
    await article(A, 'taken');
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', fromPath: '/taken.md', toPath: '/jsonld', source: 'manual' }));
    await runSiteTransaction(db, A, (tx) => tx.update(publicSites).set({ structured: { diagnostics: [{ code: 'invalid', source: 'extension:x', message: 'y' }] } }).where(eq(publicSites.siteId, A)));
    const rows = await audit(A);
    expect(rulesOf(rows)).toEqual(['jsonld/invalid', 'jsonld/site-invalid', 'markdown/address-taken', 'markdown/inconsistent']);
    expect(rows.find((r) => r.rule === 'jsonld/site-invalid')!).toMatchObject({ adminOnly: true, itemIds: [] });
    expect(rows.find((r) => r.rule === 'markdown/inconsistent')!.evidence).toMatchObject({ opaque: ['iframe'] });
    expect(rows.find((r) => r.rule === 'markdown/address-taken')!.evidence).toMatchObject({ copy: `https://${HOST_A}/taken.md`, answeredBy: 'redirect' });
    // Fixed one by one: the list empties.
    await project(A, j.id, { structured: {} });
    await project(A, m.id, { data: sql`${publicItems.data} || ${JSON.stringify({ body: '<p>Watch</p>' })}::jsonb` });
    await runSiteTransaction(db, A, (tx) => tx.delete(redirects).where(and(eq(redirects.siteId, A), eq(redirects.fromPath, '/taken.md'))));
    await runSiteTransaction(db, A, (tx) => tx.update(publicSites).set({ structured: {} }).where(eq(publicSites.siteId, A)));
    expect(await audit(A)).toEqual([]);
  });

  it('Codex review of batch 10b, round 1: a copy taken by a prefix redirect or a deleted page; an anchor behind a redirect; titles as the head says them', async () => {
    // A prefix redirect over a section takes its pages' copies (the pages themselves are served first).
    const [cs] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, A));
    await new ContentSettingsService({ db, siteId: A, actor: { userId: null } }).update({
      availableLocales: cs!.availableLocales, timezone: cs!.timezone, siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
      localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: { articles: '/:slug', pages: '/docs/:slug' },
      allowCrossSiteTranslations: false, sponsorDisclosure: true, sponsorRel: true, version: cs!.version,
    } as never);
    await items(A).create('pages', { data: { title: 'Intro', slug: 'intro', locale: 'en', excerpt: 'Intro page.', body: '<p>Intro.</p>' }, status: 'published' });
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', fromPath: '/docs', match: 'prefix', toPath: '/archive', source: 'manual' }));
    // A deleted page's 410 at a copy's address.
    await article(A, 'tomb');
    await runSiteTransaction(db, A, (tx) => tx.insert(routeTombstones).values({ siteId: A, locale: 'en', path: '/tomb.md', itemId: 'deleted-item' }));
    // A fragment behind a redirect, checked at the page the redirect leads to.
    const target = await article(A, 'anchor-new');
    await project(A, target.id, { data: sql`${publicItems.data} || ${JSON.stringify({ body: '<h2 id="present">x</h2>' })}::jsonb` });
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', fromPath: '/anchor-old', toPath: '/anchor-new', source: 'manual' }));
    await article(A, 'anchor-src', { body: '<p><a href="/anchor-old/#missing">a</a> <a href="/anchor-old/#present">b</a></p>' });
    const rows = await audit(A);
    const taken = rows.filter((r) => r.rule === 'markdown/address-taken').map((r) => r.evidence as { copy: string; answeredBy: string });
    expect(taken.map((t) => [t.copy, t.answeredBy]).sort()).toEqual([
      [`https://${HOST_A}/docs/intro.md`, 'redirect'],
      [`https://${HOST_A}/tomb.md`, 'gone'],
    ]);
    const anchors = rows.filter((r) => r.rule === 'links/broken-anchor');
    expect(anchors.map((r) => (r.evidence as { href: string }).href)).toEqual(['/anchor-old/#missing']);
    expect(anchors[0]!.itemIds[1]).toBe(target.id);
    // A title template that leaves the page's title out: every page's title is the same — duplicates, as the head says.
    const seo = new SeoSettingsService({ db, siteId: A, actor: { userId: null } });
    const { settings, version: v } = await seo.get();
    await seo.update({ ...settings, version: v, titleTemplate: 'Audit A' });
    expect(rulesOf(await audit(A))).toContain('meta/duplicate-title');
  });

  it('Codex review of batch 10b, round 3: a run taken over after its last renewal is refused at the write; the renderer\'s reading of titles and descriptions', async () => {
    await article(A, 'w1', { title: 'Twin' });
    await article(A, 'w2', { title: 'Twin' });
    await new EventConsumerRunner(db).runOnce(consumer);
    await db.delete(auditSites).where(eq(auditSites.siteId, A));
    await db.insert(auditSites).values({ siteId: A, requestedAt: new Date(), leaseToken: 'worker-a', leasedUntil: new Date(Date.now() + 60_000), status: 'running' });
    // Worker A passes every renewal; B takes over just before A writes.
    const result = await runSiteAudit(db, A, {
      token: 'worker-a',
      requestedAt: new Date(0),
      beforeWrite: async () => {
        await db.update(auditSites).set({ leaseToken: 'worker-b' }).where(eq(auditSites.siteId, A));
      },
    });
    expect(result).toBeNull();
    expect(await runSiteTransaction(db, A, (tx) => tx.select().from(auditIssues).where(eq(auditIssues.siteId, A)))).toEqual([]);
    expect((await db.select().from(auditSites).where(eq(auditSites.siteId, A)))[0]).toMatchObject({ leaseToken: 'worker-b', status: 'running' });
    await db.update(auditSites).set({ leaseToken: null, leasedUntil: null }).where(eq(auditSites.siteId, A));
    await patch(A, (await runSiteTransaction(db, A, (tx) => tx.select({ id: publicItems.itemId }).from(publicItems).where(and(eq(publicItems.siteId, A), eq(publicItems.path, '/w2')))))[0]!.id, { title: 'Other' });

    // Titles are text: `<code>` and `<em>` are different titles.
    await article(A, 'tag-1', { title: 'Use <code> tags' });
    await article(A, 'tag-2', { title: 'Use <em> tags' });
    // A rich SEO description that is only whitespace: the excerpt is the description (the same excerpt: duplicates).
    await new SchemaService({ db, siteId: A }).updateField('articles', 'seo_description', { interface: 'wysiwyg' });
    await article(A, 'rich-1', { seo_description: '<p> </p>', excerpt: 'Shared words.' });
    await article(A, 'rich-2', { seo_description: '<p>&nbsp;</p>', excerpt: 'Shared words.' });
    // (After the schema change, which rebuilds the articles' public rows.)
    // A number where a title is expected is no title (the renderer falls back to the name, then the slug).
    const n = await article(A, 'num-title', { title: 'Alpha' });
    await project(A, n.id, { data: sql`${publicItems.data} || '{"seo_title": 123}'::jsonb` });
    const o = await article(A, 'num-other', { title: 'Beta' });
    await project(A, o.id, { data: sql`${publicItems.data} || '{"seo_title": "123"}'::jsonb` });
    const rows = await audit(A);
    expect(rulesOf(rows)).toEqual(['meta/duplicate-description']);
    expect((rows[0]!.evidence as { value: string }).value).toContain('Shared words.');
  });

  it('a run that lost its lease keeps nothing and leaves its successor alone', async () => {
    await article(A, 'lease-1', { title: 'Twin' });
    await article(A, 'lease-2', { title: 'Twin' });
    await new EventConsumerRunner(db).runOnce(consumer);
    await db.delete(auditSites).where(eq(auditSites.siteId, A));
    // Worker A's lease ran out; worker B takes the site over and finishes.
    await db.insert(auditSites).values({ siteId: A, requestedAt: new Date(), leaseToken: 'worker-a', leasedUntil: new Date(Date.now() - 1000), status: 'running' });
    const b = await processSiteAudits(db);
    expect(b.find((r) => r.siteId === A)?.status).toBe('done');
    const after = (await db.select().from(auditSites).where(eq(auditSites.siteId, A)))[0]!;
    expect(after).toMatchObject({ status: 'done', leaseToken: null, requestedAt: null, issues: 1 });
    // A late, with its old token: nothing written, nothing of B's changed.
    await requestSiteAudit(db, A);
    const before = await runSiteTransaction(db, A, (tx) => tx.select().from(auditIssues).where(eq(auditIssues.siteId, A)));
    await patch(A, (await runSiteTransaction(db, A, (tx) => tx.select({ id: publicItems.itemId }).from(publicItems).where(and(eq(publicItems.siteId, A), eq(publicItems.path, '/lease-2')))))[0]!.id, { title: 'Single' });
    await new EventConsumerRunner(db).runOnce(consumer);
    expect(await runSiteAudit(db, A, { token: 'worker-a', requestedAt: new Date(0) })).toBeNull();
    expect(await runSiteTransaction(db, A, (tx) => tx.select().from(auditIssues).where(eq(auditIssues.siteId, A)))).toEqual(before);
    expect((await db.select().from(auditSites).where(eq(auditSites.siteId, A)))[0]!.requestedAt).not.toBeNull();
  });

  it('two sites apart; the worker runs what was asked for, once; the daily check asks for sites never audited', async () => {
    await article(A, 'a-dup', { title: 'Twin' });
    await article(A, 'a-dup-2', { title: 'Twin' });
    await article(B, 'b-dup', { title: 'Twin' });
    await new EventConsumerRunner(db).runOnce(consumer);
    await db.delete(auditSites).where(inArray(auditSites.siteId, [A, B]));
    await requestSiteAudit(db, A);
    const ran = await processSiteAudits(db);
    expect(ran.filter((r) => [A, B].includes(r.siteId))).toEqual([{ siteId: A, status: 'done' }]);
    expect((await db.select().from(auditSites).where(eq(auditSites.siteId, A)))[0]).toMatchObject({ requestedAt: null, status: 'done', issues: 1 });
    expect(await runSiteTransaction(db, B, (tx) => tx.select().from(auditIssues).where(eq(auditIssues.siteId, B)))).toEqual([]);
    // Only A's are visible in A's scope, whatever is asked.
    expect((await runSiteTransaction(db, A, (tx) => tx.select({ siteId: auditIssues.siteId }).from(auditIssues))).every((r) => r.siteId === A)).toBe(true);
    await scheduleSiteAudits(db);
    expect((await db.select().from(auditSites).where(eq(auditSites.siteId, B)))[0]?.requestedAt).not.toBeNull();
    const view = await auditViewOf(db, A, { readable: () => sql`true`, admin: false });
    expect(view.total).toBe(1);
    expect(view.issues[0]).toMatchObject({ rule: 'meta/duplicate-title', title: 'Duplicate title' });
    expect(view.rules.map((r) => r.id)).toContain('links/broken');
  });
});
