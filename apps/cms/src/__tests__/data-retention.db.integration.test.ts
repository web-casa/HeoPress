import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  aiProductions,
  autoPublishCandidates,
  collections,
  contentProvenance,
  deletionLedger,
  ingestProcessingJobs,
  ingestSnapshots,
  ingestSourceDocuments,
  ingestSources,
  items,
  licenceLapseReviews,
  llmCalls,
  settings,
  type Database,
} from '@heopress/database';
import type { StorageObject, StorageProvider } from '@heopress/runtime';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { createRuntime } from '@heopress/runtime/node';
import { readRetentionDays } from '../modules/cdc/change-feed/retention';
import { ErasureService } from '../services/erasure-service';
import { snapshotKey, writeSnapshot } from '../services/ingest/snapshot-store';
import { fileLedgerSink, replayDeletionLedger } from '../services/retention/deletion-ledger';
import { redactExpiredRunRecords } from '../services/retention/run-record-retention';
import { RetentionHoldService, purgeExpiredSnapshots } from '../services/retention/snapshot-retention';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * Data retention and the deletion ledger (HeoPress P13 tasks 5.1, 5.2; spec ops/data-retention): a raw fetch snapshot
 * past its period is kept while content in review, an open dispute or a running task references it, and becomes a
 * tombstone once only the provenance of published content does; a personal-data deletion request wins over every
 * reference; AI run record bodies are redacted past their period; after a restore from a backup taken before an
 * erasure, replaying the ledger deletes the data again and the report lists what was replayed.
 */

const JWT_SECRET = 'data-retention-test-secret';
const DAY = 86_400_000;

class MemoryStorage implements StorageProvider {
  objects = new Map<string, Buffer>();
  async put(key: string, data: ReadableStream | Buffer): Promise<void> {
    this.objects.set(key, Buffer.isBuffer(data) ? data : Buffer.from(await new Response(data).arrayBuffer()));
  }
  async get(key: string): Promise<StorageObject | null> {
    const b = this.objects.get(key);
    return b ? { key, body: b, size: b.byteLength } : null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async list(prefix = ''): Promise<{ keys: string[] }> {
    return { keys: [...this.objects.keys()].filter((k) => k.startsWith(prefix)) };
  }
}

describe.skipIf(!hasDbIntegrationUrl)('data retention — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let storage: MemoryStorage;
  let siteId = '';
  let collectionId = '';
  let sourceId = '';
  let ledgerDir = '';
  const now = new Date('2026-10-29T03:00:00.000Z');
  const old = new Date(now.getTime() - 120 * DAY);

  beforeAll(async () => {
    db = await connectDbIntegration('data-retention');
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'dret', jwtSecret: JWT_SECRET });
    siteId = fx.sites.a;
    storage = new MemoryStorage();
    const runtime = createRuntime({ ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' });
    setRuntimeFactory(() => ({ ...runtime, storage }));
    const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, siteId), eq(collections.name, 'articles')));
    collectionId = coll!.id;
    const [src] = await db
      .insert(ingestSources)
      .values({ siteId, name: 'Example News', type: 'url', url: 'https://news.example.com/', scheduleTimes: [], timezone: 'UTC' })
      .returning({ id: ingestSources.id });
    sourceId = src!.id;
    ledgerDir = await mkdtemp(path.join(os.tmpdir(), 'heopress-ledger-'));
  });
  afterEach(async () => {
    setRuntimeFactory(null);
    for (const s of [fx.sites.a, fx.sites.b]) await db.delete(deletionLedger).where(eq(deletionLedger.siteId, s));
    if (fx) await fx.teardown();
    if (ledgerDir.startsWith(os.tmpdir())) await rm(ledgerDir, { recursive: true, force: true });
  });

  let seq = 0;
  /** A snapshot (written `writtenAt`) with one source document. */
  async function snapshotWithDocument(writtenAt = old): Promise<{ snapshotId: string; documentId: string; key: string }> {
    seq += 1;
    const ref = await writeSnapshot({ db, storage, now: () => writtenAt }, siteId, Buffer.from(`<html><body>Page ${seq} by Jane Doe</body></html>`));
    const [doc] = await db
      .insert(ingestSourceDocuments)
      .values({
        siteId,
        sourceId,
        operationId: `op-${seq}`,
        url: `https://news.example.com/${seq}`,
        normalizedUrl: `https://news.example.com/${seq}`,
        finalUrl: `https://news.example.com/${seq}`,
        title: `Page ${seq}`,
        bodyHtml: '<p>Jane Doe said hello.</p>',
        bodyText: 'Jane Doe said hello.',
        contentHash: `hash-${seq}`,
        snapshotId: ref.id,
        extractionRuleVersion: 'rules-v3',
        fetchMethod: 'native',
        fetchProvider: 'native',
        licenceStatus: 'licensed',
        usageMode: 'licensed_derivative',
        commercialUse: true,
        fetchedAt: writtenAt,
      })
      .returning({ id: ingestSourceDocuments.id });
    return { snapshotId: ref.id, documentId: doc!.id, key: ref.storageKey };
  }

  /** An item derived from the document, in `status`. */
  async function derivedItem(documentId: string, status: 'draft' | 'published'): Promise<string> {
    const [item] = await db.insert(items).values({ siteId, collectionId, status, data: { title: `Derived ${documentId}` } }).returning({ id: items.id });
    await db.insert(contentProvenance).values({ siteId, itemId: item!.id, sourceDocumentId: documentId, sourceId, operation: 'rewrite' });
    return item!.id;
  }

  const purge = () => purgeExpiredSnapshots({ db, storage, snapshotDays: 90, now: () => now });
  const snapshotRow = async (id: string) => (await db.select().from(ingestSnapshots).where(eq(ingestSnapshots.id, id)))[0]!;

  it('a snapshot referenced only by published content becomes a tombstone; the document shows it', async () => {
    const s = await snapshotWithDocument();
    await derivedItem(s.documentId, 'published');
    const fresh = await snapshotWithDocument(new Date(now.getTime() - 10 * DAY));

    const r = await purge();
    expect(r.tombstoned).toEqual([s.snapshotId]);
    const row = await snapshotRow(s.snapshotId);
    expect(row.contentDeletedAt?.toISOString()).toBe(now.toISOString());
    expect(row.deletionReason).toBe('retention_expired');
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.objects.has(s.key)).toBe(false);
    // Within the period: untouched.
    expect((await snapshotRow(fresh.snapshotId)).contentDeletedAt).toBeNull();
    expect(storage.objects.has(fresh.key)).toBe(true);

    const token = await fx.session('adminA', 'a');
    const res = await app.request(`/api/v1/ingest/documents/${s.documentId}/snapshot`, { headers: fx.headers('a', token) }, { ...process.env, JWT_SECRET });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { errors: Array<{ code: string }>; meta: { tombstone: Record<string, unknown> } };
    expect(body.errors[0]!.code).toBe('SNAPSHOT_DELETED');
    expect(body.meta.tombstone).toEqual({ sha256: row.sha256, extractionRuleVersion: 'rules-v3', deletedAt: now.toISOString(), reason: 'retention_expired' });

    // A second run finds nothing more to do.
    expect((await purge()).tombstoned).toEqual([]);
  });

  it('content waiting for review blocks clean-up until it is published', async () => {
    const s = await snapshotWithDocument();
    const itemId = await derivedItem(s.documentId, 'draft');
    let r = await purge();
    expect(r.tombstoned).toEqual([]);
    expect(r.blocked).toEqual([{ siteId, snapshotId: s.snapshotId, blockers: ['pending_review'] }]);
    expect(storage.objects.has(s.key)).toBe(true);

    // Published, but a newer version is still in the auto-publish review queue: still pending review.
    await db.update(items).set({ status: 'published' }).where(eq(items.id, itemId));
    await db.insert(autoPublishCandidates).values({
      siteId, collection: 'articles', itemId, itemVersion: 2, contentHash: 'h', autonomyLevel: 2, settingsVersion: 1, status: 'review', reason: 'tier_l2',
    });
    expect((await purge()).blocked[0]!.blockers).toEqual(['pending_review']);
    await db.update(autoPublishCandidates).set({ status: 'published' }).where(eq(autoPublishCandidates.itemId, itemId));
    r = await purge();
    expect(r.tombstoned).toEqual([s.snapshotId]);
  });

  it('an open dispute keeps the snapshot; once it ends, the snapshot is cleaned up', async () => {
    const s = await snapshotWithDocument();
    const itemId = await derivedItem(s.documentId, 'published');
    const holds = new RetentionHoldService({ db, siteId, userId: fx.users.adminA.id });
    const hold = await holds.open({ snapshotId: s.snapshotId, reason: 'copyright complaint CASE-1' });
    expect((await purge()).blocked).toEqual([{ siteId, snapshotId: s.snapshotId, blockers: ['open_dispute'] }]);
    // Another site cannot place or release holds on it.
    await expect(new RetentionHoldService({ db, siteId: fx.sites.b, userId: null }).open({ snapshotId: s.snapshotId, reason: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await holds.release(hold.id);
    // An open licence review of derived content is a dispute too.
    const [review] = await db
      .insert(licenceLapseReviews)
      .values({ siteId, itemId, sourceId, reason: 'revoked', action: 'flagged', previousStatus: 'published' })
      .returning({ id: licenceLapseReviews.id });
    expect((await purge()).blocked[0]!.blockers).toEqual(['open_dispute']);
    await db.update(licenceLapseReviews).set({ state: 'dismissed', resolvedAt: now }).where(eq(licenceLapseReviews.id, review!.id));
    expect((await purge()).tombstoned).toEqual([s.snapshotId]);
  });

  it('holds over the API: site administrators only, scoped to the site', async () => {
    const s = await snapshotWithDocument();
    const env = { ...process.env, JWT_SECRET };
    const post = async (user: 'adminA' | 'onlyA' | 'adminB', site: 'a' | 'b', url: string, body?: unknown) =>
      app.request(url, { method: 'POST', headers: { ...fx.headers(site, await fx.session(user, site)), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }, env);
    expect((await post('onlyA', 'a', '/api/v1/retention/holds', { snapshotId: s.snapshotId, reason: 'complaint' })).status).toBe(403);
    expect((await post('adminB', 'b', '/api/v1/retention/holds', { snapshotId: s.snapshotId, reason: 'complaint' })).status).toBe(404);
    const created = await post('adminA', 'a', '/api/v1/retention/holds', { snapshotId: s.snapshotId, reason: 'complaint' });
    expect(created.status).toBe(201);
    const hold = ((await created.json()) as { data: { id: string; targetId: string; releasedAt: string | null } }).data;
    expect(hold).toMatchObject({ targetId: s.snapshotId, releasedAt: null });
    const list = await app.request('/api/v1/retention/holds', { headers: fx.headers('a', await fx.session('adminA', 'a')) }, env);
    expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);
    expect((await post('adminA', 'a', `/api/v1/retention/holds/${hold.id}/release`)).status).toBe(200);
    expect((await post('adminA', 'a', `/api/v1/retention/holds/${hold.id}/release`)).status).toBe(409);
    const policy = await app.request('/api/v1/retention', { headers: fx.headers('a', await fx.session('adminA', 'a')) }, env);
    expect(((await policy.json()) as { data: { policy: Record<string, number> } }).data.policy.snapshotDays).toBe(90);
  });

  it('a task in progress keeps the snapshot', async () => {
    const s = await snapshotWithDocument();
    const [job] = await db.insert(ingestProcessingJobs).values({ siteId, sourceDocumentId: s.documentId, createdAt: old }).returning({ id: ingestProcessingJobs.id });
    expect((await purge()).blocked[0]!.blockers).toEqual(['in_progress']);
    await db.update(ingestProcessingJobs).set({ status: 'enqueued', enqueuedAt: old }).where(eq(ingestProcessingJobs.id, job!.id));
    const [prod] = await db
      .insert(aiProductions)
      .values({
        siteId,
        idempotencyKey: `k-${s.documentId}`,
        mode: 'rewrite',
        collection: 'articles',
        sources: [{ kind: 'source_document', id: s.documentId, version: 1 }],
        promptVersion: 'p1',
        status: 'retry_scheduled',
      })
      .returning({ id: aiProductions.id });
    expect((await purge()).blocked[0]!.blockers).toEqual(['in_progress']);
    await db.update(aiProductions).set({ status: 'failed' }).where(eq(aiProductions.id, prod!.id));
    expect((await purge()).tombstoned).toEqual([s.snapshotId]);
  });

  it('a personal-data deletion request wins over every reference; content in review is marked and sent back to review', async () => {
    const s = await snapshotWithDocument(new Date(now.getTime() - 5 * DAY));
    const itemId = await derivedItem(s.documentId, 'draft');
    await db.insert(autoPublishCandidates).values({
      siteId, collection: 'articles', itemId, itemVersion: 1, contentHash: 'h', autonomyLevel: 3, settingsVersion: 1, status: 'veto_window', reason: 'tier_l3',
    });
    await new RetentionHoldService({ db, siteId, userId: null }).open({ snapshotId: s.snapshotId, reason: 'dispute' });

    const sink = fileLedgerSink(ledgerDir);
    const erase = new ErasureService({ db, siteId, userId: fx.users.adminA.id, storage, ledger: sink, now: () => now });
    const req = await erase.create({ ingestSnapshots: [s.snapshotId] }, 'data subject request');
    await erase.confirm(req!.id);
    const done = await erase.execute(req!.id);
    expect(done!.status).toBe('completed');
    expect(done!.recordCount).toBe(1);

    const row = await snapshotRow(s.snapshotId);
    expect(row.deletionReason).toBe('personal_data_erasure');
    expect(storage.objects.has(s.key)).toBe(false);
    const [doc] = await db.select().from(ingestSourceDocuments).where(eq(ingestSourceDocuments.id, s.documentId));
    expect(doc!.bodyText).toBe('');
    expect(doc!.bodyHtml).toBe('');
    const [prov] = await db.select().from(contentProvenance).where(eq(contentProvenance.itemId, itemId));
    expect(prov!.sourceMissingReason).toBe('personal_data_erasure');
    expect(prov!.sourceMissingAt?.toISOString()).toBe(now.toISOString());
    const [item] = await db.select().from(items).where(eq(items.id, itemId));
    expect(item!.hold).toBe(true);
    const [cand] = await db.select().from(autoPublishCandidates).where(eq(autoPublishCandidates.itemId, itemId));
    expect(cand).toMatchObject({ status: 'review', reason: 'source_missing' });

    // The ledger: identifiers and time only, in the table and the external ledger.
    const ledger = await db.select().from(deletionLedger).where(eq(deletionLedger.siteId, siteId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ requestId: req!.id, objectKind: 'ingest_snapshot', objectId: s.snapshotId, action: 'tombstone', objectScope: null });
    const external = await sink.readAll();
    expect(external.map((e) => e.id)).toEqual([ledger[0]!.id]);
    expect(JSON.stringify(external)).not.toContain('Jane');

    // Fetching the same content again does not store the erased bytes again.
    await writeSnapshot({ db, storage, now: () => now }, siteId, Buffer.from(`<html><body>Page ${seq} by Jane Doe</body></html>`));
    expect(storage.objects.has(s.key)).toBe(false);
    expect((await snapshotRow(s.snapshotId)).deletionReason).toBe('personal_data_erasure');
  });

  it('a snapshot removed for retention is stored again when the same content is fetched again', async () => {
    const s = await snapshotWithDocument();
    await derivedItem(s.documentId, 'published');
    await purge();
    expect(storage.objects.has(s.key)).toBe(false);
    await writeSnapshot({ db, storage, now: () => now }, siteId, Buffer.from(`<html><body>Page ${seq} by Jane Doe</body></html>`));
    const row = await snapshotRow(s.snapshotId);
    expect(row.contentDeletedAt).toBeNull();
    expect(row.deletionReason).toBeNull();
    expect(storage.objects.has(snapshotKey(siteId, row.sha256))).toBe(true);
  });

  it('AI run record bodies past the period are redacted; model, tokens and open calls stay', async () => {
    const call = (key: string, createdAt: Date, status: 'completed' | 'open') =>
      db
        .insert(llmCalls)
        .values({
          siteId,
          callKey: key,
          taskType: 'chat',
          originKind: 'pipeline',
          requestDigest: 'd',
          candidates: [],
          deadlineAt: createdAt,
          status,
          ...(status === 'completed'
            ? { winnerAttemptId: 'att-1', result: { response: { content: 'Full output about Jane Doe', toolCalls: [], usage: { inputTokens: 10, outputTokens: 20 } }, provider: 'mock', model: 'mock-1' } }
            : {}),
          createdAt,
        })
        .returning({ id: llmCalls.id });
    const [expired] = await call('old', old, 'completed');
    const [recent] = await call('recent', new Date(now.getTime() - DAY), 'completed');
    const [open] = await call('open', old, 'open');

    const r = await redactExpiredRunRecords({ db, aiRunBodyDays: 90, now: () => now });
    expect(r).toEqual({ redacted: 1, failedSites: 0 });
    const get = async (id: string) => (await db.select().from(llmCalls).where(eq(llmCalls.id, id)))[0]!;
    expect((await get(expired!.id)).result).toEqual({ redacted: true, redactedAt: now.toISOString(), provider: 'mock', model: 'mock-1', usage: { inputTokens: 10, outputTokens: 20 } });
    expect(JSON.stringify((await get(recent!.id)).result)).toContain('Full output');
    expect((await get(open!.id)).result).toBeNull();
    expect((await redactExpiredRunRecords({ db, aiRunBodyDays: 90, now: () => now })).redacted).toBe(0);
  });

  it('after a restore from a backup taken before an erasure, replaying the ledger deletes the data again', async () => {
    const [subject] = await db
      .insert(items)
      .values({ siteId, collectionId, status: 'published', data: { title: 'Profile', email: 'jane@example.com' } })
      .returning();
    const s = await snapshotWithDocument();
    const sink = fileLedgerSink(ledgerDir);
    // The "backup": the rows and object as they were before the erasure.
    const backupItem = { ...subject! };
    const backupSnapshotBytes = storage.objects.get(s.key)!;

    const erase = new ErasureService({ db, siteId, userId: fx.users.adminA.id, storage, ledger: sink, now: () => now });
    const r1 = await erase.create({ collection: 'articles', filter: { email: 'jane@example.com' } }, 'gdpr');
    await erase.confirm(r1!.id);
    expect((await erase.execute(r1!.id))!.recordCount).toBe(1);
    const r2 = await erase.create({ ingestSnapshots: [s.snapshotId] });
    await erase.confirm(r2!.id);
    await erase.execute(r2!.id);
    expect(await db.select().from(items).where(eq(items.id, subject!.id))).toHaveLength(0);
    expect(await db.select().from(deletionLedger).where(eq(deletionLedger.siteId, siteId))).toHaveLength(2);

    // The "restore": the old rows come back and the ledger table is as old as the backup (empty).
    await db.insert(items).values(backupItem);
    await db.update(ingestSnapshots).set({ contentDeletedAt: null, deletionReason: null }).where(eq(ingestSnapshots.id, s.snapshotId));
    storage.objects.set(s.key, backupSnapshotBytes);
    await db.delete(deletionLedger).where(eq(deletionLedger.siteId, siteId));

    // Other suites may leave ledger rows of their own sites in the shared test database: look at this site's records.
    const report = await replayDeletionLedger({ db, storage, sink, now: () => now });
    const mine = report.records.filter((r) => r.siteId === siteId);
    expect(report.failed).toBe(0);
    expect(mine.filter((r) => r.outcome === 'deleted_again')).toHaveLength(2);
    expect(report.rowsRestored).toBeGreaterThanOrEqual(2);
    expect(report.sources).toEqual(['file', 'database']);
    expect(mine.map((r) => ({ kind: r.objectKind, id: r.objectId, outcome: r.outcome, requestId: r.requestId }))).toEqual(
      expect.arrayContaining([
        { kind: 'item', id: subject!.id, outcome: 'deleted_again', requestId: r1!.id },
        { kind: 'ingest_snapshot', id: s.snapshotId, outcome: 'deleted_again', requestId: r2!.id },
      ]),
    );
    expect(await db.select().from(items).where(eq(items.id, subject!.id))).toHaveLength(0);
    expect((await snapshotRow(s.snapshotId)).deletionReason).toBe('personal_data_erasure');
    expect(storage.objects.has(s.key)).toBe(false);
    expect(await db.select().from(deletionLedger).where(eq(deletionLedger.siteId, siteId))).toHaveLength(2);

    // Replaying again is a no-op.
    const again = await replayDeletionLedger({ db, storage, sink, now: () => now });
    expect(again.records.filter((r) => r.siteId === siteId).map((r) => r.outcome)).toEqual(['already_absent', 'already_absent']);
  });

  it("change events: a site's own setting wins, otherwise the instance period", async () => {
    expect(await readRetentionDays(db, siteId, 12)).toBe(12);
    await db.insert(settings).values({ siteId, key: 'cdc_feed', value: { enabled: true } });
    expect(await readRetentionDays(db, siteId, 12)).toBe(12);
    await db.update(settings).set({ value: { enabled: true, retentionDays: 45 } }).where(and(eq(settings.siteId, siteId), eq(settings.key, 'cdc_feed')));
    expect(await readRetentionDays(db, siteId, 12)).toBe(45);
  });
});
