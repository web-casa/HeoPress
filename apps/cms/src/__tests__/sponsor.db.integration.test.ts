import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { and, asc, eq } from 'drizzle-orm';
import { auditLog, cdcChangeEvents, revisions, siteContentSettings, sites, type Database } from '@heopress/database';
import type { AppEnv } from '../env';
import { siteRouter } from '../routes/site';
import { ReleaseService } from '../services/release-service';
import { ItemService } from '../services/item-service';
import { ContentSettingsService } from '../services/site-network/content-settings-service';
import { upgradeSitePreset } from '../services/site-network/preset-installer';
import { listPublishedSponsored } from '../services/site-network/sponsored-items';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * Sponsored content (HeoPress P05 task 1.9; spec content/site-network-model
 * "赞助内容标记"; design F, H): an item's marking is kept as is; changing it
 * on a published item needs a reason and is audited with before and after;
 * a sponsor policy change emits the settings event renderers act on, and
 * the published sponsored items can be walked page by page.
 */

const SITE = 'site_p05_sponsor_it';

describe.skipIf(!hasDbIntegrationUrl)('sponsored content — DB integration', () => {
  let db: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('sponsor');
  });
  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Sponsor', defaultLanguage: 'en' });
    await upgradeSitePreset(db, SITE);
  });
  afterAll(async () => {
    await db?.delete(sites).where(eq(sites.id, SITE));
  });

  const svc = () => new ItemService({ db, siteId: SITE, userId: null });
  const article = (slug: string, extra: Record<string, unknown>, status = 'published') =>
    svc().create('articles', { data: { title: slug, slug, locale: 'en', ...extra }, status }) as Promise<{ id: string; version: number }>;
  const policy = async (over: Record<string, unknown>) => {
    const [r] = await db.select().from(siteContentSettings).where(eq(siteContentSettings.siteId, SITE));
    return new ContentSettingsService({ db, siteId: SITE, actor: { userId: null } }).update({
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
  };
  const codeOf = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code ?? String(e));

  it('spec "取消已发布条目的赞助标记": a reason is required; the audit has the operator, the reason, before and after', async () => {
    const a = await article('paid-post', { sponsored: true, sponsor_name: 'Acme' });
    expect(await codeOf(svc().patch('articles', a.id, { data: { sponsored: false }, expectedVersion: a.version }))).toBe('REASON_REQUIRED');
    expect(await codeOf(svc().patch('articles', a.id, { data: { sponsor_name: 'Acme Ltd' }, expectedVersion: a.version, reason: '  ' }))).toBe('REASON_REQUIRED');
    await svc().patch('articles', a.id, { data: { sponsored: false }, expectedVersion: a.version, reason: 'The campaign ended' });
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'item_sponsor_changed')));
    expect(audits.map((x) => x.metadata)).toEqual([
      expect.objectContaining({
        itemId: a.id,
        reason: 'The campaign ended',
        operator: null,
        before: { sponsored: true, sponsor_name: 'Acme' },
        after: { sponsored: false, sponsor_name: 'Acme' },
      }),
    ]);
  });

  it('drafts and other fields change without a reason; the marking is kept whatever the policy', async () => {
    const d = await article('draft-paid', { sponsored: true }, 'draft');
    expect(await codeOf(svc().patch('articles', d.id, { data: { sponsored: false }, expectedVersion: d.version }))).toBe('ok');
    const a = await article('live-paid', { sponsored: true, sponsor_name: 'Acme' });
    expect(await codeOf(svc().patch('articles', a.id, { data: { title: 'New title' }, expectedVersion: a.version }))).toBe('ok');
    await policy({ sponsorDisclosure: false, sponsorRel: false, reason: 'test', riskAcknowledged: ['disclosure', 'rel'] });
    const [row] = (await listPublishedSponsored(db, SITE, { limit: 10 })).items;
    expect(row).toMatchObject({ id: a.id, sponsorName: 'Acme' });
  });

  it('spec "重新开启开关": sponsored articles published while both switches were off are found again, and the change emits the settings event', async () => {
    await policy({ sponsorDisclosure: false, sponsorRel: false, reason: 'trial', riskAcknowledged: ['disclosure', 'rel'] });
    const paid = [await article('p1', { sponsored: true }), await article('p2', { sponsored: true }), await article('p3', { sponsored: true })];
    await article('editorial', { sponsored: false });
    await article('paid-draft', { sponsored: true }, 'draft');
    await policy({ sponsorDisclosure: true, reason: 'Back to disclosing' });
    const events = await db
      .select()
      .from(cdcChangeEvents)
      .where(and(eq(cdcChangeEvents.siteId, SITE), eq(cdcChangeEvents.resource, 'site_content_settings')))
      // The feed's own order: without it "the last event" is whatever row the table returns last.
      .orderBy(asc(cdcChangeEvents.txid), asc(cdcChangeEvents.seq));
    const last = events.at(-1)!;
    expect(last).toMatchObject({ itemId: SITE, operation: 'update', changedFields: ['sponsorDisclosure'] });
    expect(last.payload).toMatchObject({ sponsor: { before: { disclosure: false, rel: false }, after: { disclosure: true, rel: false }, policyVersion: 3 } });
    // Walked two at a time, every published sponsored article, once.
    const seen: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await listPublishedSponsored(db, SITE, { after, limit: 2 });
      seen.push(...page.items.map((i) => i.id));
      if (!page.next) break;
      after = page.next;
    }
    expect(seen.sort()).toEqual(paid.map((p) => p.id).sort());
  });

  it('settings changes without a sponsor change still emit the event (no sponsor payload)', async () => {
    await policy({ timezone: 'Asia/Shanghai' });
    const [ev] = await db
      .select()
      .from(cdcChangeEvents)
      .where(and(eq(cdcChangeEvents.siteId, SITE), eq(cdcChangeEvents.resource, 'site_content_settings')));
    expect(ev).toMatchObject({ changedFields: expect.arrayContaining(['timezone']), payload: null });
  });

  it('reverting to a revision with another sponsor marking needs a reason too; API keys are named in the audit', async () => {
    const a = await article('rev-paid', { sponsored: true, sponsor_name: 'Acme' });
    const keyed = new ItemService({ db, siteId: SITE, userId: null, cdcActor: { type: 'api_key', id: 'key_1' } });
    const off = (await keyed.patch('articles', a.id, { data: { sponsored: false }, expectedVersion: a.version, reason: 'ended' })) as { version: number };
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'item_sponsor_changed')));
    expect(audit!.metadata).toMatchObject({ actor: { type: 'api_key', id: 'key_1' } });
    const [first] = await db.select().from(revisions).where(eq(revisions.itemId, a.id)).orderBy(revisions.createdAt).limit(1);
    expect(await codeOf(svc().revertRevision('articles', a.id, first!.id, off.version))).toBe('REASON_REQUIRED');
    expect(await codeOf(svc().revertRevision('articles', a.id, first!.id, off.version, 'restored the campaign'))).toBe('ok');
  });

  it('a release pinning a revision with another sponsor marking is stopped before publishing, with a clear reason', async () => {
    const a = await article('rel-paid', { sponsored: true });
    const off = (await svc().patch('articles', a.id, { data: { sponsored: false }, expectedVersion: a.version, reason: 'ended' })) as { version: number };
    await svc().patch('articles', a.id, { data: { sponsored: true }, expectedVersion: off.version, reason: 'back on' });
    const revs = await db.select().from(revisions).where(eq(revisions.itemId, a.id)).orderBy(revisions.createdAt);
    const releases = new ReleaseService({ db, siteId: SITE });
    const release = await releases.create({ name: 'Pinned' });
    await releases.patch(release!.id, { addItems: [{ collection: 'articles', itemId: a.id, targetStatus: 'published', revisionId: revs[1]!.id }] });
    const result = await releases.publish(release!.id, { trigger: 'manual' });
    expect(result.outcomes).toEqual([expect.objectContaining({ itemId: a.id, outcome: 'failed', reason: 'SPONSOR_REASON_REQUIRED' })]);
  });

  it('the sponsored list is for site administrators only (it ignores content permissions)', async () => {
    const app = (auth: Record<string, unknown>) => {
      const h = new Hono<AppEnv>();
      h.use('*', async (c, next) => {
        c.set('db', db);
        c.set('siteId', SITE);
        c.set('auth', auth as never);
        await next();
      });
      h.route('/api/v1/site', siteRouter);
      return h;
    };
    expect((await app({ type: 'anonymous' }).request('/api/v1/site/sponsored-items')).status).toBe(403);
    expect((await app({ type: 'user', raw: { dev: true }, roles: ['admin'] }).request('/api/v1/site/sponsored-items')).status).toBe(200);
  });

  it('a default language "change" to the same language emits no event', async () => {
    const service = new ContentSettingsService({ db, siteId: SITE, actor: { userId: null } });
    await service.updateSite({ defaultLanguage: 'en' });
    const events = await db.select().from(cdcChangeEvents).where(and(eq(cdcChangeEvents.siteId, SITE), eq(cdcChangeEvents.resource, 'site_content_settings')));
    expect(events).toEqual([]);
  });
});
