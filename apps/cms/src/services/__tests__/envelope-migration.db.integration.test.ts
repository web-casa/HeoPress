// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  collections,
  fields,
  items,
  scopedDatabase,
  sites,
  type Database,
} from '@heopress/database';
import { EnvKeyProvider, type QueueProvider } from '@heopress/runtime';
import { ItemService } from '../item-service';
import { ENVELOPE_MIGRATION_QUEUE, registerEnvelopeMigrationWorker, runEnvelopeMigration } from '../envelope-migration-worker';
import { readEnvelopeSetting, writeEnvelopeSetting } from '../crypto/envelope-settings';
import { parseEnvelope } from '../crypto/envelope-codec';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * DB-backed envelope migration + hot-path integration (task 3.6; Req 4.5).
 * Skips when DATABASE_URL is unset/unreachable.
 *
 * Test data and stored-row checks go through the owner's fixtures connection; the services run as the application
 * role in the site's scope, the queue worker on the root handle as `serve.ts` gives it (HeoPress P14).
 */

const SITE = 'site_envelope_it';
const SITE_B = 'site_envelope_it_b';
const COLLECTION = 'patients';
const KEK = Buffer.alloc(32, 44).toString('base64');

describe.skipIf(!hasDbIntegrationUrl)('Envelope migration — DB integration', () => {
  let db: Database;
  let fixtures: Database;
  let siteDb: Database;
  const keyProvider = new EnvKeyProvider(new Map([['v0', KEK]]), 'v0');
  const svc = (site = SITE) => new ItemService({ db: scopedDatabase(db, { site }), siteId: site, keyProvider });

  beforeAll(async () => {
    db = await connectDbIntegration('envelope-migration');
    fixtures = await connectDbFixtures('envelope-migration');
    siteDb = scopedDatabase(db, { site: SITE });
  });

  afterAll(async () => {
    if (!fixtures) return;
    await fixtures.delete(sites).where(inArray(sites.id, [SITE, SITE_B])).catch(() => undefined);
  });

  beforeEach(async () => {
    await fixtures.delete(sites).where(inArray(sites.id, [SITE, SITE_B]));
    for (const site of [SITE, SITE_B]) {
      await fixtures.insert(sites).values({ id: site, name: `Envelope IT ${site}` });
      const [coll] = await fixtures
        .insert(collections)
        .values({ siteId: site, name: COLLECTION, label: 'Patients' })
        .returning({ id: collections.id });
      await fixtures.insert(fields).values([
        { siteId: site, collectionId: coll!.id, name: 'name', type: 'string', interface: 'input' },
        { siteId: site, collectionId: coll!.id, name: 'ssn', type: 'string', interface: 'input', encrypted: true, classification: 'phi' },
      ]);
    }
  });

  async function rawSsn(id: string): Promise<string> {
    const [raw] = await fixtures.select().from(items).where(eq(items.id, id));
    return (raw!.data as Record<string, string>).ssn as string;
  }
  async function rawDek(id: string): Promise<string | null> {
    const [raw] = await fixtures.select().from(items).where(eq(items.id, id));
    return (raw as Record<string, unknown>).dekWrapped as string | null;
  }

  it('migrates shared → envelope and back, keeping plaintext readable throughout', async () => {
    // Created in shared mode: versioned envelope ciphertext, no wrapped DEK.
    const item = await svc().create(COLLECTION, { data: { name: 'A', ssn: 's-100' } });
    expect(await rawDek(item.id)).toBeNull();
    expect(parseEnvelope(await rawSsn(item.id)).keyId).toBe('v0');

    // Toggle on + migrate to envelope.
    const base = await readEnvelopeSetting(siteDb, SITE);
    await writeEnvelopeSetting(siteDb, SITE, {
      ...base,
      enabled: true,
      migration: { ...base.migration, direction: 'to_envelope', status: 'running' },
    });
    const fwd = await runEnvelopeMigration({ db: siteDb, siteId: SITE, keyProvider });
    expect(fwd.done).toBe(true);
    expect(fwd.migrated).toBeGreaterThanOrEqual(1);

    // Now envelope mode: record carries a wrapped DEK; plaintext still decrypts.
    expect(await rawDek(item.id)).toBeTruthy();
    const exp1 = await svc().exportSubject(COLLECTION, { name: 'A' });
    expect((exp1.records[0]!.data as Record<string, unknown>).ssn).toBe('s-100');

    // Toggle off + migrate back to shared.
    const mid = await readEnvelopeSetting(siteDb, SITE);
    await writeEnvelopeSetting(siteDb, SITE, {
      ...mid,
      enabled: false,
      migration: { ...mid.migration, direction: 'to_shared', status: 'running', cursor: null, processed: 0 },
    });
    const back = await runEnvelopeMigration({ db: siteDb, siteId: SITE, keyProvider });
    expect(back.done).toBe(true);

    // Wrapped DEK cleared; ciphertext is a versioned shared envelope again.
    expect(await rawDek(item.id)).toBeNull();
    expect(parseEnvelope(await rawSsn(item.id)).keyId).toBe('v0');
    const exp2 = await svc().exportSubject(COLLECTION, { name: 'A' });
    expect((exp2.records[0]!.data as Record<string, unknown>).ssn).toBe('s-100');
  });

  it('hot path: new writes honor the setting (envelope on → wrapped DEK persisted)', async () => {
    const base = await readEnvelopeSetting(siteDb, SITE);
    await writeEnvelopeSetting(siteDb, SITE, { ...base, enabled: true });

    // A fresh service reads the setting once and writes in envelope mode.
    const created = await svc().create(COLLECTION, { data: { name: 'B', ssn: 's-200' } });
    expect(await rawDek(created.id)).toBeTruthy();

    const exported = await svc().exportSubject(COLLECTION, { name: 'B' });
    expect((exported.records[0]!.data as Record<string, unknown>).ssn).toBe('s-200');
  });

  it('migration is idempotent — a second pass migrates nothing', async () => {
    await svc().create(COLLECTION, { data: { name: 'C', ssn: 's-300' } });
    const base = await readEnvelopeSetting(siteDb, SITE);
    await writeEnvelopeSetting(siteDb, SITE, {
      ...base,
      enabled: true,
      migration: { ...base.migration, direction: 'to_envelope', status: 'running' },
    });
    const first = await runEnvelopeMigration({ db: siteDb, siteId: SITE, keyProvider });
    expect(first.migrated).toBeGreaterThanOrEqual(1);

    // Re-run from a clean cursor — already-envelope records are skipped.
    const reset = await readEnvelopeSetting(siteDb, SITE);
    await writeEnvelopeSetting(siteDb, SITE, {
      ...reset,
      migration: { ...reset.migration, status: 'running', cursor: null, processed: 0 },
    });
    const second = await runEnvelopeMigration({ db: siteDb, siteId: SITE, keyProvider });
    expect(second.migrated).toBe(0);
  });
  it('the queue worker migrates each job\'s site on the root handle, two sites in turn', async () => {
    const a = await svc(SITE).create(COLLECTION, { data: { name: 'D', ssn: 's-400' } });
    const b = await svc(SITE_B).create(COLLECTION, { data: { name: 'E', ssn: 's-500' } });
    for (const site of [SITE, SITE_B]) {
      const scoped = scopedDatabase(db, { site });
      const base = await readEnvelopeSetting(scoped, site);
      await writeEnvelopeSetting(scoped, site, { ...base, enabled: true, migration: { ...base.migration, direction: 'to_envelope', status: 'running' } });
    }
    let handler: ((job: { data: { siteId?: string } }) => Promise<void>) | undefined;
    const queue = { process: (name: string, fn: typeof handler) => { if (name === ENVELOPE_MIGRATION_QUEUE) handler = fn; } } as unknown as QueueProvider;
    // The root application-role handle, as serve.ts registers the worker.
    registerEnvelopeMigrationWorker({ db, keyProvider, queue });
    await handler!({ data: { siteId: SITE } });
    await handler!({ data: { siteId: SITE_B } });

    expect(await rawDek(a.id)).toBeTruthy();
    expect(await rawDek(b.id)).toBeTruthy();
    expect((await readEnvelopeSetting(scopedDatabase(db, { site: SITE_B }), SITE_B)).migration.status).toBe('completed');
    const exported = await svc(SITE_B).exportSubject(COLLECTION, { name: 'E' });
    expect((exported.records[0]!.data as Record<string, unknown>).ssn).toBe('s-500');
  });
});
