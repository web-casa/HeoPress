import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  agentApprovals,
  agentGoals,
  agentRuns,
  auditLog,
  collections,
  contentReviews,
  fields,
  items,
  permissions,
  policies,
  relations,
  revisions,
  rolePolicies,
  roles,
  sites,
  userSites,
  users,
  type Database,
} from '@heopress/database';
import { EnvKeyProvider } from '@heopress/runtime';
import { ItemService } from '../item-service';
import { itemServiceForRequest } from '../item-service-factory';
import { VetoService } from '../veto-service';
import { EditorialService } from '../editorial-service';
import { DependentsService } from '../dependents-service';
import { sweepDuePublish } from '../scheduler-worker';
import { migrateBatch } from '../envelope-migration-worker';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Regressions for Codex review P04 round 1 (write safety, tasks 1.x–3.x):
 * each case is a path that could still overwrite a newer version, publish a
 * held item, or misreport a conflict.
 */

const SITE = 'site_write_regress_it';
const PERSON = 'usr_write_regress_person';
const LIMITED = 'usr_write_regress_limited';
const KEK = Buffer.alloc(32, 45).toString('base64');

type Ctx = Parameters<typeof itemServiceForRequest>[0];

/** `db` whose first `select(...)…limit()` runs `edit` after reading — a concurrent write between read and write. */
function editAfterFirstRead(db: Database, edit: () => Promise<void>): Database {
  let fired = false;
  const wrap = (obj: object): object =>
    new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        const fn = value as (...a: unknown[]) => unknown;
        if (prop === 'limit') {
          return (...args: unknown[]) => {
            fired = true;
            return Promise.resolve(fn.apply(target, args) as PromiseLike<unknown>).then(async (rows) => {
              await edit();
              return rows;
            });
          };
        }
        if (prop === 'then') return fn.bind(target);
        return (...args: unknown[]) => {
          const result = fn.apply(target, args);
          return result && typeof result === 'object' ? wrap(result) : result;
        };
      },
    });
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      const fn = (value as (...a: unknown[]) => unknown).bind(target);
      if (prop !== 'select' || fired) return fn;
      return (...args: unknown[]) => wrap(fn(...args) as object);
    },
  }) as Database;
}

describe.skipIf(!hasDbIntegrationUrl)('write safety regressions (Codex P04 round 1) — DB integration', () => {
  let db: Database;
  let collId = '';
  let itemId = '';
  let runId = '';

  beforeAll(async () => {
    db = await connectDbIntegration('write-safety-regressions');
  });
  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, PERSON)).catch(() => undefined);
    await db.delete(users).where(eq(users.id, LIMITED)).catch(() => undefined);
  });

  const system = () => new ItemService({ db, siteId: SITE });
  const stored = async (id = itemId) => (await db.select().from(items).where(eq(items.id, id)))[0]!;

  /** An ItemService as the request path builds it, for `auth`. */
  function forRequest(auth: Record<string, unknown>): ItemService {
    const c = {
      get: (k: string) =>
        ({ auth, db, siteId: SITE, runtime: { cache: undefined, search: undefined, queue: undefined, keys: undefined } })[k],
      env: {},
      req: { raw: { headers: new Headers() }, header: () => undefined },
    } as unknown as Ctx;
    return itemServiceForRequest(c);
  }

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Write safety regressions IT' });
    await db
      .insert(users)
      .values([
        { id: PERSON, email: 'regress-person@example.test', status: 'active' },
        { id: LIMITED, email: 'regress-limited@example.test', status: 'active' },
      ])
      .onConflictDoNothing();
    const [adminRole, limitedRole] = await db
      .insert(roles)
      .values([
        { siteId: SITE, name: 'Admin', adminAccess: true, appAccess: true },
        { siteId: SITE, name: 'Limited', adminAccess: false, appAccess: true },
      ])
      .returning({ id: roles.id });
    await db.insert(userSites).values([
      { userId: PERSON, siteId: SITE, roleId: adminRole!.id },
      { userId: LIMITED, siteId: SITE, roleId: limitedRole!.id },
    ]);
    // May read and update `title` only, and may never set status to published.
    const [policy] = await db
      .insert(policies)
      .values({ siteId: SITE, name: 'Limited', key: 'regress-limited', adminAccess: false, appAccess: true })
      .returning({ id: policies.id });
    await db.insert(permissions).values([
      { siteId: SITE, policyId: policy!.id, collection: 'articles', action: 'read', fields: ['title'] },
      {
        siteId: SITE,
        policyId: policy!.id,
        collection: 'articles',
        action: 'update',
        fields: ['*'],
        validation: { status: { _eq: 'draft' } },
      },
    ]);
    await db.insert(rolePolicies).values({ roleId: limitedRole!.id, policyId: policy!.id });

    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: 'articles', label: 'Articles' })
      .returning({ id: collections.id });
    collId = coll!.id;
    await db.insert(fields).values([
      { siteId: SITE, collectionId: collId, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: collId, name: 'secret', type: 'string', interface: 'input' },
    ]);
    itemId = ((await system().create('articles', { data: { title: 'original', secret: 's1' } })) as { id: string }).id;
    const [goal] = await db.insert(agentGoals).values({ siteId: SITE, title: 'g' }).returning({ id: agentGoals.id });
    const [run] = await db.insert(agentRuns).values({ siteId: SITE, goalId: goal!.id }).returning({ id: agentRuns.id });
    runId = run!.id;
  });

  it('#1 a staged AI change keeps the version the agent read: an earlier human edit supersedes it', async () => {
    // The agent read version 1; a person saves (v2) before the change is staged.
    await forRequest({ type: 'user', userId: PERSON, roles: [], raw: {} }).patch('articles', itemId, {
      data: { title: 'person' },
      expectedVersion: 1,
    });
    const veto = new VetoService({ db, siteId: SITE, vetoWindowMs: 60_000 });
    const staged = await veto.stageItemPatch({
      runId,
      agentRole: 'writer',
      capability: 'items:update',
      collection: 'articles',
      itemId,
      patch: { title: 'agent' },
      expectedVersion: 1,
    });
    await db.update(agentApprovals).set({ autoCommitAt: new Date(Date.now() - 1000) }).where(eq(agentApprovals.id, staged.approvalId));
    expect((await veto.commit(staged.approvalId, system())).outcome).toBe('noop');
    expect((await stored()).data).toMatchObject({ title: 'person' });
  });

  it('#2 envelope migration does not overwrite a save made after it read the row', async () => {
    const keyProvider = new EnvKeyProvider(new Map([['v0', KEK]]), 'v0');
    await db.insert(fields).values({
      siteId: SITE,
      collectionId: collId,
      name: 'ssn',
      type: 'string',
      interface: 'input',
      encrypted: true,
      classification: 'phi',
    });
    const enc = () => new ItemService({ db, siteId: SITE, keyProvider });
    const id = ((await enc().create('articles', { data: { title: 'before', ssn: '123' } })) as { id: string }).id;
    const raced = editAfterFirstRead(db, async () => {
      await enc().patch('articles', id, { data: { title: 'saved meanwhile' }, expectedVersion: 1 });
    });
    await migrateBatch({ db: raced, siteId: SITE, keyProvider }, 'to_envelope');
    const row = await stored(id);
    expect((row.data as Record<string, unknown>).title).toBe('saved meanwhile');
    expect(row.version).toBe(2);
  });

  it('#4 resolving dependents refuses to change a held published item', async () => {
    await db.insert(fields).values({ siteId: SITE, collectionId: collId, name: 'parent', type: 'string', interface: 'input' });
    await db.insert(relations).values({
      siteId: SITE,
      manyCollection: 'articles',
      manyField: 'parent',
      oneCollection: 'articles',
      onDelete: 'restrict',
    } as never);
    const child = ((await system().create('articles', { data: { title: 'child', parent: itemId } })) as { id: string }).id;
    await system().patch('articles', child, { status: 'published', expectedVersion: 1 });
    await system().setHold('articles', child, true, 2);
    const deps = new DependentsService({ db, siteId: SITE, userId: PERSON });
    const relation = (await db.select().from(relations).where(eq(relations.siteId, SITE)))[0]!;
    await expect(deps.applyResolution('articles', itemId, 'set_null', relation.id)).rejects.toMatchObject({
      code: 'ITEM_HELD',
    });
    expect((await stored(child)).data).toMatchObject({ parent: itemId });
  });

  it('#5 the scheduler does not publish an item rescheduled after it was found due', async () => {
    await db.update(items).set({ publishAt: new Date(Date.now() - 60_000) }).where(eq(items.id, itemId));
    const raced = editAfterFirstRead(db, async () => {
      await system().patch('articles', itemId, { publishAt: new Date(Date.now() + 86_400_000), expectedVersion: 1 });
    });
    expect(await sweepDuePublish({ db: raced })).toBe(0);
    expect((await stored()).status).toBe('draft');
  });

  it('#6 two reviewers deciding at once: one decision applies; a stale decision is refused', async () => {
    const editorial = (userId: string) => new EditorialService({ db, siteId: SITE, userId });
    await editorial(PERSON).submitReview('articles', itemId);
    const v = (await stored()).version;
    const results = await Promise.allSettled([
      editorial(PERSON).approve('articles', itemId, { expectedVersion: v }),
      editorial(PERSON).reject('articles', itemId, { reason: 'no', expectedVersion: v }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const reviews = await db.select().from(contentReviews).where(eq(contentReviews.itemId, itemId));
    expect(reviews.filter((r) => r.status !== 'pending')).toHaveLength(1);
    await expect(editorial(PERSON).submitReview('articles', itemId, { expectedVersion: 1 })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
  });

  it('#7 a person whose rules forbid publishing cannot release a hold', async () => {
    await system().setHold('articles', itemId, true, 1);
    const limited = forRequest({ type: 'user', userId: LIMITED, roles: [], raw: {} });
    await expect(limited.setHold('articles', itemId, false, 2)).rejects.toMatchObject({ code: 'HOLD_RELEASE_REQUIRES_PUBLISH' });
    expect((await stored()).hold).toBe(true);
  });

  it('#8 a repeated id in one bulk create fails that entry only', async () => {
    await db.insert(collections).values({ siteId: SITE, name: 'keyed', label: 'Keyed', primaryKeyType: 'string' });
    const keyedId = (await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, SITE), eq(collections.name, 'keyed'))))[0]!.id;
    await db.insert(fields).values({ siteId: SITE, collectionId: keyedId, name: 'title', type: 'string', interface: 'input' });
    const results = await system().bulk('keyed', 'create', [
      { id: 'dup-1', title: 'a' },
      { id: 'dup-1', title: 'b' },
      { id: 'dup-2', title: 'c' },
    ]);
    expect(results.map((r) => [r.index, r.status, r.code])).toEqual([
      [0, 'succeeded', undefined],
      [1, 'failed', 'DUPLICATE_ID'],
      [2, 'succeeded', undefined],
    ]);
  });

  it('#10 a conflict names only fields the caller may read', async () => {
    await system().patch('articles', itemId, { data: { title: 't2', secret: 's2' }, expectedVersion: 1 });
    const limited = forRequest({ type: 'user', userId: LIMITED, roles: [], raw: {} });
    await expect(limited.patch('articles', itemId, { data: { title: 'stale' }, expectedVersion: 1 })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      changedFields: ['title'],
    });
  });

  it('#11 an API key edit is not a person’s: an agent’s stale result is a conflict, not superseded', async () => {
    const key = forRequest({ type: 'api_key', apiKeyId: 'key_regress', apiKey: { id: 'key_regress' }, raw: {} });
    // System write on behalf of the key: no RBAC rows for the key in this fixture.
    const byKey = new ItemService({ db, siteId: SITE, provenance: (key as unknown as { provenance: never }).provenance });
    await byKey.patch('articles', itemId, { data: { title: 'integration' }, expectedVersion: 1 });
    const [rev] = await db
      .select({ authorType: revisions.authorType })
      .from(revisions)
      .where(and(eq(revisions.itemId, itemId), eq(revisions.itemVersion, 2)));
    expect(rev!.authorType).toBe('integration');
    const agent = system();
    agent.setProvenance({ authorType: 'agent', runId });
    await expect(agent.patch('articles', itemId, { data: { title: 'agent' }, expectedVersion: 1 })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'ai_result_superseded')));
    expect(audits).toHaveLength(0);
  });
});
