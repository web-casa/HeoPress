import fc from 'fast-check';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { collections, fields, scopedDatabase, siteContentSettings, sites, translationGroups, type Database } from '@heopress/database';
import { ItemService } from '../../item-service';
import { ContentSettingsService } from '../content-settings-service';
import { ensureContentSettings } from '../preset-installer';
import { rebuildSiteProjection } from '../public-projection';
import { TranslationGroupService } from '../translation-group-service';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from '../../../__tests__/helpers/cross-site-fixture';

/**
 * Member sites of a cross-site translation group write at the same time without a deadlock (HeoPress P14 tasks 4.1–4.2;
 * spec i18n/translation-groups "跨站成员同时写入不死锁", design D4). Each side is held at a barrier once it holds its own
 * site's settings row, so both reach the point where they need the other site's row:
 *
 *   - content settings × content settings: each holds its own row exclusively, then the projection's refresh of the
 *     group wants the other's row;
 *   - content settings × publishing an item of the group on the other site.
 *
 * Both writes must commit, `pg_stat_database.deadlocks` must not move and no transaction may run twice (a retry would
 * only hide the deadlock; exhausted, it answers 409).
 *
 * The barrier is a trigger on the settings row (created through the owner connection): it waits for an advisory lock
 * this test holds until both sides are waiting. Every attempt of a write bumps a sequence (sequences ignore rollbacks),
 * so a retried transaction is counted.
 *
 * Data is prepared, and stored rows checked, through the owner's fixtures connection (`connectDbFixtures`, which also
 * carries the barrier's DDL); the writes run as the application role on their site's scoped handle (P14 task 1.4).
 */

const GATE = 7_314_201;
const PREFIX = 'slo';

describe.skipIf(!hasDbIntegrationUrl)('settings lock order across a translation group — DB integration', () => {
  let db: Database;
  let fixtures: Database;
  let owner: postgres.Sql;
  let fx: CrossSiteFixture;
  const A = `site_${PREFIX}_a`;
  const B = `site_${PREFIX}_b`;
  /** A third site for the property (the fixture has two). */
  const C = `site_${PREFIX}_c`;

  beforeAll(async () => {
    db = await connectDbIntegration('settings-lock-order');
    fixtures = await connectDbFixtures('settings-lock-order');
    owner = (fixtures as unknown as { $client: postgres.Sql }).$client;
    await owner.unsafe(`CREATE SEQUENCE IF NOT EXISTS heopress_test_slo_attempts`);
    await owner.unsafe(`
      CREATE OR REPLACE FUNCTION heopress_test_slo_barrier() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_catalog AS $$
      BEGIN
        PERFORM nextval('heopress_test_slo_attempts');
        IF TG_ARGV[0] = 'gate' THEN
          PERFORM pg_advisory_xact_lock_shared(${GATE});
        END IF;
        RETURN NEW;
      END $$`);
  });
  afterAll(async () => {
    await owner?.unsafe(`DROP TRIGGER IF EXISTS heopress_test_slo_settings ON lumibase_site_content_settings`).catch(() => undefined);
    await owner?.unsafe(`DROP TRIGGER IF EXISTS heopress_test_slo_items ON lumibase_items`).catch(() => undefined);
    await owner?.unsafe(`DROP FUNCTION IF EXISTS heopress_test_slo_barrier()`).catch(() => undefined);
    await owner?.unsafe(`DROP SEQUENCE IF EXISTS heopress_test_slo_attempts`).catch(() => undefined);
    if (fx) await fx.teardown();
    await owner?.end({ timeout: 1 });
  });

  const siteDb = (siteId: string) => scopedDatabase(db, { site: siteId });
  const itemsOf = (siteId: string) => new ItemService({ db: siteDb(siteId), siteId });
  const groups = () =>
    new TranslationGroupService({ db: siteDb(A), siteId: A, actor: undefined, userId: null, itemsOn: (siteId, tx) => new ItemService({ db: tx as never, siteId }) });
  const groupRow = async (id: string) => (await fixtures.select().from(translationGroups).where(eq(translationGroups.id, id)))[0]!;
  const settingsRow = async (siteId: string) => (await fixtures.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId)))[0]!;

  async function updateSettings(siteId: string, over: Record<string, unknown>) {
    const r = await settingsRow(siteId);
    return new ContentSettingsService({ db: siteDb(siteId), siteId, actor: { userId: null } }).update({
      availableLocales: r.availableLocales,
      timezone: r.timezone,
      siteType: 'blog',
      trailingSlash: r.trailingSlash as 'always',
      localeStrategy: r.localeStrategy as 'subdirectory',
      localePrefixMode: r.localePrefixMode as 'default_at_root',
      localePrefixes: r.localePrefixes,
      permalinks: r.permalinks,
      allowCrossSiteTranslations: r.allowCrossSiteTranslations,
      sponsorDisclosure: r.sponsorDisclosure,
      sponsorRel: r.sponsorRel,
      version: r.version,
      ...over,
    } as never);
  }

  let groupId = '';
  let zhDraft = { id: '', version: 0 };
  beforeEach(async () => {
    await owner.unsafe(`DROP TRIGGER IF EXISTS heopress_test_slo_settings ON lumibase_site_content_settings`);
    await owner.unsafe(`DROP TRIGGER IF EXISTS heopress_test_slo_items ON lumibase_items`);
    fx = await createCrossSiteFixture(fixtures, { prefix: PREFIX, jwtSecret: 'settings-lock-order' });
    for (const siteId of [A, B]) {
      await fixtures.transaction((tx) => ensureContentSettings(tx as never, siteId));
      const [coll] = await fixtures.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, 'articles')));
      await fixtures.insert(fields).values({ siteId, collectionId: coll!.id, name: 'locale', type: 'string', interface: 'input' });
      await updateSettings(siteId, { availableLocales: ['en', 'zh-CN'], permalinks: { articles: '/:slug' }, allowCrossSiteTranslations: true });
    }
    for (const siteId of [A, B]) await rebuildSiteProjection(siteDb(siteId), siteId);
    // One group across both sites: en published on A, zh on B (a draft, for the publish case).
    const en = (await itemsOf(A).create('articles', { data: { title: 'en', slug: 'en-post', locale: 'en' }, status: 'published' })) as { id: string };
    zhDraft = (await itemsOf(B).create('articles', { data: { title: 'zh', slug: 'zh-post', locale: 'zh-CN' } })) as { id: string; version: number };
    const g = await groups().create(en.id);
    await groups().addMember(g.id, { siteId: B, itemId: zhDraft.id, expectedVersion: g.version });
    groupId = g.id;
    zhDraft.version = (await itemsOf(B).detail('articles', zhDraft.id) as { version: number }).version;
  });

  const attempts = async () => Number((await owner`SELECT last_value, is_called FROM heopress_test_slo_attempts`).map((r) => (r.is_called ? r.last_value : 0))[0]);
  const deadlocks = async () => {
    await owner`SELECT pg_stat_clear_snapshot()`;
    const [r] = await owner`SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()`;
    return r!.n as number;
  };

  /** Wait until `n()` sessions wait, directly or through another waiter, on the gate holder `pid`. */
  async function waitingOn(pid: number, n: () => number): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const [w] = await owner`
        WITH RECURSIVE waiting(pid) AS (
          SELECT a.pid FROM pg_stat_activity a WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
          UNION
          SELECT a.pid FROM pg_stat_activity a JOIN waiting w ON w.pid = ANY(pg_blocking_pids(a.pid))
        ) SELECT count(*)::int AS n FROM waiting`;
      if ((w?.n ?? 0) >= n()) return;
      if (Date.now() > deadline) throw new Error(`fewer than ${n()} sessions reached the barrier`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Run both writes with the gate closed; open it once both wait (each holding its own site's settings row). Returns
   * each write's outcome, the attempts counted and the deadlocks recorded meanwhile.
   */
  async function race(writes: Array<() => Promise<unknown>>) {
    await owner.unsafe(`CREATE TRIGGER heopress_test_slo_settings AFTER UPDATE ON lumibase_site_content_settings
      FOR EACH ROW WHEN (NEW.site_id IN ('${A}', '${B}', '${C}')) EXECUTE FUNCTION heopress_test_slo_barrier('gate')`);
    await owner.unsafe(`CREATE TRIGGER heopress_test_slo_items AFTER UPDATE ON lumibase_items
      FOR EACH ROW WHEN (NEW.site_id IN ('${A}', '${B}', '${C}')) EXECUTE FUNCTION heopress_test_slo_barrier('gate')`);
    const gate = await owner.reserve();
    const before = { attempts: await attempts(), deadlocks: await deadlocks() };
    let outcomes: Array<PromiseSettledResult<unknown>> = [];
    try {
      await gate`SELECT pg_advisory_lock(${GATE})`;
      const [{ pid }] = (await gate`SELECT pg_backend_pid()::int AS pid`) as unknown as [{ pid: number }];
      // A write refused for a business reason never reaches the barrier: wait for the others only.
      let settled = 0;
      const running = Promise.allSettled(writes.map((w) => w().finally(() => settled++)));
      await waitingOn(pid, () => writes.length - settled);
      await gate`SELECT pg_advisory_unlock(${GATE})`;
      outcomes = await running;
    } finally {
      await gate`SELECT pg_advisory_unlock_all()`.catch(() => undefined);
      gate.release();
      await owner.unsafe(`DROP TRIGGER IF EXISTS heopress_test_slo_settings ON lumibase_site_content_settings`);
      await owner.unsafe(`DROP TRIGGER IF EXISTS heopress_test_slo_items ON lumibase_items`);
    }
    // A deadlock's count reaches the shared statistics when the victim's backend flushes them (at most ~1 s later).
    await new Promise((r) => setTimeout(r, 1_500));
    return {
      outcomes: outcomes.map((o) => (o.status === 'fulfilled' ? 'committed' : `${(o.reason as { code?: string }).code ?? ''} ${String((o.reason as Error).message).slice(0, 160)}`)),
      attempts: (await attempts()) - before.attempts,
      deadlocks: (await deadlocks()) - before.deadlocks,
    };
  }

  it('content settings × content settings: both commit, no deadlock, no retry', async () => {
    const result = await race([
      () => updateSettings(A, { timezone: 'Asia/Shanghai' }),
      () => updateSettings(B, { timezone: 'Europe/Berlin' }),
    ]);
    expect(result).toEqual({ outcomes: ['committed', 'committed'], attempts: 2, deadlocks: 0 });
    expect((await settingsRow(A)).timezone).toBe('Asia/Shanghai');
    expect((await settingsRow(B)).timezone).toBe('Europe/Berlin');
    expect((await groupRow(groupId)).siteIds.sort()).toEqual([A, B].sort());
  });

  it('content settings × publishing a group item on the other site: both commit, no deadlock, no retry', async () => {
    const result = await race([
      () => updateSettings(A, { timezone: 'Asia/Shanghai' }),
      () => itemsOf(B).patch('articles', zhDraft.id, { status: 'published', expectedVersion: zhDraft.version }),
    ]);
    expect(result).toEqual({ outcomes: ['committed', 'committed'], attempts: 2, deadlocks: 0 });
    expect((await settingsRow(A)).timezone).toBe('Asia/Shanghai');
    expect((await itemsOf(B).detail('articles', zhDraft.id) as { status: string }).status).toBe('published');
  });

  describe('property: three sites, random cross-site groups, random concurrent writes', () => {
    /** Each site's language in a group, so a group never has two members of one language. */
    const LOCALE: Record<string, string> = { [A]: 'en', [B]: 'zh-CN', [C]: 'ja' };
    const SITES = [A, B, C];

    beforeEach(async () => {
      await fixtures.execute(sql`DELETE FROM lumibase_sites WHERE id = ${C}`);
      await fixtures.insert(sites).values({ id: C, name: `${PREFIX} C` });
      await fixtures.transaction((tx) => ensureContentSettings(tx as never, C));
      const [coll] = await fixtures.insert(collections).values({ siteId: C, name: 'articles', label: 'Articles' }).returning({ id: collections.id });
      await fixtures.insert(fields).values([
        { siteId: C, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' },
        { siteId: C, collectionId: coll!.id, name: 'slug', type: 'string', interface: 'input' },
        { siteId: C, collectionId: coll!.id, name: 'locale', type: 'string', interface: 'input' },
      ]);
      for (const siteId of SITES) {
        await updateSettings(siteId, { availableLocales: ['en', 'zh-CN', 'ja'], permalinks: { articles: '/:slug' }, allowCrossSiteTranslations: true });
      }
      await rebuildSiteProjection(siteDb(C), C);
    });
    afterAll(async () => {
      await fixtures?.execute(sql`DELETE FROM lumibase_sites WHERE id = ${C}`).catch(() => undefined);
    });

    /** Fresh groups for one run: each a set of two or three sites, one draft member per site. */
    async function arrange(groupSites: string[][], run: number): Promise<Map<string, { id: string; version: number }>> {
      await fixtures.execute(sql`DELETE FROM lumibase_translation_groups WHERE site_ids && ${`{${SITES.join(',')}}`}::text[]`);
      const drafts = new Map<string, { id: string; version: number }>();
      for (const [g, members] of groupSites.entries()) {
        let groupIdOf = '';
        let version = 0;
        for (const siteId of members) {
          const slug = `p${run}-g${g}-${LOCALE[siteId]!.toLowerCase()}`;
          const item = (await itemsOf(siteId).create('articles', { data: { title: slug, slug, locale: LOCALE[siteId] } })) as { id: string; version: number };
          if (!groupIdOf) {
            const created = await new TranslationGroupService({ db: siteDb(siteId), siteId, actor: undefined, userId: null, itemsOn: (s, tx) => new ItemService({ db: tx as never, siteId: s }) }).create(item.id);
            groupIdOf = created.id;
            version = created.version;
          } else {
            await groups().addMember(groupIdOf, { siteId, itemId: item.id, expectedVersion: version });
            version = (await groupRow(groupIdOf)).version;
          }
          if (!drafts.has(siteId)) drafts.set(siteId, { id: item.id, version: (await itemsOf(siteId).detail('articles', item.id) as { version: number }).version });
        }
      }
      // A site in no group still publishes an item of its own.
      for (const siteId of SITES) {
        if (drafts.has(siteId)) continue;
        const slug = `p${run}-solo-${LOCALE[siteId]!.toLowerCase()}`;
        const item = (await itemsOf(siteId).create('articles', { data: { title: slug, slug, locale: LOCALE[siteId] } })) as { id: string; version: number };
        drafts.set(siteId, { id: item.id, version: item.version });
      }
      return drafts;
    }

    const siteSet = fc.subarray(SITES, { minLength: 2 });
    const scenario = fc.record({
      groups: fc.array(siteSet, { minLength: 1, maxLength: 2 }),
      writes: fc.uniqueArray(fc.record({ site: fc.constantFrom(...SITES), kind: fc.constantFrom('settings' as const, 'publish' as const) }), {
        minLength: 2,
        maxLength: 3,
        selector: (w) => w.site,
      }),
    });

    it('every write commits; no deadlock is recorded and no attempt runs twice (seed fixed)', async () => {
      let run = 0;
      await fc.assert(
        fc.asyncProperty(scenario, async ({ groups: groupSites, writes }) => {
          run++;
          const drafts = await arrange(groupSites, run);
          const timezoneOf = async (siteId: string) => ((await settingsRow(siteId)).timezone === 'UTC' ? 'Asia/Shanghai' : 'UTC');
          const planned = await Promise.all(
            writes.map(async (w) => {
              if (w.kind === 'settings') {
                const tz = await timezoneOf(w.site);
                return () => updateSettings(w.site, { timezone: tz });
              }
              const d = drafts.get(w.site)!;
              return () => itemsOf(w.site).patch('articles', d.id, { status: 'published', expectedVersion: d.version });
            }),
          );
          const result = await race(planned);
          expect(result).toEqual({ outcomes: writes.map(() => 'committed'), attempts: writes.length, deadlocks: 0 });
        }),
        { seed: 20261031, numRuns: 8, endOnFailure: true },
      );
    }, 300_000);
  });
});
