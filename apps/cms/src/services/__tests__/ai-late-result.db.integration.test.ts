import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  agentApprovals,
  agentGoals,
  agentRuns,
  auditLog,
  collections,
  fields,
  items,
  sites,
  type Database,
} from '@heopress/database';
import { ItemService } from '../item-service';
import { VetoService } from '../veto-service';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Late AI results (HeoPress P04 task 3.1; spec content/write-concurrency
 * "晚到的 AI 结果不覆盖人工修改"): an AI write based on a version a person has
 * since edited is not written back — it is recorded as superseded and
 * audited. When only other agents changed the item it is a plain version
 * conflict. The L3 veto window follows the same rule at commit time.
 */

const SITE = 'site_ai_late_it';

describe.skipIf(!hasDbIntegrationUrl)('late AI results never overwrite a person — DB integration', () => {
  let db: Database;
  let itemId = '';
  let runId = '';

  beforeAll(async () => {
    db = await connectDbIntegration('ai-late-result');
  });
  afterAll(async () => {
    if (!db) return;
    await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  const human = () => new ItemService({ db, siteId: SITE });
  const agent = () => {
    const svc = new ItemService({ db, siteId: SITE });
    svc.setProvenance({ authorType: 'agent', runId });
    return svc;
  };
  const stored = async () => (await db.select().from(items).where(eq(items.id, itemId)))[0]!;
  const supersededAudits = () =>
    db.select().from(auditLog).where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'ai_result_superseded')));

  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'AI late result IT' });
    const [coll] = await db
      .insert(collections)
      .values({ siteId: SITE, name: 'articles', label: 'Articles' })
      .returning({ id: collections.id });
    await db.insert(fields).values([
      { siteId: SITE, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: coll!.id, name: 'quality', type: 'string', interface: 'input' },
    ]);
    itemId = ((await human().create('articles', { data: { title: 'original' } })) as { id: string }).id;
    const [goal] = await db.insert(agentGoals).values({ siteId: SITE, title: 'quality check' }).returning({ id: agentGoals.id });
    const [run] = await db.insert(agentRuns).values({ siteId: SITE, goalId: goal!.id }).returning({ id: agentRuns.id });
    runId = run!.id;
  });

  it('a quality check that started before an editor saved is not written back, and is audited', async () => {
    // The AI task read version 1; meanwhile the editor saves.
    await human().patch('articles', itemId, { data: { title: 'edited by a person' }, expectedVersion: 1 });

    await expect(
      agent().patch('articles', itemId, { data: { quality: 'pass', title: 'AI rewrite' }, expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'AI_RESULT_SUPERSEDED', status: 409, currentVersion: 2 });

    const row = await stored();
    expect(row.data).toEqual({ title: 'edited by a person' });
    expect(row.version).toBe(2);
    const audits = await supersededAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata).toMatchObject({ itemId, runId, baseVersion: 1, currentVersion: 2, changedFields: ['title'] });
  });

  it('when only another agent changed the item it is a version conflict, not superseded', async () => {
    await agent().patch('articles', itemId, { data: { title: 'other agent' }, expectedVersion: 1 });
    await expect(agent().patch('articles', itemId, { data: { quality: 'pass' }, expectedVersion: 1 })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
    expect(await supersededAudits()).toHaveLength(0);
  });

  it('a person saving on a stale version gets a version conflict (people are never "superseded")', async () => {
    await agent().patch('articles', itemId, { data: { quality: 'pass' }, expectedVersion: 1 });
    await expect(human().patch('articles', itemId, { data: { title: 'stale' }, expectedVersion: 1 })).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
    });
  });

  it('veto window: a person editing during the window supersedes the staged AI change', async () => {
    const veto = new VetoService({ db, siteId: SITE, vetoWindowMs: 60_000 });
    const staged = await veto.stageItemPatch({
      runId,
      agentRole: 'writer',
      capability: 'items:update',
      collection: 'articles',
      itemId,
      patch: { title: 'agent title' },
    });
    await human().patch('articles', itemId, { data: { title: 'edited during the window' }, expectedVersion: 1 });
    await db.update(agentApprovals).set({ autoCommitAt: new Date(Date.now() - 1000) }).where(eq(agentApprovals.id, staged.approvalId));

    const result = await veto.commit(staged.approvalId, new ItemService({ db, siteId: SITE }));
    expect(result.outcome).toBe('noop');
    expect((await stored()).data).toEqual({ title: 'edited during the window' });
    const [approval] = await db.select().from(agentApprovals).where(eq(agentApprovals.id, staged.approvalId));
    expect(approval).toMatchObject({ status: 'superseded', decisionReason: 'auto_commit_superseded' });
    expect(await supersededAudits()).toHaveLength(1);
  });

  it('veto window: without an edit the staged change commits', async () => {
    const veto = new VetoService({ db, siteId: SITE, vetoWindowMs: 60_000 });
    const staged = await veto.stageItemPatch({
      runId,
      agentRole: 'writer',
      capability: 'items:update',
      collection: 'articles',
      itemId,
      patch: { title: 'agent title' },
    });
    await db.update(agentApprovals).set({ autoCommitAt: new Date(Date.now() - 1000) }).where(eq(agentApprovals.id, staged.approvalId));
    expect((await veto.commit(staged.approvalId, new ItemService({ db, siteId: SITE }))).outcome).toBe('committed');
    expect((await stored()).data).toEqual({ title: 'agent title' });
  });
});
