// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  auditLog,
  collections,
  fieldAccessLog,
  fields,
  items,
  revisions,
  scopedDatabase,
  settings,
  sites,
  type Database,
} from '@heopress/database';
import { EnvKeyProvider } from '@heopress/runtime';
import { ItemService } from '../item-service';
import { ErasureService } from '../erasure-service';
import { sweepRetention } from '../scheduler-worker';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * DB-backed erasure / retention / SAR integration (tasks 9.5, 10.4; Req 11-13).
 * Skips when DATABASE_URL is unset/unreachable.
 *
 * **Validates: Requirements 11.2, 11.3, 12.2, 12.4, 13.1-13.3**
 *
 * Test data and stored-row checks go through the owner's fixtures connection; the services run as the application
 * role in the site's scope, the retention sweep (a background entry point) on the root handle (HeoPress P14).
 */

const SITE = 'site_erasure_it';
const COLLECTION = 'patients';
const KEY = Buffer.alloc(32, 33).toString('base64');

describe.skipIf(!hasDbIntegrationUrl)('Erasure / retention / SAR — DB integration', () => {
  let db: Database;
  let fixtures: Database;
  let siteDb: Database;
  let collectionId: string;
  const keyProvider = new EnvKeyProvider(new Map([['v0', KEY]]), 'v0');

  beforeAll(async () => {
    db = await connectDbIntegration('erasure-retention-sar');
    fixtures = await connectDbFixtures('erasure-retention-sar');
    siteDb = scopedDatabase(db, { site: SITE });
  });

  afterAll(async () => {
    if (!fixtures) return;
    await fixtures.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  beforeEach(async () => {
    await fixtures.delete(sites).where(eq(sites.id, SITE));
    await fixtures.delete(auditLog).where(eq(auditLog.siteId, SITE)).catch(() => undefined);
    await fixtures.insert(sites).values({ id: SITE, name: 'Erasure IT' });
    const [coll] = await fixtures
      .insert(collections)
      .values({ siteId: SITE, name: COLLECTION, label: 'Patients' })
      .returning({ id: collections.id });
    collectionId = coll!.id;
    await fixtures.insert(fields).values([
      { siteId: SITE, collectionId, name: 'patientId', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId, name: 'ssn', type: 'string', interface: 'input', encrypted: true, classification: 'phi' },
    ]);
  });

  const svc = () => new ItemService({ db: siteDb, siteId: SITE, keyProvider });

  it('erasure hard-deletes item + revisions but preserves the data_erased audit (Req 11.2, 11.3)', async () => {
    const item = await svc().create(COLLECTION, { data: { patientId: 'p-1', ssn: '111' } });
    // create writes a revision.
    expect((await fixtures.select().from(revisions).where(eq(revisions.itemId, item.id))).length).toBe(1);

    const erase = new ErasureService({ db: siteDb, siteId: SITE, actorEmail: 'dpo@test.local' });
    const req = await erase.create({ collection: COLLECTION, filter: { patientId: 'p-1' } }, 'gdpr');
    await erase.confirm(req!.id);
    const done = await erase.execute(req!.id);
    expect(done!.status).toBe('completed');
    expect(done!.recordCount).toBe(1);

    // Item + revisions gone.
    expect((await fixtures.select().from(items).where(eq(items.id, item.id))).length).toBe(0);
    expect((await fixtures.select().from(revisions).where(eq(revisions.itemId, item.id))).length).toBe(0);

    // Tamper-evident proof remains, with a hashed subject (no plaintext id).
    const proof = await fixtures.select().from(auditLog).where(eq(auditLog.event, 'data_erased'));
    expect(proof.length).toBe(1);
    const meta = JSON.stringify(proof[0]!.metadata);
    expect(meta).toContain('"recordCount":1');
    expect(meta).not.toContain('p-1');
  });

  it('SAR export returns decrypted subject data + provenance and audits sar_exported (Req 13)', async () => {
    await svc().create(COLLECTION, { data: { patientId: 'p-2', ssn: '222' } });

    const { records, count } = await svc().exportSubject(COLLECTION, { patientId: 'p-2' });
    expect(count).toBe(1);
    expect((records[0]!.data as Record<string, unknown>).ssn).toBe('222');
    expect(records[0]!.provenance).toBeTruthy();

    // Decrypting the phi field wrote a Field_Access_Log row — without the value (Req 5.4, 13.2).
    const access = await fixtures.select().from(fieldAccessLog).where(eq(fieldAccessLog.siteId, SITE));
    expect(access.length).toBeGreaterThanOrEqual(1);
    expect(access[0]!.fields).toContain('ssn');
    expect(JSON.stringify(access[0]!)).not.toContain('222');
  });

  it('retention sweep applies hard_delete past maxAgeDays and audits retention_applied (Req 12)', async () => {
    const item = await svc().create(COLLECTION, { data: { patientId: 'p-3', ssn: '333' } });
    // Backdate createdAt beyond the policy window.
    await fixtures
      .update(items)
      .set({ createdAt: new Date(Date.now() - 40 * 86_400_000) })
      .where(eq(items.id, item.id));
    await fixtures.insert(settings).values({
      siteId: SITE,
      key: 'retention.policies',
      value: { policies: [{ collection: COLLECTION, maxAgeDays: 30, action: 'hard_delete' }] },
    });

    const applied = await sweepRetention({ db });
    expect(applied).toBe(1);
    expect((await fixtures.select().from(items).where(eq(items.id, item.id))).length).toBe(0);
    const audits = await fixtures
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.siteId, SITE), eq(auditLog.event, 'retention_applied')));
    expect(audits.length).toBe(1);
  });
  it('the retention sweep on the root handle applies each site\'s own policy, two sites in turn (P14)', async () => {
    const SITE_B = `${SITE}_b`;
    await fixtures.delete(sites).where(eq(sites.id, SITE_B));
    try {
      await fixtures.insert(sites).values({ id: SITE_B, name: 'Erasure IT B' });
      const [collB] = await fixtures.insert(collections).values({ siteId: SITE_B, name: COLLECTION, label: 'Patients' }).returning({ id: collections.id });
      await fixtures.insert(fields).values({ siteId: SITE_B, collectionId: collB!.id, name: 'patientId', type: 'string', interface: 'input' });
      const old = new Date(Date.now() - 40 * 86_400_000);
      const a = await svc().create(COLLECTION, { data: { patientId: 'p-a', ssn: '1' } });
      const b = await new ItemService({ db: scopedDatabase(db, { site: SITE_B }), siteId: SITE_B, keyProvider }).create(COLLECTION, { data: { patientId: 'p-b' } });
      await fixtures.update(items).set({ createdAt: old }).where(eq(items.id, a.id));
      await fixtures.update(items).set({ createdAt: old }).where(eq(items.id, b.id));
      // Site A deletes after 30 days; site B keeps for 60.
      await fixtures.insert(settings).values([
        { siteId: SITE, key: 'retention.policies', value: { policies: [{ collection: COLLECTION, maxAgeDays: 30, action: 'hard_delete' }] } },
        { siteId: SITE_B, key: 'retention.policies', value: { policies: [{ collection: COLLECTION, maxAgeDays: 60, action: 'hard_delete' }] } },
      ]);

      expect(await sweepRetention({ db })).toBe(1);
      expect(await fixtures.select({ id: items.id }).from(items).where(eq(items.id, a.id))).toEqual([]);
      expect(await fixtures.select({ id: items.id }).from(items).where(eq(items.id, b.id))).toEqual([{ id: b.id }]);

      await fixtures.update(settings).set({ value: { policies: [{ collection: COLLECTION, maxAgeDays: 30, action: 'hard_delete' }] } }).where(and(eq(settings.siteId, SITE_B), eq(settings.key, 'retention.policies')));
      expect(await sweepRetention({ db })).toBe(1);
      expect(await fixtures.select({ id: items.id }).from(items).where(eq(items.id, b.id))).toEqual([]);
      const audits = await fixtures.select().from(auditLog).where(and(eq(auditLog.siteId, SITE_B), eq(auditLog.event, 'retention_applied')));
      expect(audits).toHaveLength(1);
    } finally {
      await fixtures.delete(sites).where(eq(sites.id, SITE_B));
      await fixtures.delete(auditLog).where(eq(auditLog.siteId, SITE_B));
    }
  });
});
