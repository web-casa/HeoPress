import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { indexNowQueue, indexNowSites, indexNowState, items as itemsTable, siteContentSettings, siteDomains, sites, type Database } from '@heopress/database';
import { EventConsumerRunner, type EventConsumerDefinition } from '../modules/events/consumer-runner';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { SeoSettingsService } from '../services/site-network/seo-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { rebuildSiteProjection } from '../services/site-network/public-projection';
import { enqueueIndexNow, indexNowConsumer, processIndexNowQueue, scheduleIndexNowReconciliation } from '../services/site-network/indexnow';
import { ThemeService } from '../services/themes/theme-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * IndexNow (HeoPress P07 tasks 3.4, 3.6; spec seo/crawl-discovery "IndexNow 推送"): a site's changes are queued by the
 * event consumer and pushed by the worker — the right URLs to the right endpoint, a real change only, once, in requests of
 * at most 10,000 URLs of the site's own hosts — retried after a failure, and found again by the reconciliation when an
 * event was lost. A fake endpoint records the requests.
 */

const A = 'site_p07_indexnow_a';
const B = 'site_p07_indexnow_b';
const HOST_A = 'inx-a.example.com';
const HOST_B = 'inx-b.example.com';

interface Sent {
  endpoint: string;
  body: { host: string; key: string; keyLocation: string; urlList: string[] };
}

describe.skipIf(!hasDbIntegrationUrl)('IndexNow — DB integration', () => {
  let db: Database;
  let sent: Sent[];
  let answer: (s: Sent) => Promise<Response> | Response;
  let clock: number;
  let consumer: EventConsumerDefinition;
  const fetch = async (endpoint: string, init: RequestInit) => {
    const s = { endpoint, body: JSON.parse(String(init.body)) as Sent['body'] };
    sent.push(s);
    return answer(s);
  };
  /** The consumer's pass over the change events, then the worker's pass after the window. */
  const run = async () => {
    await new EventConsumerRunner(db).runOnce(consumer);
    // Past the window of what was just queued (queued by the real clock): never behind it, however slow the run.
    clock = Math.max(clock, Date.now()) + 11_000;
    return processIndexNowQueue(db, { fetch, now: () => new Date(clock) });
  };
  const urls = () => sent.flatMap((s) => s.body.urlList).sort();

  beforeAll(async () => {
    db = await connectDbIntegration('indexnow');
  });
  afterAll(async () => {
    await db?.delete(sites).where(inArray(sites.id, [A, B]));
  });
  beforeEach(async () => {
    await db.delete(sites).where(inArray(sites.id, [A, B]));
    await db.insert(sites).values([
      { id: A, name: 'IndexNow A', defaultLanguage: 'en' },
      { id: B, name: 'IndexNow B', defaultLanguage: 'en' },
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
    sent = [];
    answer = () => new Response(null, { status: 200 });
    clock = Date.now();
    // This suite's own consumer, from the head of the change events (other suites' consumers keep their own positions).
    consumer = { ...indexNowConsumer({ db }), name: `indexnow-it-${randomBytes(4).toString('hex')}` };
    await new EventConsumerRunner(db).register(consumer);
  });

  const seo = (siteId: string) => new SeoSettingsService({ db, siteId, actor: { userId: null } });
  const turnOn = async (siteId: string, on = true) => {
    const { version, settings } = await seo(siteId).get();
    return (await seo(siteId).update({ ...settings, version, discovery: { ...settings.discovery, indexNow: on } })).settings;
  };
  const items = (siteId: string) => new ItemService({ db, siteId });
  const article = (siteId: string, slug: string, data: Record<string, unknown> = {}) =>
    items(siteId).create('articles', { data: { title: `Title ${slug}`, slug, locale: 'en', ...data }, status: 'published' }) as Promise<{ id: string; version: number }>;
  const version = async (id: string) => (await db.select({ v: itemsTable.version }).from(itemsTable).where(eq(itemsTable.id, id)))[0]!.v;
  const patch = async (siteId: string, id: string, patchData: Record<string, unknown>) => items(siteId).patch('articles', id, { ...patchData, expectedVersion: await version(id) });

  it('turned on: a key is made and kept; what was already public is the baseline, not pushed', async () => {
    await article(A, 'before');
    const settings = await turnOn(A);
    expect(settings.discovery.indexNowKey).toMatch(/^[0-9a-f]{32}$/);
    // Kept through an update that leaves it out.
    const { version: v, settings: s } = await seo(A).get();
    expect((await seo(A).update({ ...s, version: v, discovery: { ...s.discovery, indexNowKey: null } })).settings.discovery.indexNowKey).toBe(settings.discovery.indexNowKey);
    // The baseline was taken as it was turned on: the article is recorded, and the first pass has nothing to send.
    const state = await db.transaction(async (tx) => {
      await tx.execute(`SELECT set_config('app.site_id', '${A}', true)`);
      return tx.select({ url: indexNowState.url }).from(indexNowState).where(eq(indexNowState.siteId, A));
    });
    expect(state.map((r) => r.url)).toEqual([`https://${HOST_A}/before/`]);
    const results = await run();
    expect(results.find((r) => r.siteId === A)?.status).toBe('nothing');
    expect(sent).toEqual([]);
  });

  it('the baseline is taken when IndexNow is turned on: what is published before the first pass is pushed (Codex review of batch 8)', async () => {
    await article(A, 'old-news');
    await turnOn(A);
    // Before the worker's first pass, a new article.
    await article(A, 'fresh-news');
    await run();
    expect(urls()).toEqual([`https://${HOST_A}/fresh-news/`]);
  });

  it('a worker that loses the site in a long pass stops: it records nothing more and never clears its successor\'s lease (Codex review of batch 8)', async () => {
    await turnOn(A);
    await run();
    await db.transaction(async (tx) => {
      await tx.execute(`SELECT set_config('app.site_id', '${A}', true)`);
      await tx.execute(`
        INSERT INTO lumibase_public_items (item_id, site_id, collection, locale, path, data, card, updated_at, published_at, sanitizer, content_hash, content_modified_at)
        SELECT 'inx-lease-' || g, '${A}', 'articles', 'en', '/lease-' || g, jsonb_build_object('title', 'Lease ' || g),
               jsonb_build_object('url', 'https://${HOST_A}/lease-' || g || '/'), now(), now(), 1, 'h' || g, now()
          FROM generate_series(1, 10500) g`);
    });
    await scheduleIndexNowReconciliation(db, new Date(clock));
    clock = Math.max(clock, Date.now()) + 1000;
    // Worker A's first request takes past its lease; worker B takes the site meanwhile and makes the whole pass.
    let b: Awaited<ReturnType<typeof processIndexNowQueue>> = [];
    let firstOfA = true;
    answer = async () => {
      if (firstOfA) {
        firstOfA = false;
        clock += 4 * 60_000;
        // B's own rows: the reconciliation's row, due again past A's lease on it.
        b = await processIndexNowQueue(db, { fetch, now: () => new Date(clock) });
      }
      return new Response(null, { status: 200 });
    };
    const a = await processIndexNowQueue(db, { fetch, now: () => new Date(clock) });
    expect(a[0]).toMatchObject({ status: 'failed', error: 'lease lost' });
    expect(b[0]).toMatchObject({ status: 'pushed', urls: 10_500, requests: 2 });
    // A's first request, then B's two: A sent no second batch, and nothing is left to send.
    expect(sent.map((s) => s.body.urlList.length)).toEqual([10_000, 10_000, 500]);
    expect(await db.select().from(indexNowQueue).where(eq(indexNowQueue.siteId, A))).toEqual([]);
    const [site] = await db.transaction(async (tx) => {
      await tx.execute(`SELECT set_config('app.site_id', '${A}', true)`);
      return tx.select({ leasedUntil: indexNowSites.leasedUntil, leaseToken: indexNowSites.leaseToken }).from(indexNowSites).where(eq(indexNowSites.siteId, A));
    });
    expect(site).toEqual({ leasedUntil: null, leaseToken: null });
    sent = [];
    expect((await processIndexNowQueue(db, { fetch, now: () => new Date(clock) })).filter((r) => r.siteId === A)).toEqual([]);
    expect(sent).toEqual([]);
  }, 120_000);

  it('publish, edit, move, noindex, unpublish, delete: each pushes its URLs — an SEO-only edit does not', async () => {
    const key = (await turnOn(A)).discovery.indexNowKey!;
    await run();
    const a = await article(A, 'news-one');
    await run();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      endpoint: 'https://api.indexnow.org/indexnow',
      body: { host: HOST_A, key, keyLocation: `https://${HOST_A}/${key}.txt`, urlList: [`https://${HOST_A}/news-one/`] },
    });
    // An SEO field only: no notice. Content: a notice.
    sent = [];
    await patch(A, a.id, { data: { seo_title: 'Only SEO' } });
    await run();
    expect(sent).toEqual([]);
    await patch(A, a.id, { data: { body: '<p>New text.</p>' } });
    await run();
    expect(urls()).toEqual([`https://${HOST_A}/news-one/`]);
    // Moved: the old address and the new.
    sent = [];
    await patch(A, a.id, { data: { slug: 'news-moved' } });
    await run();
    expect(urls()).toEqual([`https://${HOST_A}/news-moved/`, `https://${HOST_A}/news-one/`]);
    // No longer indexed: pushed once (withdrawal), then forgotten.
    sent = [];
    await patch(A, a.id, { data: { seo_robots: 'noindex,follow' } });
    await run();
    expect(urls()).toEqual([`https://${HOST_A}/news-moved/`]);
    sent = [];
    await run();
    expect(sent).toEqual([]);
    // Not indexed: a later edit is not pushed (task 2.3: only addresses search engines may index are announced).
    await patch(A, a.id, { data: { body: '<p>Changed while not indexed.</p>' } });
    await run();
    expect(sent).toEqual([]);
    // Unpublished and deleted.
    const b = await article(A, 'news-two');
    await run();
    sent = [];
    await patch(A, b.id, { status: 'draft' });
    await run();
    expect(urls()).toEqual([`https://${HOST_A}/news-two/`]);
    const c = await article(A, 'news-three');
    await run();
    sent = [];
    await items(A).softDelete('articles', c.id);
    await run();
    expect(urls()).toEqual([`https://${HOST_A}/news-three/`]);
    // Site B (IndexNow off) told nothing, ever.
    expect(sent.every((s) => s.body.host === HOST_A)).toBe(true);
  });

  it('spec "只换主题": publishing, switching and rolling back theme versions pushes nothing — nor does the reconciliation after them', async () => {
    await turnOn(A);
    await run();
    await article(A, 'theme-one');
    await article(A, 'theme-two');
    await run();
    expect(urls()).toEqual([`https://${HOST_A}/theme-one/`, `https://${HOST_A}/theme-two/`]);
    sent = [];
    const themes = new ThemeService({ db, siteId: A, actor: { userId: null } });
    const news = await themes.installStarter('news');
    await themes.activate(news.id);
    await run();
    const minimal = await themes.installStarter('minimal');
    await themes.activate(minimal.id);
    await run();
    // Rolled back to the first version, and the site's projection rebuilt (a site-wide re-render).
    await themes.activate(news.id);
    await rebuildSiteProjection(db, A);
    await run();
    // The reconciliation compares every public URL's fingerprint: the content is the same, so nothing either.
    await scheduleIndexNowReconciliation(db, new Date(clock));
    await run();
    expect(sent).toEqual([]);
    // A content change after it all is still announced (the pushes above were not just switched off).
    await article(A, 'theme-three');
    await run();
    expect(urls()).toEqual([`https://${HOST_A}/theme-three/`]);
  });

  it('task 2.8: a collection set not to be indexed by the site\'s defaults — its pages withdrawn once, then never announced; set back — announced again', async () => {
    await turnOn(A);
    await run();
    const a = await article(A, 'policy-one');
    await items(A).create('pages', { data: { title: 'Policy page', slug: 'policy-page', locale: 'en' }, status: 'published' });
    await run();
    sent = [];
    const off = await seo(A).get();
    await seo(A).update({ ...off.settings, version: off.version, index: { ...off.settings.index, collections: { articles: false } } });
    await run();
    expect(urls()).toEqual([`https://${HOST_A}/policy-one/`]);
    sent = [];
    await patch(A, a.id, { data: { body: '<p>Edited while the collection is not indexed.</p>' } });
    await run();
    expect(sent).toEqual([]);
    const on = await seo(A).get();
    await seo(A).update({ ...on.settings, version: on.version, index: { ...on.settings.index, collections: {} } });
    await run();
    expect(urls()).toEqual([`https://${HOST_A}/policy-one/`]);
  });

  it('an event queued twice is pushed once; two workers at once push once', async () => {
    await turnOn(A);
    await run();
    await article(A, 'once');
    await new EventConsumerRunner(db).runOnce(consumer);
    // The consumer's write replayed (its position not moved): the same event is one row.
    const [row] = await db.select().from(indexNowQueue).where(eq(indexNowQueue.siteId, A));
    await enqueueIndexNow(db, A, row!.eventId);
    expect(await db.select().from(indexNowQueue).where(eq(indexNowQueue.siteId, A))).toHaveLength(1);
    clock = Math.max(clock, Date.now()) + 11_000;
    // Two workers: one takes the site, the other finds it held.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    answer = async () => {
      await gate;
      return new Response(null, { status: 202 });
    };
    const first = processIndexNowQueue(db, { fetch, now: () => new Date(clock) });
    await new Promise((r) => setTimeout(r, 200));
    // A change queued while the first works (already due): the second worker still leaves the site to the first (the
    // site's lease) — it would otherwise make the same comparison and send the same URL again.
    await db.insert(indexNowQueue).values({ siteId: A, eventId: 'event:meanwhile', dueAt: new Date(clock - 1) });
    const second = await processIndexNowQueue(db, { fetch, now: () => new Date(clock) });
    release();
    await first;
    expect(second).toEqual([]);
    expect(urls()).toEqual([`https://${HOST_A}/once/`]);
    // The row queued meanwhile is taken by a later pass: nothing left to send.
    sent = [];
    expect((await processIndexNowQueue(db, { fetch, now: () => new Date(clock) }))[0]).toMatchObject({ status: 'nothing' });
    expect(sent).toEqual([]);
  });

  it('more than 10,000 URLs are split; a URL off the site\'s hosts is never sent', async () => {
    await turnOn(A);
    await run();
    await db.transaction(async (tx) => {
      await tx.execute(`SELECT set_config('app.site_id', '${A}', true)`);
      await tx.execute(`
        INSERT INTO lumibase_public_items (item_id, site_id, collection, locale, path, data, card, updated_at, published_at, sanitizer, content_hash, content_modified_at)
        SELECT 'inx-bulk-' || g, '${A}', 'articles', 'en', '/bulk-' || g, jsonb_build_object('title', 'Bulk ' || g),
               jsonb_build_object('url', CASE WHEN g = 1 THEN 'https://elsewhere.example.net/bulk-1/' ELSE 'https://${HOST_A}/bulk-' || g || '/' END),
               now(), now(), 1, 'h' || g, now()
          FROM generate_series(1, 10501) g`);
    });
    await scheduleIndexNowReconciliation(db, new Date(clock));
    clock = Math.max(clock, Date.now()) + 1000;
    const results = await processIndexNowQueue(db, { fetch, now: () => new Date(clock) });
    expect(results.find((r) => r.siteId === A)).toMatchObject({ status: 'pushed', urls: 10_500, requests: 2 });
    expect(sent.map((s) => s.body.urlList.length)).toEqual([10_000, 500]);
    expect(sent.every((s) => s.body.host === HOST_A && s.body.urlList.every((u) => u.startsWith(`https://${HOST_A}/`)))).toBe(true);
    expect(urls()).not.toContain('https://elsewhere.example.net/bulk-1/');
  }, 120_000);

  it('task 3.6: a change whose event was lost is found by the reconciliation; a failure and a timeout are sent again', async () => {
    await turnOn(A);
    await run();
    await article(A, 'lost');
    // The consumer never sees it (as if its event were lost): the reconciliation queues the site.
    await new EventConsumerRunner(db).runOnce(consumer);
    await db.delete(indexNowQueue).where(eq(indexNowQueue.siteId, A));
    answer = () => new Response('busy', { status: 500 });
    await scheduleIndexNowReconciliation(db, new Date(clock));
    clock = Math.max(clock, Date.now()) + 1000;
    const failed = await processIndexNowQueue(db, { fetch, now: () => new Date(clock) });
    expect(failed.find((r) => r.siteId === A)).toMatchObject({ status: 'failed', error: 'HTTP 500' });
    const [row] = await db.select().from(indexNowQueue).where(eq(indexNowQueue.siteId, A));
    expect(row).toMatchObject({ attempts: 1, lastError: 'HTTP 500' });
    expect(row!.dueAt.getTime()).toBeGreaterThan(clock);
    // Not due yet: nothing. Then a timeout (outcome unknown): the state stays.
    expect(await processIndexNowQueue(db, { fetch, now: () => new Date(clock) })).toEqual([]);
    answer = () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    };
    clock = row!.dueAt.getTime() + 1;
    expect((await processIndexNowQueue(db, { fetch, now: () => new Date(clock) }))[0]).toMatchObject({ status: 'failed', error: 'timeout: outcome unknown' });
    expect(await db.select().from(indexNowState).where(and(eq(indexNowState.siteId, A), eq(indexNowState.url, `https://${HOST_A}/lost/`)))).toEqual([]);
    // Then it goes through: sent again, recorded, the row gone.
    answer = () => new Response(null, { status: 200 });
    clock += 2 * 60 * 60_000;
    sent = [];
    expect((await processIndexNowQueue(db, { fetch, now: () => new Date(clock) }))[0]).toMatchObject({ status: 'pushed', urls: 1 });
    expect(urls()).toEqual([`https://${HOST_A}/lost/`]);
    expect(await db.select().from(indexNowQueue).where(eq(indexNowQueue.siteId, A))).toEqual([]);
  });

  it('turned off: nothing; turned on again: what changed meanwhile is pushed. Two sites, same path: each its own host and key', async () => {
    const keyA = (await turnOn(A)).discovery.indexNowKey!;
    const keyB = (await turnOn(B)).discovery.indexNowKey!;
    expect(keyA).not.toBe(keyB);
    await run();
    await turnOn(A, false);
    await article(A, 'while-off');
    await run();
    expect(sent).toEqual([]);
    await turnOn(A, true);
    await run();
    expect(urls()).toEqual([`https://${HOST_A}/while-off/`]);
    sent = [];
    await article(A, 'same');
    await article(B, 'same');
    await run();
    expect(sent.map((s) => [s.body.host, s.body.key, s.body.urlList])).toEqual(
      expect.arrayContaining([
        [HOST_A, keyA, [`https://${HOST_A}/same/`]],
        [HOST_B, keyB, [`https://${HOST_B}/same/`]],
      ]),
    );
    expect(sent).toHaveLength(2);
  });
});
