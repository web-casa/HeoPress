import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { and, eq } from 'drizzle-orm';
import { collections, fields, siteContentSettings, siteDomains, translationGroups, type Database } from '@heopress/database';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { ensureContentSettings } from '../services/site-network/preset-installer';
import { TranslationGroupService } from '../services/site-network/translation-group-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Translation groups, as a property (HeoPress P05 task 6.1; ADR-0017; design H): for any switch
 * settings and URL settings (trailing slash, prefix mode) of two sites of the site-network preset (the
 * one preset there is), any members (site, language, status, internal-only source) and any caller,
 *
 *   - public data (the language switch) holds exactly the members `publicItemPredicate` lets through
 *     — published, not internal-only — and another site's only while both sites have the switch on;
 *   - a management read shows in full only members the caller may read on their own site, and the
 *     others only as public summaries under the same rule — never a draft, never more.
 *
 * Failing examples are kept as regression cases below (none so far); seeds are not changed to pass.
 */

const LOCALES = ['zh-CN', 'pt', 'vi', 'ja', 'he'] as const;
const HOST = { a: 'tgp-a.example.com', b: 'tgp-b.example.com' } as const;

describe.skipIf(!hasDbIntegrationUrl)('translation groups — properties (DB integration)', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let run = 0;

  beforeAll(async () => {
    db = await connectDbIntegration('translation-groups-property');
    fx = await createCrossSiteFixture(db, { prefix: 'tgp', jwtSecret: 'tgp' });
    for (const site of ['a', 'b'] as const) {
      const siteId = fx.sites[site];
      await db.transaction((tx) => ensureContentSettings(tx as never, siteId));
      const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, 'articles')));
      await db.insert(fields).values({ siteId, collectionId: coll!.id, name: 'locale', type: 'string', interface: 'input' });
      await db.insert(siteDomains).values({ siteId, hostname: HOST[site], kind: 'custom', status: 'active', isPrimary: true, verifiedAt: new Date() });
      await setSettings(site, { availableLocales: ['en', ...LOCALES], permalinks: { articles: '/:slug' }, allowCrossSiteTranslations: true });
    }
  });
  afterAll(async () => {
    if (fx) await fx.teardown();
  });

  async function setSettings(site: 'a' | 'b', over: Record<string, unknown>) {
    const siteId = fx.sites[site];
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
    await new ContentSettingsService({ db, siteId, actor: { userId: null } }).update({
      availableLocales: r!.availableLocales,
      timezone: r!.timezone,
      siteType: 'blog',
      trailingSlash: r!.trailingSlash as 'always',
      localeStrategy: r!.localeStrategy as 'subdirectory',
      localePrefixMode: r!.localePrefixMode as 'default_at_root',
      localePrefixes: r!.localePrefixes,
      permalinks: r!.permalinks,
      allowCrossSiteTranslations: r!.allowCrossSiteTranslations,
      sponsorDisclosure: true,
      sponsorRel: true,
      version: r!.version,
      ...over,
    } as never);
  }

  /** The service as the system (setup) or as a person (fixture memberships decide per site). */
  const system = () =>
    new TranslationGroupService({ db, siteId: fx.sites.a, actor: undefined, userId: null, itemsOn: (siteId, tx) => new ItemService({ db: tx as never, siteId }) });
  const asPerson = (userId: string) =>
    new TranslationGroupService({
      db,
      siteId: fx.sites.a,
      actor: { type: 'user', id: userId },
      userId,
      itemsOn: (siteId, tx) =>
        new ItemService({ db: tx as never, siteId, userId, permissionCtx: { userId, siteId, roleId: null, user: { id: userId, email: null, roles: [] }, ip: null, headers: {}, apiKey: null, principal: 'user' } }),
    });
  /** Who may read articles where (cross-site fixture: onlyA → A, both → A and B, onlyB → B). */
  const READS: Record<'onlyA' | 'both' | 'onlyB', Array<'a' | 'b'>> = { onlyA: ['a'], both: ['a', 'b'], onlyB: ['b'] };

  const memberArb = fc.record({ site: fc.constantFrom('a' as const, 'b' as const), published: fc.boolean() });
  const caseArb = fc.record({
    sourcePublished: fc.boolean(),
    sourceInternal: fc.boolean(),
    members: fc.array(memberArb, { maxLength: LOCALES.length }),
    switchA: fc.boolean(),
    switchB: fc.boolean(),
    caller: fc.constantFrom('onlyA' as const, 'both' as const, 'onlyB' as const),
    // Each site's URL settings vary too (the language switch must hold whatever they are).
    settingsA: fc.record({ trailingSlash: fc.constantFrom('always' as const, 'never' as const), localePrefixMode: fc.constantFrom('default_at_root' as const, 'all_prefixed' as const) }),
    settingsB: fc.record({ trailingSlash: fc.constantFrom('always' as const, 'never' as const), localePrefixMode: fc.constantFrom('default_at_root' as const, 'all_prefixed' as const) }),
  });

  it('public data and management reads never exceed what is authorised', async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async (c) => {
        run++;
        await setSettings('a', { allowCrossSiteTranslations: true, ...c.settingsA });
        await setSettings('b', { allowCrossSiteTranslations: true, ...c.settingsB });
        const items = { a: new ItemService({ db, siteId: fx.sites.a }), b: new ItemService({ db, siteId: fx.sites.b }) };
        const internal = c.sourceInternal && !c.sourcePublished;
        const source = (await items.a.create('articles', { data: { title: 's', slug: `p${run}-s`, locale: 'en' }, status: c.sourcePublished ? 'published' : 'draft' })) as { id: string };
        const g = await system().create(source.id);
        if (internal) await system().setInternalOnly(g.id, source.id, true, g.version);
        const all: Array<{ id: string; site: 'a' | 'b'; locale: string; published: boolean; internal: boolean }> = [
          { id: source.id, site: 'a', locale: 'en', published: c.sourcePublished, internal },
        ];
        for (const [i, m] of c.members.entries()) {
          const locale = LOCALES[i]!;
          const row = (await items[m.site].create('articles', { data: { title: 'm', slug: `p${run}-m${i}`, locale }, status: m.published ? 'published' : 'draft' })) as { id: string };
          const [v] = await db.select({ v: translationGroups.version }).from(translationGroups).where(eq(translationGroups.id, g.id));
          await system().addMember(g.id, { siteId: fx.sites[m.site], itemId: row.id, expectedVersion: v!.v });
          all.push({ id: row.id, site: m.site, locale, published: m.published, internal: false });
        }
        await setSettings('a', { allowCrossSiteTranslations: c.switchA });
        await setSettings('b', { allowCrossSiteTranslations: c.switchB });
        const crossOk = c.switchA && c.switchB;
        const isPublic = (m: (typeof all)[number]) => m.published && !m.internal && (m.site === 'a' || crossOk);
        try {
          // Public data, seen from A's source.
          const alternates = await system().alternates('articles', source.id);
          expect(alternates.map((x) => x.locale).sort()).toEqual(all.filter(isPublic).map((m) => m.locale).sort());

          // A management read by the caller (from site A; a caller with no member readable there gets 404).
          const view = await asPerson(fx.users[c.caller].id)
            .get(g.id)
            .catch((e: { status?: number }) => (e.status === 404 ? null : Promise.reject(e)));
          const readable = all.filter((m) => READS[c.caller].includes(m.site));
          if (readable.length === 0) {
            expect(view).toBeNull();
            return;
          }
          expect(view!.members.map((m) => m.itemId).sort()).toEqual(readable.map((m) => m.id).sort());
          const unreadablePublic = all.filter((m) => !READS[c.caller].includes(m.site) && isPublic(m));
          expect(view!.public.map((p) => p.locale).sort()).toEqual(unreadablePublic.map((m) => m.locale).sort());
          const leaked = JSON.stringify(view);
          for (const m of all) if (!READS[c.caller].includes(m.site)) expect(leaked).not.toContain(m.id);
        } finally {
          await db.delete(translationGroups).where(eq(translationGroups.id, g.id));
        }
      }),
      { numRuns: 25 },
    );
    // 25 runs of group writes, each through the projection: ~4 s locally, up to ~15 s on a shared CI runner (the
    // default limit), so its own limit.
  }, 60_000);
});
