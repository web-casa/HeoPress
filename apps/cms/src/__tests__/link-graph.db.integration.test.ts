import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { items as itemsTable, linkEdges, linkScans, publicItems, redirects, siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import { EventConsumerRunner, type EventConsumerDefinition } from '../modules/events/consumer-runner';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { addManualLink, deleteManualLink, linkGraphConsumer, LinkGraphError, processLinkScans, refreshItemLinks, requestLinkScan, scheduleLinkScans } from '../services/site-network/link-graph';
import { linkReport } from '../services/site-network/link-report';
import { readableScope } from '../services/site-network/readable-items';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * The internal link graph and its reports (HeoPress P07 tasks 5.3, 5.4; spec seo/link-graph): edges from public items
 * only, refreshed per item by the change events; a full scan in batches that goes on after a failure and cleans up only
 * once finished; broken links by why, orphan pages with their other ways in; two sites apart.
 */

const A = 'site_p07_links_a';
const B = 'site_p07_links_b';
const HOST_A = 'links-a.example.com';
const ALIAS_A = 'www.links-a.example.com';
const HOST_B = 'links-b.example.com';

const everything = { readable: () => sql`true`, navigation: true };

describe.skipIf(!hasDbIntegrationUrl)('link graph — DB integration', () => {
  let db: Database;
  let consumer: EventConsumerDefinition;

  beforeAll(async () => {
    db = await connectDbIntegration('link-graph');
  });
  afterAll(async () => {
    await db?.delete(sites).where(inArray(sites.id, [A, B]));
  });
  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [A, B]));
    await db.insert(sites).values([
      { id: A, name: 'Links A', defaultLanguage: 'en' },
      { id: B, name: 'Links B', defaultLanguage: 'en' },
    ]);
    for (const id of [A, B]) await upgradeSitePreset(db, id);
    await db.insert(siteDomains).values([
      { siteId: A, hostname: HOST_A, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() },
      { siteId: A, hostname: ALIAS_A, kind: 'custom', status: 'active', isPrimary: false, verifiedAt: new Date() },
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
    // This suite's own consumer, from the head of the change events.
    consumer = { ...linkGraphConsumer({ db }), name: `link-graph-it-${randomBytes(4).toString('hex')}` };
    await new EventConsumerRunner(db).register(consumer);
  });

  const items = (siteId: string) => new ItemService({ db, siteId });
  const article = (siteId: string, slug: string, body: string, status = 'published') =>
    items(siteId).create('articles', { data: { title: `Title ${slug}`, slug, locale: 'en', body }, status }) as Promise<{ id: string }>;
  const page = (siteId: string, slug: string, body: string) =>
    items(siteId).create('pages', { data: { title: `Page ${slug}`, slug, locale: 'en', body }, status: 'published' }) as Promise<{ id: string }>;
  const version = async (id: string) => (await db.select({ v: itemsTable.version }).from(itemsTable).where(eq(itemsTable.id, id)))[0]!.v;
  const patch = async (siteId: string, collection: string, id: string, data: Record<string, unknown>) =>
    items(siteId).patch(collection, id, { ...data, expectedVersion: await version(id) });
  const consume = () => new EventConsumerRunner(db).runOnce(consumer);
  const edgesOf = (siteId: string, sourceItemId?: string) =>
    runSiteTransaction(db, siteId, (tx) =>
      tx
        .select()
        .from(linkEdges)
        .where(and(eq(linkEdges.siteId, siteId), sourceItemId ? eq(linkEdges.sourceItemId, sourceItemId) : undefined))
        .orderBy(linkEdges.sourceItemId, linkEdges.field, linkEdges.position),
    );
  const report = (siteId: string) => linkReport(db, siteId, everything);
  /** Every running scan, as far as it goes (a failed one is due again at once). */
  const scanAll = async (opts: Parameters<typeof processLinkScans>[1] = {}) => {
    await db.update(linkScans).set({ retryAt: null }).where(inArray(linkScans.siteId, [A, B]));
    return processLinkScans(db, opts);
  };

  it('a public item\'s internal links are recorded with where they are and where they point; external, mail and draft links are not', async () => {
    const target = await article(A, 'target', '<p>Target.</p>');
    const source = await article(
      A,
      'source',
      [
        '<p><a href="/target/#part">relative</a> <a href="https://links-a.example.com/target/">absolute</a></p>',
        `<p><a href="https://${ALIAS_A}/target/">alias</a> <a href="https://example.org/x/">external</a> <a href="mailto:a@example.com">mail</a></p>`,
      ].join(''),
    );
    const draft = await article(A, 'draft', `<p><a href="/target/">from a draft</a></p>`, 'draft');
    await consume();
    const edges = await edgesOf(A);
    expect(edges.map((e) => [e.sourceItemId, e.href, e.targetLocale, e.targetPath, e.fragment, e.anchorText, e.field, e.position])).toEqual([
      [source.id, '/target/#part', 'en', '/target', 'part', 'relative', 'body', 0],
      [source.id, 'https://links-a.example.com/target/', 'en', '/target', null, 'absolute', 'body', 1],
      [source.id, `https://${ALIAS_A}/target/`, 'en', '/target', null, 'alias', 'body', 2],
    ]);
    expect(edges.every((e) => e.origin === 'auto')).toBe(true);
    // The draft's link is not in the graph: the target's only way in is the source.
    expect(edges.some((e) => e.sourceItemId === draft.id)).toBe(false);
    const r = await report(A);
    expect(r.orphans.map((o) => o.itemId)).not.toContain(target.id);
    expect(r.orphans.map((o) => o.itemId)).toContain(source.id);
    expect(r.broken).toEqual([]);
    // Published, the draft's link counts.
    await patch(A, 'articles', draft.id, { status: 'published' });
    await consume();
    expect((await edgesOf(A, draft.id)).map((e) => e.targetPath)).toEqual(['/target']);
  });

  it('a change refreshes that item\'s edges only; an item no longer public loses its own', async () => {
    const one = await article(A, 'one', '<p><a href="/two/">two</a></p>');
    const two = await article(A, 'two', '<p><a href="/one/">one</a></p>');
    await consume();
    const before = (await edgesOf(A, two.id)).map((e) => e.id);
    await patch(A, 'articles', one.id, { data: { body: '<p><a href="/two/">two</a> <a href="/three/">three</a></p>' } });
    await consume();
    expect((await edgesOf(A, one.id)).map((e) => e.targetPath)).toEqual(['/two', '/three']);
    expect((await edgesOf(A, two.id)).map((e) => e.id)).toEqual(before);
    await patch(A, 'articles', one.id, { status: 'draft' });
    await consume();
    expect(await edgesOf(A, one.id)).toEqual([]);
  });

  it('broken links say why — unpublished, deleted, missing — with the source to edit; the site\'s own pages, files and redirects are fine', async () => {
    const gone = await article(A, 'gone', '<p>Gone soon.</p>');
    const hidden = await article(A, 'hidden', '<p>Hidden soon.</p>');
    const moved = await article(A, 'moved', '<p>Moved soon.</p>');
    const source = await article(
      A,
      'links',
      [
        '<p><a href="/gone/">gone</a> <a href="/hidden/">hidden</a> <a href="/nowhere/">nowhere</a></p>',
        '<p><a href="/">home</a> <a href="/search">search</a> <a href="/feed.xml">feed</a> <a href="/moved/">moved</a></p>',
      ].join(''),
    );
    await consume();
    expect((await report(A)).broken.map((b) => b.href)).toEqual(['/nowhere/']);
    await items(A).softDelete('articles', gone.id);
    await patch(A, 'articles', hidden.id, { status: 'draft' });
    // A new slug: the old address redirects (the item's former path).
    await patch(A, 'articles', moved.id, { data: { slug: 'moved-here' } });
    await consume();
    const r = await report(A);
    expect(r.broken.map((b) => [b.href, b.reason])).toEqual([
      ['/gone/', 'deleted'],
      ['/hidden/', 'unpublished'],
      ['/nowhere/', 'missing'],
    ]);
    expect(r.broken[0]!.source).toEqual({ kind: 'item', itemId: source.id, collection: 'articles', title: 'Title links', url: `https://${HOST_A}/links/` });
    expect(r.brokenTotal).toBe(3);
    expect(r.unchecked).toBe(0);
    // The moved article is reached through its redirect: not an orphan.
    expect(r.orphans.map((o) => o.itemId)).not.toContain(moved.id);
  });

  it('orphans: no other page links to them; lists and registered navigation are said apart', async () => {
    const lonely = await page(A, 'lonely', '<p>Nobody links here.</p>');
    const nav = await page(A, 'about', '<p>In the menu.</p>');
    const self = await article(A, 'self', '<p><a href="/self/">me</a></p>');
    await consume();
    await addManualLink(db, A, { label: 'Header menu', url: `https://${HOST_A}/about/` }, null);
    const r = await report(A);
    const byId = new Map(r.orphans.map((o) => [o.itemId, o]));
    expect(byId.get(lonely.id)).toMatchObject({ listing: false, navigation: 0, collection: 'pages' });
    expect(byId.get(nav.id)).toMatchObject({ listing: false, navigation: 1 });
    // A link to itself does not count; an article is on the lists.
    expect(byId.get(self.id)).toMatchObject({ listing: true, navigation: 0 });
    // Registered links: on the site's own hosts only; removed by id.
    await expect(addManualLink(db, A, { label: 'Elsewhere', url: 'https://example.org/' }, null)).rejects.toThrow(LinkGraphError);
    await expect(addManualLink(db, A, { label: ' ', url: `https://${HOST_A}/` }, null)).rejects.toThrow(LinkGraphError);
    const [manual] = (await edgesOf(A)).filter((e) => e.origin === 'manual');
    await expect(deleteManualLink(db, B, manual!.id)).rejects.toThrow(LinkGraphError);
    await deleteManualLink(db, A, manual!.id);
    expect((await report(A)).orphans.find((o) => o.itemId === nav.id)?.navigation).toBe(0);
  });

  it('a full scan goes in batches; a failure keeps the graph and the cursor, the next run goes on from there; only a finished scan cleans up', async () => {
    const made: string[] = [];
    for (let i = 0; i < 5; i++) made.push((await article(A, `s${i}`, `<p><a href="/s${(i + 1) % 5}/">next</a></p>`)).id);
    await consume();
    // A stale edge of an item no longer public (as if its event were lost): kept until a scan finishes.
    await runSiteTransaction(db, A, (tx) =>
      tx.insert(linkEdges).values({ siteId: A, origin: 'auto', sourceItemId: 'gone-item', href: '/s0/', targetUrl: `https://${HOST_A}/s0/`, targetLocale: 'en', targetPath: '/s0' }),
    );
    await requestLinkScan(db, A);
    const seen: string[][] = [];
    let fail = true;
    const results = await scanAll({
      batchSize: 2,
      beforeBatch: (siteId, ids) => {
        if (siteId === A) {
          seen.push(ids);
          if (seen.length === 2 && fail) throw new Error('interrupted');
        }
      },
    });
    expect(results.find((r) => r.siteId === A)).toMatchObject({ status: 'failed', processed: 2, error: 'interrupted' });
    const [mid] = await db.select().from(linkScans).where(eq(linkScans.siteId, A));
    expect(mid).toMatchObject({ status: 'running', cursor: seen[0]![1], processed: 2, attempts: 1, lastError: 'interrupted' });
    expect(mid!.retryAt!.getTime()).toBeGreaterThan(Date.now());
    // Nothing removed: the stale edge and every item's edges are there.
    expect((await edgesOf(A, 'gone-item')).length).toBe(1);
    expect((await edgesOf(A)).filter((e) => made.includes(e.sourceItemId!)).length).toBe(5);
    // Not due before its retry time.
    expect((await processLinkScans(db)).find((r) => r.siteId === A)).toBeUndefined();
    fail = false;
    const again = await scanAll({ batchSize: 2, beforeBatch: (siteId, ids) => void (siteId === A && seen.push(ids)) });
    expect(again.find((r) => r.siteId === A)).toMatchObject({ status: 'done' });
    // Went on after the cursor (the failed batch again, then the rest), never from the start.
    expect(seen[2]).toEqual(seen[1]);
    expect(seen.slice(2).flat().some((id) => seen[0]!.includes(id))).toBe(false);
    const [done] = await db.select().from(linkScans).where(eq(linkScans.siteId, A));
    expect(done).toMatchObject({ status: 'done', attempts: 0, lastError: null, leaseToken: null });
    expect(await edgesOf(A, 'gone-item')).toEqual([]);
    expect((await edgesOf(A)).filter((e) => made.includes(e.sourceItemId!)).length).toBe(5);
  });

  it('a scan asked for while one runs runs again once finished; the daily check asks for sites never scanned', async () => {
    await article(A, 'x', '<p><a href="/y/">y</a></p>');
    await requestLinkScan(db, A);
    await requestLinkScan(db, A);
    expect((await db.select().from(linkScans).where(eq(linkScans.siteId, A)))[0]!.rerun).toBe(true);
    await scanAll();
    expect((await db.select().from(linkScans).where(eq(linkScans.siteId, A)))[0]).toMatchObject({ status: 'done', rerun: false });
    await db.delete(linkScans).where(eq(linkScans.siteId, B));
    await scheduleLinkScans(db);
    expect((await db.select().from(linkScans).where(eq(linkScans.siteId, B)))[0]?.status).toBe('running');
    // A site's change of URL policy asks for one too (through its event).
    await scanAll();
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, A));
    await new ContentSettingsService({ db, siteId: A, actor: { userId: null } }).update({
      availableLocales: r!.availableLocales, timezone: r!.timezone, siteType: 'blog', trailingSlash: 'never', localeStrategy: 'subdirectory',
      localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: { articles: '/:slug', pages: '/:slug' },
      allowCrossSiteTranslations: false, sponsorDisclosure: true, sponsorRel: true, version: r!.version,
    } as never);
    await consume();
    expect((await db.select().from(linkScans).where(eq(linkScans.siteId, A)))[0]?.status).toBe('running');
  });

  it('what a principal may read, as SQL: none without a grant, the rule\'s rows with a row rule, all with an unrestricted one or as an administrator', async () => {
    const one = await article(A, 'readable-one', '<p>One.</p>');
    const two = await article(A, 'readable-two', '<p>Two.</p>');
    const aPage = await page(A, 'readable-page', '<p>Page.</p>');
    const visible = async (permissions: unknown) => {
      const scope = await readableScope(db, A, permissions as never);
      const rows = await runSiteTransaction(db, A, (tx) =>
        tx.select({ id: publicItems.itemId }).from(publicItems).where(and(eq(publicItems.siteId, A), scope(sql`${publicItems.itemId}`, sql`${publicItems.collection}`))),
      );
      return rows.map((r) => r.id).filter((id) => [one.id, two.id, aPage.id].includes(id)).sort();
    };
    const grant = (collection: string) => ({ collection, action: 'read' }) as never;
    const ruled = {
      bundle: async () => ({ admin: false }),
      canAccess: async (collection: string) => (collection === 'articles' || collection === 'pages' ? grant(collection) : null),
      // Articles: a row rule (only the first one's id); pages: unrestricted.
      whereFor: (perm: { collection: string }) => (perm.collection === 'articles' ? sql`${itemsTable.id} = ${one.id}` : undefined),
    };
    expect(await visible(ruled)).toEqual([one.id, aPage.id].sort());
    expect(await visible({ bundle: async () => ({ admin: false }), canAccess: async () => null, whereFor: () => undefined })).toEqual([]);
    expect(await visible({ bundle: async () => ({ admin: true }), canAccess: async () => null, whereFor: () => undefined })).toEqual([one.id, two.id, aPage.id].sort());
  });

  it('Codex review of batch 10, round 2: what a member cannot see takes no place of its own broken links; "scan now" ends a back-off', async () => {
    await article(A, 'mine', '<p><a href="/zz-missing/">missing</a></p>');
    for (const n of ['a1', 'a2', 'a3']) await addManualLink(db, A, { label: `Nav ${n}`, url: `https://${HOST_A}/${n}-missing/` }, null);
    await consume();
    // Room to resolve two addresses: the registered links (sorted first) are not the member's, so its own link is checked.
    const member = await linkReport(db, A, { readable: () => sql`true`, navigation: false, limits: { resolve: 2 } });
    expect(member.broken.map((b) => b.href)).toEqual(['/zz-missing/']);
    expect(member.unchecked).toBe(0);
    // A failed scan waiting out its back-off: an event's request leaves it waiting; an administrator's makes it due.
    await requestLinkScan(db, A);
    await db.update(linkScans).set({ retryAt: new Date(Date.now() + 3_600_000), attempts: 3, lastError: 'boom' }).where(eq(linkScans.siteId, A));
    await requestLinkScan(db, A);
    expect((await db.select().from(linkScans).where(eq(linkScans.siteId, A)))[0]).toMatchObject({ attempts: 3, lastError: 'boom' });
    await requestLinkScan(db, A, { now: true });
    expect((await db.select().from(linkScans).where(eq(linkScans.siteId, A)))[0]).toMatchObject({ retryAt: null, attempts: 0, lastError: null, status: 'running' });
    expect((await processLinkScans(db)).find((r) => r.siteId === A)?.status).toBe('done');
  });

  it('Codex review of batch 10, round 3: a link to its own old address is a self-link; others see no navigation counts', async () => {
    const a = await article(A, 'self-old', '<p><a href="/self-old-was/">me before</a></p>');
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', fromPath: '/self-old-was', toPath: '/self-old', source: 'manual' }));
    await consume();
    expect((await report(A)).orphans.map((o) => o.itemId)).toContain(a.id);
    // Linked from another page through the same redirect: no longer an orphan.
    await article(A, 'other-src', '<p><a href="/self-old-was/">it</a></p>');
    await consume();
    expect((await report(A)).orphans.map((o) => o.itemId)).not.toContain(a.id);
    // A registered link to a page: its count for administrators only.
    const nav = await page(A, 'nav-only', '<p>x</p>');
    await addManualLink(db, A, { label: 'Menu', url: `https://${HOST_A}/nav-only/` }, null);
    expect((await report(A)).orphans.find((o) => o.itemId === nav.id)?.navigation).toBe(1);
    const member = await linkReport(db, A, { readable: () => sql`true`, navigation: false });
    expect(member.orphans.find((o) => o.itemId === nav.id)?.navigation).toBe(0);
  });

  it('Codex review of batch 10, round 4: many pages linking one old address take one place of the redirect budget', async () => {
    const y = await article(A, 'aaa-y', '<p>y</p>');
    await article(A, 'aab-x', '<p>x</p>');
    for (const [from, to] of [['/aa-old', '/aab-x'], ['/ab-old', '/aaa-y']] as const) {
      await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', fromPath: from, toPath: to, source: 'manual' }));
    }
    for (const n of ['s1', 's2', 's3']) await article(A, n, '<p><a href="/aa-old/">x</a></p>');
    await article(A, 's4', '<p><a href="/ab-old/">y</a></p>');
    await consume();
    const r = await linkReport(db, A, { ...everything, limits: { candidates: 2 } });
    expect(r.orphans.map((o) => o.itemId)).not.toContain(y.id);
  });

  it('a long address is kept whole', async () => {
    const long = `/${'x'.repeat(2100)}/`;
    const one = await article(A, 'long', `<p><a href="${long}">long</a></p>`);
    await consume();
    expect((await edgesOf(A, one.id))[0]!.targetUrl).toBe(`https://${HOST_A}${long}`);
  });

  it('Codex review of batch 10, round 1: broken registered links (administrators only); a redirect to a file is fine; every link recorded; the limits say so', async () => {
    const many = Array.from({ length: 1205 }, (_, i) => `<a href="/t${i}/">${i}</a>`).join(' ');
    const big = await article(A, 'big', `<p>${many}</p>`);
    await article(A, 'dl', '<p><a href="/download/">download</a></p>');
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', fromPath: '/download', toPath: '/feed.xml', source: 'manual' }));
    await consume();
    // Every link of the big page is recorded (no cap).
    expect((await edgesOf(A, big.id)).length).toBe(1205);
    await addManualLink(db, A, { label: 'Footer', url: `https://${HOST_A}/nowhere-nav/` }, null);
    const r = await linkReport(db, A, { ...everything, limits: { resolve: 2000, rows: 5000 } });
    expect(r.broken.filter((b) => b.source.kind === 'navigation').map((b) => [b.source.kind === 'navigation' && b.source.label, b.href, b.reason])).toEqual([
      ['Footer', `https://${HOST_A}/nowhere-nav/`, 'missing'],
    ]);
    // The last of the big page's links is reported too; the redirect to the feed is not broken.
    expect(r.broken.some((b) => b.href === '/t1204/')).toBe(true);
    expect(r.broken.some((b) => b.href === '/download/')).toBe(false);
    expect(r.truncated).toBe(false);
    // With the default limits: more than 1,000 rows to show, more than 500 addresses to resolve — said so.
    expect((await linkReport(db, A, everything)).truncated).toBe(true);
    // Not an administrator: no registered links.
    const member = await linkReport(db, A, { ...everything, navigation: false, limits: { resolve: 2000 } });
    expect(member.broken.some((b) => b.source.kind === 'navigation')).toBe(false);
    // Fewer addresses resolved than there are: the rest are counted as not checked, and said to be.
    const small = await linkReport(db, A, { ...everything, limits: { resolve: 10, rows: 5 } });
    expect(small.unchecked).toBeGreaterThan(1000);
    expect(small.broken.length).toBe(5);
    expect(small.truncated).toBe(true);
   }, 120_000); // Thousands of addresses resolved one by one (slower on CI runners).

  it('concurrent refreshes of one item never duplicate its edges (the item lock)', async () => {
    const one = await article(A, 'busy', '<p><a href="/x/">x</a> <a href="/y/">y</a></p>');
    await Promise.all(Array.from({ length: 8 }, () => runSiteTransaction(db, A, (tx) => refreshItemLinks(tx, A, [one.id]))));
    expect((await edgesOf(A, one.id)).length).toBe(2);
  });

  it('scans take turns: one out of budget waits behind those already waiting; a lost lease is never cleared by its former holder', async () => {
    for (let i = 0; i < 4; i++) await article(A, `turn${i}`, '<p>x</p>');
    await requestLinkScan(db, A);
    await requestLinkScan(db, B);
    // A (the oldest) runs out of budget after a batch.
    const first = await scanAll({ batchSize: 1, budgetMs: 60, beforeBatch: (siteId) => (siteId === A ? new Promise((r) => setTimeout(r, 80)) : undefined) });
    expect(first[0]).toMatchObject({ siteId: A, status: 'partial' });
    const next = await processLinkScans(db, { batchSize: 1 });
    expect(next[0]?.siteId).toBe(B);
    // A lease taken over between batches: the former holder stops ('lost') and leaves the new token alone.
    await requestLinkScan(db, A);
    let stolen = false;
    const lost = await scanAll({
      batchSize: 1,
      afterBatch: async (siteId) => {
        if (siteId === A && !stolen) {
          stolen = true;
          await db.update(linkScans).set({ leaseToken: 'thief', leasedUntil: new Date(Date.now() + 60_000) }).where(eq(linkScans.siteId, A));
        }
      },
    });
    expect(lost.find((r) => r.siteId === A)?.status).toBe('lost');
    expect((await db.select().from(linkScans).where(eq(linkScans.siteId, A)))[0]?.leaseToken).toBe('thief');
  });

  it('two sites: each graph and report holds only its own; a link to the other site is external', async () => {
    await article(A, 'shared', `<p><a href="https://${HOST_B}/shared/">b</a> <a href="/shared/">self</a></p>`);
    await article(B, 'shared', `<p><a href="https://${HOST_A}/shared/">a</a> <a href="/missing/">missing</a></p>`);
    await consume();
    expect((await edgesOf(A)).map((e) => e.href)).toEqual(['/shared/']);
    expect((await edgesOf(B)).map((e) => e.href)).toEqual(['/missing/']);
    expect((await report(A)).broken).toEqual([]);
    expect((await report(B)).broken.map((b) => b.href)).toEqual(['/missing/']);
    // Scans of both: each cleans its own only.
    await requestLinkScan(db, A);
    await requestLinkScan(db, B);
    await scanAll();
    expect((await edgesOf(A)).map((e) => e.href)).toEqual(['/shared/']);
    expect((await edgesOf(B)).map((e) => e.href)).toEqual(['/missing/']);
  });
});
