// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { collections, fields, items, relations, sites, type Database } from '@heopress/database';
import { ItemService } from '../item-service';
import { DependentsService } from '../dependents-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';
import { TranslationGroupService } from '../site-network/translation-group-service';
import { ensureContentSettings } from '../site-network/preset-installer';

/**
 * DB-backed tests for the FK dependent-records handler (Req 1, 4, 5, 6, 7).
 * Models: `comments.article → articles` (m2o). Skips without DATABASE_URL.
 *
 * **Validates: Requirements 1, 4 (restrict blocks), 5 (set_null), 6 (delete), 7 (reassign)**
 */

const SITE = 'site_deps_it';

describe.skipIf(!hasDbIntegrationUrl)('DependentsService — DB integration', () => {
  let db: Database;
  let articlesId = '';
  let commentsId = '';

  beforeAll(async () => {
    db = await connectDbIntegration('dependents-service');
  });

  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Deps IT' });
    articlesId = (await db.insert(collections).values({ siteId: SITE, name: 'articles', label: 'Articles' }).returning({ id: collections.id }))[0]!.id;
    commentsId = (await db.insert(collections).values({ siteId: SITE, name: 'comments', label: 'Comments' }).returning({ id: collections.id }))[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: articlesId, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: commentsId, name: 'body', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: commentsId, name: 'article', type: 'string', interface: 'input' },
    ]);
  });

  async function relation(onDelete: string): Promise<void> {
    await db.delete(relations).where(eq(relations.siteId, SITE));
    await db.insert(relations).values({
      siteId: SITE,
      manyCollection: 'comments',
      manyField: 'article',
      oneCollection: 'articles',
      type: 'm2o',
      onDelete,
    });
  }

  async function seedArticleWithComments(n: number): Promise<{ articleId: string; commentIds: string[] }> {
    const item = new ItemService({ db, siteId: SITE });
    const article = (await item.create('articles', { data: { title: 'A' } })) as { id: string };
    const commentIds: string[] = [];
    for (let i = 0; i < n; i++) {
      const cm = (await item.create('comments', { data: { body: `c${i}`, article: article.id } })) as { id: string };
      commentIds.push(cm.id);
    }
    return { articleId: article.id, commentIds };
  }

  it('finds reverse dependents with the right count + onDelete (Req 1)', async () => {
    await relation('restrict');
    const { articleId } = await seedArticleWithComments(3);
    const svc = new DependentsService({ db, siteId: SITE });
    const report = await svc.report('articles', articleId);
    expect(report.dependents).toHaveLength(1);
    expect(report.dependents[0]).toMatchObject({ collection: 'comments', field: 'article', onDelete: 'restrict', count: 3 });
    expect(report.blocking).toBe(true);
  });

  it('does not block when the relation is set null (Req 4)', async () => {
    await relation('set null');
    const { articleId } = await seedArticleWithComments(2);
    const svc = new DependentsService({ db, siteId: SITE });
    expect((await svc.report('articles', articleId)).blocking).toBe(false);
  });

  it('set_null clears the reference on every dependent (Req 5)', async () => {
    await relation('restrict');
    const { articleId } = await seedArticleWithComments(2);
    const svc = new DependentsService({ db, siteId: SITE });
    const rel = (await db.select({ id: relations.id }).from(relations).where(eq(relations.siteId, SITE)))[0]!;
    const res = await svc.applyResolution('articles', articleId, 'set_null', rel.id);
    expect(res.affected).toBe(2);
    expect((await svc.report('articles', articleId)).dependents).toHaveLength(0);
  });

  it('a shared field of a translation group is not changed in bulk here (P05, design D)', async () => {
    await relation('restrict');
    const { articleId, commentIds } = await seedArticleWithComments(2);
    await db.update(collections).set({ meta: { sharedFields: ['article'] } }).where(eq(collections.id, commentsId));
    try {
      const groups = new TranslationGroupService({ db, siteId: SITE, actor: undefined, userId: null, itemsOn: (siteId, tx) => new ItemService({ db: tx as never, siteId }) });
      const g = await groups.create(commentIds[0]!);
      await groups.addMember(g.id, { itemId: commentIds[1]!, expectedVersion: g.version });
      const svc = new DependentsService({ db, siteId: SITE });
      const rel = (await db.select({ id: relations.id }).from(relations).where(eq(relations.siteId, SITE)))[0]!;
      await expect(svc.applyResolution('articles', articleId, 'set_null', rel.id)).rejects.toMatchObject({ code: 'SHARED_FIELD_IN_GROUP', status: 409 });
      expect((await svc.report('articles', articleId)).dependents[0]).toMatchObject({ count: 2 });
    } finally {
      await db.update(collections).set({ meta: {} }).where(eq(collections.id, commentsId));
    }
  });

  it('an item that starts to reference the target meanwhile is not touched (only the dependents checked)', async () => {
    await relation('restrict');
    await db.transaction((tx) => ensureContentSettings(tx as never, SITE));
    const { articleId, commentIds } = await seedArticleWithComments(1);
    const item = new ItemService({ db, siteId: SITE });
    const other = (await item.create('articles', { data: { title: 'B' } })) as { id: string };
    // S: a group's source whose shared `article` points elsewhere when the resolution enumerates.
    const s = (await item.create('comments', { data: { body: 's', article: other.id } })) as { id: string };
    const t = (await item.create('comments', { data: { body: 't', article: other.id } })) as { id: string };
    await db.update(collections).set({ meta: { sharedFields: ['article'] } }).where(eq(collections.id, commentsId));
    const raw = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
    try {
      const groups = new TranslationGroupService({ db, siteId: SITE, actor: undefined, userId: null, itemsOn: (siteId, tx) => new ItemService({ db: tx as never, siteId }) });
      const g = await groups.create(s.id);
      await groups.addMember(g.id, { itemId: t.id, expectedVersion: g.version });
      const svc = new DependentsService({ db, siteId: SITE });
      const rel = (await db.select({ id: relations.id }).from(relations).where(eq(relations.siteId, SITE)))[0]!;
      let resolving!: Promise<unknown>;
      await raw.begin(async (tx) => {
        // Hold the settings row (the resolution's first lock), then make S reference the target and commit.
        await tx`SELECT 1 FROM lumibase_site_content_settings WHERE site_id = ${SITE} FOR UPDATE`;
        resolving = svc.applyResolution('articles', articleId, 'set_null', rel.id);
        // Barrier: the resolution has enumerated and now waits for the settings row.
        let waiting = 0;
        for (let i = 0; i < 400 && waiting < 1; i++) {
          if (i > 0) await new Promise((ok) => setTimeout(ok, 25));
          const [r] = await tx`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'`;
          waiting = r!.n;
        }
        expect(waiting, 'the resolution waits on the settings row').toBeGreaterThanOrEqual(1);
        await tx`UPDATE lumibase_items SET data = jsonb_set(data, '{article}', to_jsonb(${articleId}::text)) WHERE id = ${s.id}`;
      });
      expect(await resolving).toMatchObject({ affected: 1 });
      const [row] = await db.select({ data: items.data }).from(items).where(eq(items.id, s.id));
      expect((row!.data as { article: string }).article).toBe(articleId);
      void commentIds;
    } finally {
      await raw.end({ timeout: 1 });
      await db.update(collections).set({ meta: {} }).where(eq(collections.id, commentsId));
    }
  });

  it('reassign points dependents at a new target (Req 7)', async () => {
    await relation('restrict');
    const { articleId } = await seedArticleWithComments(2);
    const item = new ItemService({ db, siteId: SITE });
    const other = (await item.create('articles', { data: { title: 'B' } })) as { id: string };
    const svc = new DependentsService({ db, siteId: SITE });
    const rel = (await db.select({ id: relations.id }).from(relations).where(eq(relations.siteId, SITE)))[0]!;
    const res = await svc.applyResolution('articles', articleId, 'reassign', rel.id, { newTargetId: other.id });
    expect(res.affected).toBe(2);
    expect((await svc.report('articles', articleId)).dependents).toHaveLength(0);
    expect((await svc.report('articles', other.id)).dependents[0]?.count).toBe(2);
  });

  it('reassign rejects a missing/self target (Req 7.2)', async () => {
    await relation('restrict');
    const { articleId } = await seedArticleWithComments(1);
    const svc = new DependentsService({ db, siteId: SITE });
    const rel = (await db.select({ id: relations.id }).from(relations).where(eq(relations.siteId, SITE)))[0]!;
    await expect(svc.applyResolution('articles', articleId, 'reassign', rel.id, { newTargetId: 'nope' })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
  });

  it('delete soft-deletes every dependent (Req 6)', async () => {
    await relation('restrict');
    const { articleId, commentIds } = await seedArticleWithComments(2);
    const svc = new DependentsService({ db, siteId: SITE });
    const rel = (await db.select({ id: relations.id }).from(relations).where(eq(relations.siteId, SITE)))[0]!;
    const res = await svc.applyResolution('articles', articleId, 'delete', rel.id);
    expect(res.affected).toBe(2);
    // dependents now soft-deleted → no longer counted.
    expect((await svc.report('articles', articleId)).dependents).toHaveLength(0);
    const [c] = await db.select({ deletedAt: items.deletedAt }).from(items).where(eq(items.id, commentIds[0]!)).limit(1);
    expect(c?.deletedAt).not.toBeNull();
  });

  it('does not count dependents from another site (tenant isolation, Req 1)', async () => {
    await relation('restrict');
    const { articleId } = await seedArticleWithComments(2);

    // A second site with a comment referencing the SAME article id string.
    const SITE_B = `${SITE}_b`;
    await db.delete(sites).where(eq(sites.id, SITE_B));
    await db.insert(sites).values({ id: SITE_B, name: 'Deps IT B' });
    const bArticles = (await db.insert(collections).values({ siteId: SITE_B, name: 'articles', label: 'A' }).returning({ id: collections.id }))[0]!.id;
    const bComments = (await db.insert(collections).values({ siteId: SITE_B, name: 'comments', label: 'C' }).returning({ id: collections.id }))[0]!.id;
    await db.insert(fields).values([
      { siteId: SITE_B, collectionId: bArticles, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE_B, collectionId: bComments, name: 'body', type: 'string', interface: 'input' },
      { siteId: SITE_B, collectionId: bComments, name: 'article', type: 'string', interface: 'input' },
    ]);
    await db.insert(relations).values({ siteId: SITE_B, manyCollection: 'comments', manyField: 'article', oneCollection: 'articles', type: 'm2o', onDelete: 'restrict' });
    const itemB = new ItemService({ db, siteId: SITE_B });
    await itemB.create('comments', { data: { body: 'cross', article: articleId } });

    try {
      // Site A only sees its own 2 comments — never site B's cross-referencing one.
      const svc = new DependentsService({ db, siteId: SITE });
      const report = await svc.report('articles', articleId);
      expect(report.dependents).toHaveLength(1);
      expect(report.dependents[0]!.count).toBe(2);
    } finally {
      await db.delete(sites).where(eq(sites.id, SITE_B)).catch(() => undefined);
    }
  });

  it('set_null is rejected when the field is required (Req 5.3)', async () => {
    await relation('restrict');
    await db.update(fields).set({ required: true }).where(sql`${fields.collectionId} = ${commentsId} and ${fields.name} = 'article'`);
    const { articleId } = await seedArticleWithComments(1);
    const svc = new DependentsService({ db, siteId: SITE });
    const rel = (await db.select({ id: relations.id }).from(relations).where(eq(relations.siteId, SITE)))[0]!;
    await expect(svc.applyResolution('articles', articleId, 'set_null', rel.id)).rejects.toMatchObject({ code: 'FIELD_REQUIRED' });
  });
});
