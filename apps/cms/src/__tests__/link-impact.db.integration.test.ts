import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { items as itemsTable, redirects, siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import { EventConsumerRunner, type EventConsumerDefinition } from '../modules/events/consumer-runner';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { addManualLink, linkGraphConsumer } from '../services/site-network/link-graph';
import { canonicalPath, createImpactRedirect, LinkImpactError, linkImpact, rewriteLinks, updateImpactLinks } from '../services/site-network/link-impact';
import { linkReport } from '../services/site-network/link-report';
import { runSiteTransaction } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Change impact (HeoPress P07 task 5.5; spec seo/link-graph "变更影响预览"): the pages linking to a page (and to an address
 * redirected to it), a second level on request, within the limits; what the caller may see; a redirect from its address,
 * refused when it would loop; its links updated to another address.
 */

const A = 'site_p07_impact_a';
const HOST = 'impact-a.example.com';
const all = { readable: () => sql`true`, navigation: true };
const OWNER_URL = process.env.DATABASE_OWNER_URL?.trim() || undefined;

/** Wait until a session is blocked by the backend `pid` (a deterministic lock wait, never a timer). */
async function blockedBy(pid: number): Promise<void> {
  const watcher = postgres(OWNER_URL!, { max: 1, onnotice: () => {} });
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const [w] = await watcher`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`;
      if ((w?.n ?? 0) >= 1) return;
      if (Date.now() > deadline) throw new Error(`no session blocked by ${pid}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  } finally {
    await watcher.end({ timeout: 1 });
  }
}

const backendOf = async (tx: { execute: (q: ReturnType<typeof sql>) => Promise<unknown> }): Promise<number> =>
  ((await tx.execute(sql`SELECT pg_backend_pid() AS pid`)) as Array<{ pid: number }>)[0]!.pid;

describe('rewriteLinks', () => {
  it('links to one of the addresses point to the new one, fragment kept; others untouched', () => {
    const base = `https://${HOST}/src/`;
    const from = new Set([`https://${HOST}/b/`]);
    const { html, changed } = rewriteLinks('<p><a href="/b/#part">b</a> <a class="x" href=\'https://impact-a.example.com/b/\'>b2</a> <a href="/c/">c</a></p>', base, from, `https://${HOST}/new/?a=1&b=2`);
    expect(changed).toBe(2);
    expect(html).toBe(`<p><a href="https://${HOST}/new/?a=1&amp;b=2#part">b</a> <a class="x" href="https://${HOST}/new/?a=1&amp;b=2">b2</a> <a href="/c/">c</a></p>`);
  });

  it('Codex review of task 5.5: parsed as HTML — unquoted and escaped hrefs are links; an href in another attribute is text', () => {
    const base = `https://${HOST}/src/`;
    const from = new Set([`https://${HOST}/b/`]);
    const { html, changed } = rewriteLinks('<p><a title="href=\'/b/\'" href="/c/">c</a> <a href=/b/>u</a> <a href="&#47;b&#47;">e</a></p>', base, from, `https://${HOST}/new/`);
    expect(changed).toBe(2);
    expect(html).toBe(`<p><a title="href='/b/'" href="/c/">c</a> <a href="https://${HOST}/new/">u</a> <a href="https://${HOST}/new/">e</a></p>`);
    // Nothing to change: the text exactly as it was.
    const same = '<p><a href=/c/>c</a></p>';
    expect(rewriteLinks(same, base, from, `https://${HOST}/new/`)).toEqual({ html: same, changed: 0 });
  });
});

describe('canonicalPath', () => {
  it('Codex review of task 5.5, round 7: a decoded path as the URL parser writes a link to it; what only an escape can say, escaped', () => {
    // Natural characters: exactly the parser's encoding.
    const natural = `/a b"<>^\`{}|é~!$&'()*+,;=:@[]`;
    expect(canonicalPath(natural)).toBe(new URL(natural, 'https://h.example.com').pathname);
    // A tab, a line break, a backslash and `%` have no literal form in a URL path.
    expect(canonicalPath('/a\tb\nc\\d%e/')).toBe('/a%09b%0Ac%5Cd%25e');
    expect(canonicalPath('/')).toBe('/');
  });
});

describe.skipIf(!hasDbIntegrationUrl)('change impact — DB integration', () => {
  let db: Database;
  let consumer: EventConsumerDefinition;

  beforeAll(async () => {
    db = await connectDbIntegration('link-impact');
  });
  afterAll(async () => {
    await db?.delete(sites).where(inArray(sites.id, [A]));
  });
  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [A]));
    await db.insert(sites).values({ id: A, name: 'Impact A', defaultLanguage: 'en' });
    await upgradeSitePreset(db, A);
    await db.insert(siteDomains).values({ siteId: A, hostname: HOST, kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() });
    await settings();
    await rebuildSiteProjection(db, A);
    consumer = { ...linkGraphConsumer({ db }), name: `impact-it-${randomBytes(4).toString('hex')}` };
    await new EventConsumerRunner(db).register(consumer);
  });

  const settings = async (patch: Record<string, unknown> = {}) => {
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, A));
    await new ContentSettingsService({ db, siteId: A, actor: { userId: null } }).update({
      availableLocales: r!.availableLocales, timezone: r!.timezone, siteType: 'blog', trailingSlash: 'always', localeStrategy: 'subdirectory',
      localePrefixMode: 'default_at_root', localePrefixes: {}, permalinks: { articles: '/:slug', pages: '/:slug' },
      allowCrossSiteTranslations: false, sponsorDisclosure: true, sponsorRel: true, version: r!.version, ...patch,
    } as never);
  };

  const service = () => new ItemService({ db, siteId: A });
  const article = (slug: string, body = '<p>x</p>', collection = 'articles') =>
    service().create(collection, { data: { title: `Title ${slug}`, slug, locale: 'en', body }, status: 'published' }) as Promise<{ id: string }>;
  const local = (slug: string, locale: string, body = '<p>x</p>') =>
    service().create('articles', { data: { title: `Title ${slug} ${locale}`, slug, locale, body }, status: 'published' }) as Promise<{ id: string }>;
  const consume = () => new EventConsumerRunner(db).runOnce(consumer);
  /** A transaction holding the address-space lock with `fn`'s writes until `release`; resolves its backend once held. */
  const holdAddressSpace = (fn: (tx: Parameters<Parameters<typeof runSiteTransaction>[2]>[0]) => Promise<unknown>) => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let locked!: (pid: number) => void;
    const held = new Promise<number>((res) => (locked = res));
    const done = runSiteTransaction(db, A, async (tx) => {
      await tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${A} FOR UPDATE`);
      await fn(tx);
      locked(await backendOf(tx));
      await gate;
    });
    return { held, release: () => release(), done };
  };
  const bodyOf = async (id: string) => ((await db.select({ data: itemsTable.data }).from(itemsTable).where(eq(itemsTable.id, id)))[0]!.data as Record<string, unknown>).body as string;

  it('the pages linking to it, where; a second level on request; within the limit; registered links for administrators only', async () => {
    const b = await article('b');
    const a = await article('a', '<p><a href="/b/">to b</a> and <a href="/b/#part">again</a></p>');
    const c = await article('c', '<p><a href="/b/">b</a></p>');
    const d = await article('d', '<p><a href="/a/">a</a></p>');
    // An address redirected to it: links there are links to it.
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'content', locale: 'en', fromPath: '/b-old', toPath: '/b', toLocale: 'en', source: 'manual' }));
    const e = await article('e', '<p><a href="/b-old/">old b</a></p>');
    await consume();
    await addManualLink(db, A, { label: 'Menu', url: `https://${HOST}/b/` }, null);

    const one = await linkImpact(db, A, b.id, all);
    expect(one.target).toMatchObject({ itemId: b.id, path: '/b', url: `https://${HOST}/b/` });
    const sources = one.links.map((l) => (l.source.kind === 'item' ? l.source.itemId : `nav:${l.source.label}`));
    expect(new Set(sources)).toEqual(new Set([a.id, c.id, e.id, 'nav:Menu']));
    expect(one.links.filter((l) => l.source.kind === 'item' && l.source.itemId === a.id).map((l) => [l.field, l.position, l.href])).toEqual([
      ['body', 0, '/b/'],
      ['body', 1, '/b/#part'],
    ]);
    expect(one.links.every((l) => l.depth === 1)).toBe(true);
    expect(one.pages).toBe(4);
    expect(one.truncated).toBe(false);
    // Depth 2: who links to those pages.
    const two = await linkImpact(db, A, b.id, { ...all, depth: 2 });
    expect(two.links.filter((l) => l.depth === 2).map((l) => [l.source.kind === 'item' && l.source.itemId, l.via])).toEqual([[d.id, a.id]]);
    // Asked for more than the limits: held to them.
    expect((await linkImpact(db, A, b.id, { ...all, depth: 9, limit: 5000 })).limits).toEqual({ depth: 2, limit: 200 });
    // Two pages (the limit counts pages): `a`'s two links and one more page's.
    const small = await linkImpact(db, A, b.id, { ...all, limit: 2 });
    expect(small.pages).toBe(2);
    expect(small.truncated).toBe(true);
    // Not an administrator: no registered links; a page it may not read is not shown.
    const member = await linkImpact(db, A, b.id, { readable: (id) => sql`${id} <> ${c.id}`, navigation: false });
    expect(member.links.some((l) => l.source.kind === 'navigation')).toBe(false);
    expect(member.links.some((l) => l.source.kind === 'item' && l.source.itemId === c.id)).toBe(false);
    // Not public: nothing links to it.
    await expect(linkImpact(db, A, 'nope', all)).rejects.toMatchObject({ code: 'NOT_PUBLIC' });
  });

  it('a redirect from its address: links keep working once it is unpublished; refused when it exists, loops, leaves the site or points to itself', async () => {
    const b = await article('b');
    await article('dest');
    await article('a', '<p><a href="/b/">to b</a></p>');
    await consume();
    const made = await createImpactRedirect(db, A, b.id, `https://${HOST}/dest/`, { userId: null });
    expect(made).toMatchObject({ fromPath: '/b', toPath: '/dest', toLocale: 'en' });
    // Unpublished: the link to it is not broken (it reaches the destination through the redirect).
    const version = (await db.select({ v: itemsTable.version }).from(itemsTable).where(eq(itemsTable.id, b.id)))[0]!.v;
    await service().patch('articles', b.id, { status: 'draft', expectedVersion: version });
    await consume();
    expect((await linkReport(db, A, all)).broken).toEqual([]);
    await expect(createImpactRedirect(db, A, (await article('b2')).id, 'https://example.org/x/', { userId: null })).rejects.toMatchObject({ code: 'NOT_ON_SITE' });
    const c = await article('c');
    await expect(createImpactRedirect(db, A, c.id, `https://${HOST}/c/`, { userId: null })).rejects.toMatchObject({ code: 'INVALID' });
    // An address that leads back to the page itself is not another page.
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'content', locale: 'en', fromPath: '/loop', toPath: '/c', toLocale: 'en', source: 'manual' }));
    await expect(createImpactRedirect(db, A, c.id, `https://${HOST}/loop/`, { userId: null })).rejects.toMatchObject({ code: 'NOT_A_PAGE' });
    // Another live page with a rule from its own address back to this one: the two rules would loop.
    await article('d');
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'content', locale: 'en', fromPath: '/d', toPath: '/c', toLocale: 'en', source: 'manual' }));
    await expect(createImpactRedirect(db, A, c.id, `https://${HOST}/d/`, { userId: null })).rejects.toMatchObject({ code: 'REDIRECT_CONFLICT' });
    expect((await runSiteTransaction(db, A, (tx) => tx.select().from(redirects).where(and(eq(redirects.siteId, A), eq(redirects.fromPath, '/c'))))).length).toBe(0);
    await createImpactRedirect(db, A, c.id, `https://${HOST}/dest/`, { userId: null });
    await expect(createImpactRedirect(db, A, c.id, `https://${HOST}/dest/`, { userId: null })).rejects.toBeInstanceOf(LinkImpactError);
  });

  it('Codex review of task 5.5: a URL-layer alias is an address of the page; the limit counts pages; a redirect needs another page, and a free address', async () => {
    const b = await article('b');
    await article('other');
    // A URL-layer alias: `/old-b` → `/b` (its links are recorded by their URL).
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', locale: '', fromPath: '/old-b', toPath: '/b', toLocale: '', source: 'manual' }));
    const viaAlias = await article('via-alias', '<p><a href="/old-b/">old</a></p>');
    // One page with many links, and another.
    const many = await article('aaa-many', `<p>${Array.from({ length: 6 }, () => '<a href="/b/">b</a>').join(' ')}</p>`);
    await consume();
    const all1 = await linkImpact(db, A, b.id, all);
    expect(new Set(all1.links.map((l) => l.source.kind === 'item' && l.source.itemId))).toEqual(new Set([viaAlias.id, many.id]));
    const one = await linkImpact(db, A, b.id, { ...all, limit: 1 });
    expect(new Set(one.links.map((l) => l.source.kind === 'item' && l.source.itemId))).toEqual(new Set([many.id]));
    expect(one.links).toHaveLength(6);
    expect(one.pages).toBe(1);
    expect(one.truncated).toBe(true);
    // Links through the alias are updated too.
    const updated = await updateImpactLinks(db, A, service(), b.id, { to: `https://${HOST}/other/`, sources: [viaAlias.id] });
    expect(updated.updated).toEqual([{ itemId: viaAlias.id, links: 1 }]);
    // A redirect: not to an address with no page; not where a URL-layer rule already answers.
    await expect(createImpactRedirect(db, A, b.id, `https://${HOST}/nothing-here/`, { userId: null })).rejects.toMatchObject({ code: 'NOT_A_PAGE' });
    const c = await article('c');
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', locale: '', fromPath: '/c', toPath: '/other', toLocale: '', source: 'manual' }));
    await expect(createImpactRedirect(db, A, c.id, `https://${HOST}/other/`, { userId: null })).rejects.toMatchObject({ code: 'REDIRECT_EXISTS' });
  });

  it('Codex review of task 5.5, round 2: an alias link with a query; a full first level leaves the list incomplete; the second level through a page\'s alias', async () => {
    const b = await article('b');
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', locale: '', fromPath: '/old-b', toPath: '/b', toLocale: '', source: 'manual' }));
    const q = await article('q-src', '<p><a href="/old-b/?campaign=x">old with a query</a></p>');
    const a = await article('a-src', '<p><a href="/b/">b</a></p>');
    // A second-level page linking to `a-src` through an alias of it.
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', locale: '', fromPath: '/a-old', toPath: '/a-src', toLocale: '', source: 'manual' }));
    const d = await article('d-src', '<p><a href="/a-old/">a</a></p>');
    await consume();
    const one = await linkImpact(db, A, b.id, all);
    expect(new Set(one.links.map((l) => l.source.kind === 'item' && l.source.itemId))).toEqual(new Set([q.id, a.id]));
    const two = await linkImpact(db, A, b.id, { ...all, depth: 2 });
    expect(two.links.filter((l) => l.depth === 2).map((l) => [l.source.kind === 'item' && l.source.itemId, l.via])).toEqual([[d.id, a.id]]);
    expect(two.truncated).toBe(false);
    // The first level fills the limit: the second is not looked at, and the list says it may be incomplete.
    const full = await linkImpact(db, A, b.id, { ...all, depth: 2, limit: 2 });
    expect(full.links.every((l) => l.depth === 1)).toBe(true);
    expect(full.truncated).toBe(true);
  });

  it('Codex review of task 5.5, round 3: an alias written with other escapes; a destination being unpublished meanwhile is not taken', async () => {
    const b = await article('b');
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', locale: '', fromPath: '/old-b', toPath: '/b', toLocale: '', source: 'manual' }));
    const q = await article('esc-src', '<p><a href="/old-%62/?x=1">escaped</a></p>');
    await consume();
    expect((await linkImpact(db, A, b.id, all)).links.map((l) => l.source.kind === 'item' && l.source.itemId)).toEqual([q.id]);
    expect((await updateImpactLinks(db, A, service(), b.id, { to: `https://${HOST}/b/`, sources: [q.id] })).updated).toEqual([{ itemId: q.id, links: 1 }]);
    // The destination's unpublishing, not yet committed: the redirect waits for it, then refuses.
    const c = await article('c-move');
    const dest = await article('dest-going');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: (pid: number) => void;
    const holding = new Promise<number>((r) => (locked = r));
    const unpublish = runSiteTransaction(db, A, async (tx) => {
      await tx.update(itemsTable).set({ status: 'draft' }).where(eq(itemsTable.id, dest.id));
      locked(await backendOf(tx));
      await gate;
    });
    const holder = await holding;
    const creating = createImpactRedirect(db, A, c.id, `https://${HOST}/dest-going/`, { userId: null });
    creating.catch(() => {});
    await blockedBy(holder);
    release();
    await unpublish;
    await expect(creating).rejects.toMatchObject({ code: 'NOT_A_PAGE' });
  });

  it('Codex review of task 5.5, round 4: a URL-layer alias is placed by the site\'s languages; the destination is placed under the address lock', async () => {
    await settings({ availableLocales: ['en', 'fr', 'es'], localePrefixes: { fr: 'fr', es: 'es' } });
    // `/fr/old-b` → `/fr/b` (a French page): a link written `/fr/old-%62/` reaches it.
    const bFr = await local('b', 'fr');
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', locale: '', fromPath: '/fr/old-b', toPath: '/fr/b', toLocale: '', source: 'manual' }));
    const src = await article('fr-src', '<p><a href="/fr/old-%62/">old</a></p>');
    // `/old` → `/b` (English): a link to the French page at `/fr/old/` does not go through it.
    const bEn = await article('b');
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', locale: '', fromPath: '/old', toPath: '/b', toLocale: '', source: 'manual' }));
    await local('old', 'fr');
    await article('to-fr-old', '<p><a href="/fr/old/">french old</a></p>');
    await consume();
    expect((await linkImpact(db, A, bFr.id, all)).links.map((l) => l.source.kind === 'item' && l.source.itemId)).toEqual([src.id]);
    expect((await linkImpact(db, A, bEn.id, all)).links).toEqual([]);
    expect((await updateImpactLinks(db, A, service(), bFr.id, { to: `https://${HOST}/fr/b/`, sources: [src.id] })).updated).toEqual([{ itemId: src.id, links: 1 }]);

    // The languages' prefixes swapped while the redirect is being made: `/fr/dest/` is then the Spanish page, and the
    // redirect leads there.
    await local('dest', 'fr');
    await local('dest', 'es');
    const c = await article('c-swap');
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    let locked!: (pid: number) => void;
    const holding = new Promise<number>((res) => (locked = res));
    const swap = runSiteTransaction(db, A, async (tx) => {
      await tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${A} FOR UPDATE`);
      await tx.update(siteContentSettings).set({ localePrefixes: { fr: 'es', es: 'fr' } }).where(eq(siteContentSettings.siteId, A));
      locked(await backendOf(tx));
      await gate;
    });
    const holder = await holding;
    const creating = createImpactRedirect(db, A, c.id, `https://${HOST}/fr/dest/`, { userId: null });
    creating.catch(() => {});
    await blockedBy(holder);
    release();
    await swap;
    expect(await creating).toMatchObject({ fromPath: '/c-swap', toPath: '/dest', toLocale: 'es' });
  });

  it('Codex review of task 5.5, round 5: a URL-layer alias on a language entry domain leads to that language\'s page; the source address is read under the lock', async () => {
    const FR_HOST = 'impact-fr.example.com';
    await settings({ availableLocales: ['en', 'fr', 'es'], localePrefixes: { fr: 'fr', es: 'es' } });
    await db.insert(siteDomains).values({ siteId: A, hostname: FR_HOST, kind: 'custom', status: 'active', isPrimary: false, entryLocale: 'fr', verifiedAt: new Date() });
    // `/old` → `/b` on every host: English B on the primary domain, French B on the French entry domain.
    const bEn = await article('b');
    const bFr = await local('b', 'fr');
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', locale: '', fromPath: '/old', toPath: '/b', toLocale: '', source: 'manual' }));
    const toEn = await article('to-en', '<p><a href="/old/">old</a></p>');
    const toFr = await article('to-fr', `<p><a href="https://${FR_HOST}/ol%64/">vieux</a></p>`);
    await consume();
    expect((await linkImpact(db, A, bEn.id, all)).links.map((l) => l.source.kind === 'item' && l.source.itemId)).toEqual([toEn.id]);
    expect((await linkImpact(db, A, bFr.id, all)).links.map((l) => l.source.kind === 'item' && l.source.itemId)).toEqual([toFr.id]);
    // Updating English B's links leaves the French one alone.
    expect((await updateImpactLinks(db, A, service(), bEn.id, { to: `https://${HOST}/b/`, sources: [toEn.id, toFr.id] })).skipped).toEqual([{ itemId: toFr.id, reason: 'no_links' }]);

    // The languages' prefixes swapped while the redirect is being made: the page's address is then `/es/c`, where a
    // URL-layer rule already answers.
    const c = await local('c', 'fr');
    await article('dest');
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', locale: '', fromPath: '/es/c', toPath: '/dest', toLocale: '', source: 'manual' }));
    const swap = holdAddressSpace((tx) => tx.update(siteContentSettings).set({ localePrefixes: { fr: 'es', es: 'fr' } }).where(eq(siteContentSettings.siteId, A)));
    const holder = await swap.held;
    const creating = createImpactRedirect(db, A, c.id, `https://${HOST}/dest/`, { userId: null });
    creating.catch(() => {});
    await blockedBy(holder);
    swap.release();
    await swap.done;
    await expect(creating).rejects.toMatchObject({ code: 'REDIRECT_EXISTS' });
  });

  it('Codex review of task 5.5, round 5: every language prefixed — an alias without a language, written with other escapes', async () => {
    await settings({ availableLocales: ['en', 'fr'], localePrefixMode: 'all_prefixed', localePrefixes: { en: 'en', fr: 'fr' } });
    const b = await article('b');
    await runSiteTransaction(db, A, (tx) => tx.insert(redirects).values({ siteId: A, scope: 'url', locale: '', fromPath: '/old-b', toPath: '/en/b', toLocale: '', source: 'manual' }));
    const src = await article('src', '<p><a href="/old-%62/#x">old</a></p>');
    await consume();
    expect((await linkImpact(db, A, b.id, all)).links.map((l) => l.source.kind === 'item' && l.source.itemId)).toEqual([src.id]);
    expect((await updateImpactLinks(db, A, service(), b.id, { to: `https://${HOST}/en/b/`, sources: [src.id] })).updated).toEqual([{ itemId: src.id, links: 1 }]);
  });

  it('Codex review of task 5.5, rounds 6 and 7: 20,000 URL-layer aliases on 51 hosts are one query of a bounded size; a link with user information is the same host', async () => {
    await db.insert(siteDomains).values(
      Array.from({ length: 50 }, (_, i) => ({ siteId: A, hostname: `impact-a${i + 1}.example.com`, kind: 'custom' as const, status: 'active' as const, isPrimary: false, verifiedAt: new Date() })),
    );
    const b = await article('b');
    await runSiteTransaction(db, A, (tx) =>
      tx.execute(sql`INSERT INTO ${redirects} (id, site_id, scope, locale, from_path, match, to_path, to_locale, source)
                     SELECT 'imp-' || n, ${A}, 'url', '', '/old-' || lpad(n::text, 5, '0'), 'exact', '/b', '', 'import' FROM generate_series(0, 19999) n`),
    );
    const last = await article('to-last', '<p><a href="https://impact-a2.example.com/old-19999/">last</a></p>');
    const escaped = await article('to-escaped', '<p><a href="/old-0000%31/">escaped</a></p>');
    const user = await article('to-user', `<p><a href="https://author@${HOST}/old-00002/">with user</a></p>`);
    await consume();
    const impact = await linkImpact(db, A, b.id, all);
    expect(new Set(impact.links.map((l) => l.source.kind === 'item' && l.source.itemId))).toEqual(new Set([last.id, escaped.id, user.id]));
    expect((await updateImpactLinks(db, A, service(), b.id, { to: `https://${HOST}/b/`, sources: [user.id] })).updated).toEqual([{ itemId: user.id, links: 1 }]);
    // The bulk rows removed here, inside this test's own time (the next test's setup would otherwise remove them through
    // the site's cascade, and a slow CI database runs past its hook's time).
    await runSiteTransaction(db, A, (tx) => tx.delete(redirects).where(and(eq(redirects.siteId, A), eq(redirects.source, 'import'))));
  }, 60_000);

  it('Codex review of task 5.5, round 7: aliases only an escape can write — a tab, a backslash, a caret — and the same link to the preview and the update', async () => {
    const b = await article('b');
    await runSiteTransaction(db, A, (tx) =>
      tx.insert(redirects).values([
        { siteId: A, scope: 'url', locale: '', fromPath: '/a\tb', toPath: '/b', toLocale: '', source: 'manual' },
        { siteId: A, scope: 'url', locale: '', fromPath: '/c\\d', toPath: '/b', toLocale: '', source: 'manual' },
        { siteId: A, scope: 'url', locale: '', fromPath: '/e^f', toPath: '/b', toLocale: '', source: 'manual' },
      ]),
    );
    const tab = await article('to-tab', '<p><a href="/a%09b/">tab</a></p>');
    const slash = await article('to-backslash', '<p><a href="/c%5Cd/">backslash</a></p>');
    const caret = await article('to-caret', '<p><a href="/e^f/">caret</a></p>');
    // A raw backslash is a separator: `/c/d`, not the alias.
    const raw = await article('to-raw', '<p><a href="/c\\d/">raw</a></p>');
    await consume();
    const preview = new Set((await linkImpact(db, A, b.id, all)).links.map((l) => l.source.kind === 'item' && l.source.itemId));
    expect(preview).toEqual(new Set([tab.id, slash.id, caret.id]));
    const update = await updateImpactLinks(db, A, service(), b.id, { to: `https://${HOST}/b/`, sources: [tab.id, slash.id, caret.id, raw.id] });
    expect(new Set(update.updated.map((u) => u.itemId))).toEqual(preview);
    expect(update.skipped).toEqual([{ itemId: raw.id, reason: 'no_links' }]);
  });

  it('its links updated to another address: the pages changed, the fragment kept, other links untouched; not the pages named that do not link to it', async () => {
    const b = await article('b');
    await article('new');
    const a = await article('a', '<p><a href="/b/#part">b</a> <a href="/new/">n</a></p>');
    const c = await article('c', '<p><a href="/b/">b</a></p>');
    const z = await article('z', '<p>no link</p>');
    await consume();
    const result = await updateImpactLinks(db, A, service(), b.id, { to: `https://${HOST}/new/`, sources: [a.id, c.id, z.id, 'gone'] });
    expect(result.updated.sort((x, y) => (x.itemId < y.itemId ? -1 : 1))).toEqual([{ itemId: a.id, links: 1 }, { itemId: c.id, links: 1 }].sort((x, y) => (x.itemId < y.itemId ? -1 : 1)));
    expect(result.skipped.sort((x, y) => (x.itemId < y.itemId ? -1 : 1))).toEqual([{ itemId: 'gone', reason: 'not_public' }, { itemId: z.id, reason: 'no_links' }].sort((x, y) => (x.itemId < y.itemId ? -1 : 1)));
    expect(await bodyOf(a.id)).toContain(`href="https://${HOST}/new/#part"`);
    expect(await bodyOf(a.id)).toContain('href="/new/"');
    await consume();
    expect((await linkImpact(db, A, b.id, all)).links).toEqual([]);
    await expect(updateImpactLinks(db, A, service(), b.id, { to: 'https://example.org/', sources: [a.id] })).rejects.toMatchObject({ code: 'NOT_ON_SITE' });
    await expect(updateImpactLinks(db, A, service(), b.id, { to: `https://${HOST}/new/`, sources: Array.from({ length: 51 }, (_, i) => `x${i}`) })).rejects.toMatchObject({ code: 'TOO_MANY' });
  });
});
