import { mkdtemp, readFile, rm, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_RETENTION_POLICY, invalidRetentionSettings, retentionPolicyFromEnv } from '../policy';
import { planBackupRetention, registerBackupPruner, runBackupPruners, type BackupCatalogEntry } from '../backup-pruner';
import { fileLedgerSink, ledgerEntries, storageLedgerSink } from '../deletion-ledger';
import type { StorageObject, StorageProvider } from '@heopress/runtime';

/** HeoPress P13 tasks 5.1, 5.2: the retention policy, the backup selection and hook, the external deletion ledger. */

describe('retention policy', () => {
  it('defaults to ADR-0013', () => {
    expect(retentionPolicyFromEnv({})).toEqual({ snapshotDays: 90, aiRunBodyDays: 90, accessDetailDays: 7, changeEventDays: 30, backupDaily: 14, backupWeekly: 8 });
    expect(DEFAULT_RETENTION_POLICY.snapshotDays).toBe(90);
  });
  it('takes valid overrides and reports invalid ones, which keep the default', () => {
    const env = {
      HEOPRESS_RETENTION_SNAPSHOT_DAYS: '30',
      HEOPRESS_RETENTION_AI_RUN_BODY_DAYS: '0',
      HEOPRESS_RETENTION_ACCESS_DETAIL_DAYS: 'seven',
      HEOPRESS_RETENTION_CHANGE_EVENT_DAYS: '91',
      HEOPRESS_RETENTION_BACKUP_WEEKLY: '0',
    };
    expect(retentionPolicyFromEnv(env)).toEqual({ ...DEFAULT_RETENTION_POLICY, snapshotDays: 30, backupWeekly: 0 });
    expect(invalidRetentionSettings(env).map((s) => s.split(' ')[0])).toEqual([
      'HEOPRESS_RETENTION_AI_RUN_BODY_DAYS',
      'HEOPRESS_RETENTION_ACCESS_DETAIL_DAYS',
      'HEOPRESS_RETENTION_CHANGE_EVENT_DAYS',
    ]);
  });
});

describe('backup retention', () => {
  const at = (iso: string) => new Date(`${iso}T02:00:00Z`);
  const daily = (days: number, start = '2026-10-29'): BackupCatalogEntry[] =>
    Array.from({ length: days }, (_, i) => {
      const d = new Date(at(start).getTime() - i * 86_400_000);
      return { id: `full-${d.toISOString().slice(0, 10)}`, takenAt: d, status: 'succeeded' as const };
    });

  it('keeps 14 daily and 8 weekly backups', () => {
    const entries = daily(120);
    const plan = planBackupRetention(entries, { daily: 14, weekly: 8 });
    const kept = new Set(plan.keep);
    for (const e of entries.slice(0, 14)) expect(kept.has(e.id)).toBe(true);
    // 14 days cover two weeks or three; the other weekly copies are the newest of each older week.
    expect(plan.keep.length).toBeGreaterThanOrEqual(14 + 5);
    expect(plan.keep.length).toBeLessThanOrEqual(14 + 8);
    expect(plan.keep.length + plan.remove.length).toBe(120);
    expect(kept.has(entries[119]!.id)).toBe(false);
  });

  it('keeps the latest success, running backups and the whole chain a kept backup depends on', () => {
    const entries: BackupCatalogEntry[] = [
      { id: 'base', takenAt: at('2026-09-01'), status: 'succeeded' },
      { id: 'inc1', takenAt: at('2026-09-02'), status: 'succeeded', dependsOn: 'base' },
      { id: 'inc2', takenAt: at('2026-09-03'), status: 'succeeded', dependsOn: 'inc1' },
      { id: 'broken', takenAt: at('2026-09-04'), status: 'failed' },
      { id: 'running', takenAt: at('2026-09-05'), status: 'running' },
      { id: 'other-base', takenAt: at('2026-08-01'), status: 'succeeded' },
    ];
    const plan = planBackupRetention(entries, { daily: 1, weekly: 0 });
    expect(plan.keep.sort()).toEqual(['base', 'inc1', 'inc2', 'running']);
    expect(plan.remove.sort()).toEqual(['broken', 'other-base']);
  });

  it('runs registered pruners with the policy; a failing pruner does not stop the others', async () => {
    expect((await runBackupPruners({ daily: 14, weekly: 8 }, new Date())).registered).toBe(false);
    const seen: unknown[] = [];
    const off1 = registerBackupPruner({ name: 'local', prune: async (policy) => (seen.push(policy), { removed: ['b1'] }) });
    const off2 = registerBackupPruner({ name: 'broken', prune: async () => { throw new TypeError('bucket s3://secret-bucket unreachable'); } });
    try {
      const r = await runBackupPruners({ daily: 14, weekly: 8 }, new Date());
      expect(r.registered).toBe(true);
      expect(seen).toEqual([{ daily: 14, weekly: 8 }]);
      expect(r.pruners).toEqual([{ name: 'local', removed: ['b1'] }, { name: 'broken', removed: [], error: 'TypeError' }]);
    } finally {
      off1();
      off2();
    }
  });
});

describe('external deletion ledger', () => {
  let dir = '';
  afterEach(async () => {
    if (dir.startsWith(os.tmpdir())) await rm(dir, { recursive: true, force: true });
  });

  const entries = () =>
    ledgerEntries({ siteId: 'site-a', requestId: 'req-1', erasedAt: new Date('2026-10-29T03:00:00Z') }, [
      { objectKind: 'item', objectScope: 'articles', objectId: 'item-1', action: 'hard_delete' },
      { objectKind: 'ingest_snapshot', objectScope: null, objectId: 'snap-1', action: 'tombstone' },
    ]);

  it('files: appended, read back, a torn line skipped, identifiers and time only', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'heopress-ledger-unit-'));
    const sink = fileLedgerSink(dir);
    expect(await sink.readAll()).toEqual([]);
    const e = entries();
    await sink.append(e);
    await appendFile(path.join(dir, 'deletion-ledger-2026-10.ndjson'), '{"id":"torn","siteId":');
    expect(await sink.readAll()).toEqual(e);
    const raw = await readFile(path.join(dir, 'deletion-ledger-2026-10.ndjson'), 'utf8');
    expect(Object.keys(JSON.parse(raw.split('\n')[0]!)).sort()).toEqual(['action', 'erasedAt', 'id', 'objectId', 'objectKind', 'objectScope', 'requestId', 'siteId']);
  });

  it('object store: one object per entry outside the media prefix', async () => {
    const objects = new Map<string, Buffer>();
    const storage: StorageProvider = {
      put: async (k, d) => void objects.set(k, d as Buffer),
      get: async (k): Promise<StorageObject | null> => (objects.has(k) ? { key: k, body: objects.get(k)!, size: objects.get(k)!.byteLength } : null),
      delete: async (k) => void objects.delete(k),
      list: async (p = '') => ({ keys: [...objects.keys()].filter((k) => k.startsWith(p)) }),
    };
    const sink = storageLedgerSink(storage);
    const e = entries();
    await sink.append(e);
    expect([...objects.keys()].every((k) => k.startsWith('ops/deletion-ledger/site-a/'))).toBe(true);
    expect((await sink.readAll()).sort((a, b) => a.objectId.localeCompare(b.objectId))).toEqual([...e].sort((a, b) => a.objectId.localeCompare(b.objectId)));
  });
});
