import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { SearchProvider } from '@heopress/runtime';
import { collections, fields, gitSnapshotQueue, gitSnapshotRepos, renderCache, siteRenderVersions, sites, type Database } from '@heopress/database';
import { EventConsumerRunner, type EventConsumerDefinition } from '../../modules/events/consumer-runner';
import { listConsumers, listDeadLetters, replayConsumer } from '../../modules/events/consumer-ops';
import { ItemService } from '../item-service';
import { latestReconciliationReport, runStateReconciliation, setAstroStateReconciliation, type StateReconciler } from '../publishing/state-reconciliation';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * Event consumer operations and the unified state reconciliation (HeoPress P11 tasks 1.1, 1.2; spec
 * publishing/event-consumers): backlog and dead letters per consumer, replay from a chosen position under the
 * idempotency rules, and — when content committed but its event was never written — the reconciliation still repairs
 * the downstream state (render cache, search index) and reports what the hooks (Git, Astro) found.
 */

const SITE = 'site_p11_reconcile_it';

describe.skipIf(!hasDbIntegrationUrl)('event consumer operations and state reconciliation — DB integration', () => {
  let db: Database;
  let raw: postgres.Sql;
  let n = 0;
  const consumerName = (label: string) => `test-p11:${label}:${++n}:${Date.now()}`;

  beforeAll(async () => {
    db = await connectDbIntegration('state-reconciliation');
    raw = postgres(process.env.DATABASE_URL!, { max: 2, onnotice: () => {} });
  });
  afterAll(async () => {
    if (db) {
      await db.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
      await db.execute(sql`DELETE FROM lumibase_event_consumers WHERE name LIKE 'test-p11:%'`);
    }
    await raw?.end({ timeout: 1 });
  });
  beforeEach(async () => {
    await db.delete(sites).where(eq(sites.id, SITE));
    await db.insert(sites).values({ id: SITE, name: 'Reconcile IT' });
  });

  async function emit(itemId: string, occurredAt?: Date): Promise<string> {
    const id = `ev_${itemId}_${Math.random().toString(36).slice(2, 8)}`;
    await raw`INSERT INTO lumibase_cdc_change_events (id, site_id, collection, item_id, operation, actor_type, source, occurred_at)
              VALUES (${id}, ${SITE}, 'articles', ${itemId}, 'update', 'system', 'system', ${occurredAt ?? new Date()})`;
    return id;
  }

  it('task 1.1: backlog, dead letters, and replay from a chosen time re-handles events and retries dead letters', async () => {
    const handled: string[] = [];
    const def: EventConsumerDefinition = {
      name: consumerName('replay'),
      siteId: SITE,
      startFrom: 'head',
      retryBaseMs: 0,
      maxAttempts: 1,
      handle: async (e) => {
        if (e.itemId === 'bad' && !handled.includes('fixed')) throw new Error('downstream refused');
        handled.push(e.itemId);
      },
    };
    const runner = new EventConsumerRunner(db);
    await runner.register(def);
    const old = new Date(Date.now() - 20 * 60_000);
    await emit('a', old);
    const badId = await emit('bad', new Date(Date.now() - 15 * 60_000));
    await emit('c');

    // Not run yet: the oldest pending event waits for 20 minutes — over the 10-minute threshold.
    const before = (await listConsumers(db)).find((c) => c.name === def.name)!;
    expect(before.pending).toBe(3);
    expect(before.backlogSeconds).toBeGreaterThan(19 * 60);
    expect(before.overThreshold).toBe(true);

    await runner.runOnce(def);
    expect(handled).toEqual(['a', 'c']);
    const after = (await listConsumers(db)).find((c) => c.name === def.name)!;
    expect(after).toMatchObject({ pending: 0, backlogSeconds: 0, overThreshold: false, failures: { dead: 1 } });
    const dead = await listDeadLetters(db, def.name);
    expect(dead).toEqual([expect.objectContaining({ eventId: badId, state: 'dead', lastError: 'downstream refused', event: expect.objectContaining({ itemId: 'bad' }) })]);

    // The downstream is fixed; replay from 16 minutes ago: `bad` and `c` again (not `a`), the dead letter is cleared.
    handled.push('fixed');
    const result = await replayConsumer(db, def.name, { at: new Date(Date.now() - 16 * 60_000) });
    expect(result).toMatchObject({ ok: true, events: 2, replayFrom: { eventId: badId } });
    await runner.runOnce(def);
    expect(handled).toEqual(['a', 'c', 'fixed', 'bad', 'c']);
    expect(await listDeadLetters(db, def.name)).toEqual([]);

    // Replaying from an event id works too; an unknown event or consumer is refused.
    expect(await replayConsumer(db, def.name, { eventId: 'ev_missing' })).toEqual({ ok: false, reason: 'event_not_found' });
    expect(await replayConsumer(db, 'test-p11:nobody', { at: new Date() })).toEqual({ ok: false, reason: 'not_found' });
    expect(await replayConsumer(db, 'cdc-subscription:x', { at: new Date() })).toEqual({ ok: false, reason: 'not_found' });
  });

  it('task 1.1: replay is refused while a runner holds the lease', async () => {
    const name = consumerName('busy');
    await raw`INSERT INTO lumibase_event_consumers (name, site_id, lease_token, lease_until) VALUES (${name}, ${SITE}, 'held', now() + interval '1 minute')`;
    await emit('x');
    expect(await replayConsumer(db, name, { at: new Date(0) })).toEqual({ ok: false, reason: 'busy' });
  });

  it('task 1.2: with the events never written, reconciliation repairs the cache and the search index and reports the hooks', async () => {
    const [coll] = await db.insert(collections).values({ siteId: SITE, name: 'articles', label: 'Articles' }).returning({ id: collections.id });
    await db.insert(fields).values({ siteId: SITE, collectionId: coll!.id, name: 'title', type: 'string', interface: 'input' });
    const item = (await new ItemService({ db, siteId: SITE }).create('articles', { data: { title: 'Lost event' }, status: 'published' })) as { id: string };
    // The content committed but its change events did not: no consumer will ever hear of it.
    await raw`DELETE FROM lumibase_cdc_change_events WHERE site_id = ${SITE}`;
    // A render version raised without an invalidation event: the cached page of version 1 is superseded.
    await db.insert(siteRenderVersions).values({ siteId: SITE, version: 5, structureVersion: 4 }).onConflictDoUpdate({ target: siteRenderVersions.siteId, set: { version: 5, structureVersion: 4 } });
    await db.insert(renderCache).values([
      { key: `${SITE}:stale`, siteId: SITE, siteVersion: 1, structureVersion: 4, status: 200, body: 'old', etag: 'W/"1"', expiresAt: new Date(Date.now() + 3600_000) },
      { key: `${SITE}:current`, siteId: SITE, siteVersion: 5, structureVersion: 4, status: 200, body: 'new', etag: 'W/"5"', expiresAt: new Date(Date.now() + 3600_000) },
    ]);

    const indexed: Array<{ index: string; id: unknown }> = [];
    const search = {
      index: async (index: string, docs: Record<string, unknown>[]) => void indexed.push(...docs.map((d) => ({ index, id: d.id }))),
      delete: async () => {},
      configureIndex: async () => {},
      getIndex: async () => ({ numberOfDocuments: 0 }),
      search: async () => ({ hits: [], total: 0 }),
    } as unknown as SearchProvider;
    const git: StateReconciler = {
      name: 'git-snapshots',
      consumer: 'git-snapshots',
      reconcile: async () => ({ status: 'drift', checked: 1, repaired: 0, drift: 1, detail: 'one file differs' }),
    };

    const report = await runStateReconciliation(db, { search, hooks: [git] }, { trigger: 'manual', now: new Date(Date.now() + 1000) });
    const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
    expect(byName['render-cache']).toMatchObject({ status: 'repaired' });
    expect(byName['render-cache']!.repaired).toBeGreaterThanOrEqual(1);
    expect((await db.select({ key: renderCache.key }).from(renderCache).where(eq(renderCache.siteId, SITE))).map((r) => r.key)).toEqual([`${SITE}:current`]);
    expect(indexed).toContainEqual({ index: `${SITE}__articles`, id: item.id });
    expect(byName['search-index']!.status).toBe('ok');
    expect(byName['git-snapshots']).toMatchObject({ status: 'drift', detail: 'one file differs' });
    expect(byName['astro-builds']).toMatchObject({ status: 'not_configured' });
    for (const name of ['translation-freshness', 'indexnow', 'link-graph']) expect(byName[name]!.status).not.toBe('failed');

    // The report is recorded; a reconciler that throws is reported failed without stopping the others.
    expect((await latestReconciliationReport(db))?.startedAt).toBe(report.startedAt);
    const broken: StateReconciler = { name: 'astro-builds', consumer: 'astro-builds', reconcile: async () => Promise.reject(new Error('build host unreachable')) };
    const second = await runStateReconciliation(db, { hooks: [broken] }, { now: new Date(Date.now() + 2000) });
    expect(second.results.find((r) => r.name === 'astro-builds')).toMatchObject({ status: 'failed', detail: 'build host unreachable' });
    expect(second.results.find((r) => r.name === 'search-index')).toMatchObject({ status: 'not_configured' });
    expect(second.results.find((r) => r.name === 'render-cache')).toMatchObject({ status: 'ok', repaired: 0 });
  });

  it('tasks 2.4, 3.5: the Git and Astro slots run the real reconcilers when no hook replaces them', async () => {
    await db.insert(gitSnapshotRepos).values({ siteId: SITE, enabled: true, remoteUrl: 'https://git.invalid/snap.git' });
    const now = new Date(Date.now() + 3000);
    let astroRuns = 0;
    setAstroStateReconciliation({
      run: async () => {
        astroRuns++;
        return { checked: 2, stuck: [`${SITE}#3`], requested: [SITE], relinked: [] };
      },
    });
    try {
      const report = await runStateReconciliation(db, {}, { now });
      const byName = Object.fromEntries(report.results.map((r) => [r.name, r]));
      expect(byName['git-snapshots']).toMatchObject({ status: 'ok', consumer: 'git-snapshots' });
      const queued = await db.select({ eventId: gitSnapshotQueue.eventId }).from(gitSnapshotQueue).where(eq(gitSnapshotQueue.siteId, SITE));
      expect(queued.map((q) => q.eventId)).toContain(`reconcile:${SITE}:${now.toISOString().slice(0, 10)}`);
      expect(astroRuns).toBe(1);
      expect(byName['astro-builds']).toMatchObject({ status: 'repaired', consumer: 'astro-build', checked: 2, repaired: 2 });
    } finally {
      setAstroStateReconciliation(null);
    }
    const off = await runStateReconciliation(db, {}, { now: new Date(now.getTime() + 1000) });
    expect(off.results.find((r) => r.name === 'astro-builds')).toMatchObject({ status: 'not_configured' });
  });
});
