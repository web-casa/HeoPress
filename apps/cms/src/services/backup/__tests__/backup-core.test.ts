import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import cron from 'node-cron';
import type { StorageObject, StorageProvider } from '@heopress/runtime';
import { instanceConfig, isSecretSetting } from '../config-backup';
import { backupConfigFromEnv, BackupConfigError } from '../config';
import { backupKeyId, BackupKeyError, decryptStream, encryptStream, loadBackupKey, parseBackupKey } from '../crypto';
import { canonicalJson, decodeManifest, encodeManifest, ManifestInvalidError, sha256Hex, type BackupManifest } from '../manifest';
import { ObjectHashMismatch, readObject, storeObject } from '../objects';
import { planBackupRetention, type BackupCatalogEntry } from '../../retention/backup-pruner';
import { retentionEntries } from '../retention';
import { BackupObjectMissing, LocalDirTarget, ObjectStoreTarget, readAll, type BackupTarget } from '../target';
import { withoutBlockIds } from '../../site-export/site-bundle';

/** HeoPress P13 tasks 1.1, 1.5: backup encryption, manifests, targets, stored objects, retention and configuration. */

class MemoryStorage implements StorageProvider {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, data: ReadableStream | Buffer): Promise<void> {
    this.objects.set(key, Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(await new Response(data).arrayBuffer()));
  }
  async get(key: string): Promise<StorageObject | null> {
    const b = this.objects.get(key);
    return b ? ({ body: b, size: b.length } as unknown as StorageObject) : null;
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async list(prefix = ''): Promise<{ keys: string[] }> {
    return { keys: [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort() };
  }
}

const dirs: string[] = [];
const tempDir = async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'hp-backup-unit-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function through(data: Buffer, ...stages: NodeJS.ReadWriteStream[]): Promise<Buffer> {
  const out: Buffer[] = [];
  await pipeline(Readable.from([data]), ...(stages as never[]), async function* (src: AsyncIterable<Buffer>) {
    for await (const c of src) out.push(c);
  } as never);
  return Buffer.concat(out);
}

describe('backup encryption', () => {
  const key = randomBytes(32);

  it('accepts a key as 64 hex characters, base64 or 32 raw bytes, and names it without revealing it', () => {
    expect(parseBackupKey(Buffer.from(key.toString('hex'))).equals(key)).toBe(true);
    expect(parseBackupKey(Buffer.from(`${key.toString('base64')}\n`)).equals(key)).toBe(true);
    expect(parseBackupKey(key).equals(key)).toBe(true);
    expect(() => parseBackupKey(Buffer.from('short'))).toThrow(BackupKeyError);
    expect(backupKeyId(key)).toMatch(/^[0-9a-f]{16}$/);
    expect(backupKeyId(key)).not.toBe(key.toString('hex').slice(0, 16));
  });

  it('round-trips any content and chunk size; a wrong key, a changed byte or a missing tail fails', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 300 }), fc.integer({ min: 1, max: 64 }), async (bytes, chunk) => {
        const plain = Buffer.from(bytes);
        const sealed = await through(plain, encryptStream(key, chunk));
        expect(sealed.includes(plain) && plain.length > 8).toBe(false);
        expect((await through(sealed, decryptStream(key))).equals(plain)).toBe(true);
        await expect(through(sealed, decryptStream(randomBytes(32)))).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
        const altered = Buffer.from(sealed);
        altered.writeUInt8(altered.readUInt8(altered.length - 1) ^ 1, altered.length - 1);
        await expect(through(altered, decryptStream(key))).rejects.toBeInstanceOf(BackupKeyError);
        if (plain.length > chunk) await expect(through(sealed.subarray(0, sealed.length - 17), decryptStream(key))).rejects.toBeInstanceOf(BackupKeyError);
      }),
      { numRuns: 40 },
    );
  });

  it('refuses a key file kept inside the backup directory', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'backup.key');
    await writeFile(file, key.toString('hex'));
    await expect(loadBackupKey(file, dir)).rejects.toMatchObject({ code: 'KEY_BESIDE_BACKUPS' });
    expect((await loadBackupKey(file, path.join(dir, 'elsewhere'))).equals(key)).toBe(true);
    await expect(loadBackupKey(path.join(dir, 'missing.key'))).rejects.toMatchObject({ code: 'KEY_UNREADABLE' });
  });
});

describe('backup manifest', () => {
  const manifest: BackupManifest = {
    format: 'heopress-backup',
    version: 1,
    id: '20261029T020000Z-f-0011aabb',
    kind: 'full',
    method: 'dump',
    createdAt: '2026-10-29T02:00:00.000Z',
    finishedAt: '2026-10-29T02:01:00.000Z',
    parent: null,
    base: null,
    chain: ['20261029T020000Z-f-0011aabb'],
    app: { version: '0.13.0', gitSha: 'abc1234' },
    database: { serverVersion: '18.1', systemIdentifier: '7000000000000000001', recoveryPoint: '0/3000000', startLsn: null, rowCounts: { 'public.lumibase_sites': 2 }, rowCountsExact: true },
    contentRepos: [{ siteId: 'site_a', commit: 'f'.repeat(40) }],
    objects: [{ path: 'database/dump.pgc', role: 'database', size: 10, sha256: 'a'.repeat(64), storedSize: 10, storedSha256: 'a'.repeat(64), parts: 1 }],
    media: { entries: [], newBlobs: 0 },
    encryption: null,
    warnings: [],
  };

  it('is canonical JSON with its SHA-256; a changed byte or another hash is refused', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
    const bytes = encodeManifest(manifest);
    expect(decodeManifest(bytes, sha256Hex(bytes))).toEqual(manifest);
    const altered = Buffer.from(bytes.toString('utf8').replace('"site_a"', '"site_b"'));
    expect(() => decodeManifest(altered, sha256Hex(bytes))).toThrow(ManifestInvalidError);
    expect(() => decodeManifest(Buffer.from('{"format":"other"}'), sha256Hex(Buffer.from('{"format":"other"}')))).toThrow(ManifestInvalidError);
  });
});

describe('backup targets and stored objects', () => {
  const targets: Array<[string, () => Promise<BackupTarget>]> = [
    ['local directory', async () => new LocalDirTarget(await tempDir())],
    ['object store (parts of 7 bytes)', async () => new ObjectStoreTarget(new MemoryStorage(), { description: 'memory', prefix: 'hp', partBytes: 7 })],
  ];

  for (const [name, make] of targets) {
    it(`${name}: writes, reads, lists and removes; refuses unsafe paths; a missing object is named`, async () => {
      const t = await make();
      for (const size of [0, 3, 7, 14, 30]) {
        const data = randomBytes(size);
        const { parts } = await t.write(`backups/b1/f${size}`, data);
        expect((await readAll(await t.read(`backups/b1/f${size}`, parts))).equals(data)).toBe(true);
      }
      await t.write('media/ab/blob', Buffer.from('x'));
      expect(await t.list('backups/b1/')).toEqual(['backups/b1/f0', 'backups/b1/f14', 'backups/b1/f3', 'backups/b1/f30', 'backups/b1/f7']);
      await t.remove('backups/b1/');
      expect(await t.list('backups/')).toEqual([]);
      expect(await t.list('media/')).toEqual(['media/ab/blob']);
      await expect(t.write('../escape', Buffer.from('x'))).rejects.toThrow(/Unsafe/);
      await expect(t.read('backups/none')).rejects.toBeInstanceOf(BackupObjectMissing);
    });

    it(`${name}: objects are checked against both hashes, encrypted or not`, async () => {
      const t = await make();
      for (const key of [null, randomBytes(32)]) {
        const data = randomBytes(40);
        const stored = await storeObject(t, 'backups/b2/x', data, key);
        expect(stored.sha256).toBe(sha256Hex(data));
        expect(stored.storedSha256 === stored.sha256).toBe(key === null);
        expect((await readObject(t, 'backups/b2/x', stored, key)).equals(data)).toBe(true);
        await expect(readObject(t, 'backups/b2/x', { ...stored, storedSha256: 'b'.repeat(64) }, key)).rejects.toBeInstanceOf(ObjectHashMismatch);
      }
    });
  }
});

describe('backup retention plan (ADR-0013: 14 daily, 8 weekly, whole chains)', () => {
  const day = (n: number, h = 2) => new Date(Date.UTC(2026, 9, 1 + n, h));
  const entry = (id: string, takenAt: Date, dependsOn: string | null = null, status: BackupCatalogEntry['status'] = 'succeeded'): BackupCatalogEntry => ({ id, takenAt, status, dependsOn });

  it('keeps the newest of each recent day and week, the latest, what is running, and every chain link a kept one needs', () => {
    const entries: BackupCatalogEntry[] = [];
    for (let d = 0; d < 60; d++) {
      entries.push(entry(`f${d}`, day(d)));
      entries.push(entry(`i${d}a`, day(d, 8), `f${d}`));
      entries.push(entry(`i${d}b`, day(d, 14), `i${d}a`));
    }
    entries.push(entry('running', day(60, 1), 'f59', 'running'));
    entries.push(entry('failed', day(59, 23), null, 'failed'));
    const plan = planBackupRetention(entries, { daily: 14, weekly: 8 });
    const keep = new Set(plan.keep);
    expect(keep.has('i59b')).toBe(true);
    expect(keep.has('running')).toBe(true);
    expect(keep.has('failed')).toBe(false);
    // Every kept incremental has its whole chain.
    const byId = new Map(entries.map((e) => [e.id, e]));
    for (const id of keep) for (let p = byId.get(id)!.dependsOn; p; p = byId.get(p)!.dependsOn) expect(keep.has(p), `${id} needs ${p}`).toBe(true);
    // 14 days kept by their newest (the second incremental), older ones only per week.
    for (let d = 46; d < 60; d++) expect(keep.has(`i${d}b`)).toBe(true);
    expect(keep.has('i10b')).toBe(true); // Sunday: the newest of its ISO week, eight weeks back
    expect(keep.has('i5b')).toBe(false);
    expect(keep.has('f5')).toBe(false);
    expect(plan.keep.length + plan.remove.length).toBe(entries.length);
  });

  it('never removes the latest successful backup or a dependency, for any history', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 400 }), fc.boolean(), fc.constantFrom('succeeded', 'failed', 'running') as fc.Arbitrary<BackupCatalogEntry['status']>), { minLength: 1, maxLength: 60 }), fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 10 }), (rows, daily, weekly) => {
        const entries: BackupCatalogEntry[] = [];
        rows.forEach(([hours, incremental, status], i) => {
          const parent = incremental && i > 0 ? entries[i - 1]!.id : null;
          entries.push(entry(`b${i}`, new Date(Date.UTC(2026, 0, 1) + hours * 3_600_000 * 6 + i), parent, status));
        });
        const plan = planBackupRetention(entries, { daily, weekly });
        const keep = new Set(plan.keep);
        const latest = entries.filter((e) => e.status === 'succeeded').sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime())[0];
        if (latest) expect(keep.has(latest.id)).toBe(true);
        const byId = new Map(entries.map((e) => [e.id, e]));
        for (const id of keep) for (let p = byId.get(id)!.dependsOn; p; p = byId.get(p)!.dependsOn) expect(keep.has(p)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('retention entries (the data-retention module plans what a prune removes, P13 task 5.1)', () => {
  it('maps catalogue rows to retention entries: removed ones left out, an incremental depends on its parent', () => {
    const at = new Date(Date.UTC(2026, 9, 1));
    const row = (id: string, status: string, parentId: string | null, startedAt: Date | null) => ({ id, status, parentId, startedAt, createdAt: at }) as unknown as Parameters<typeof retentionEntries>[0][number];
    expect(retentionEntries([row('f', 'succeeded', null, at), row('i', 'succeeded', 'f', null), row('old', 'removed', null, at), row('q', 'queued', null, null)])).toEqual([
      { id: 'f', takenAt: at, status: 'succeeded', dependsOn: null },
      { id: 'i', takenAt: at, status: 'succeeded', dependsOn: 'f' },
      // Queued is kept like running: it is about to be written.
      { id: 'q', takenAt: at, status: 'running', dependsOn: null },
    ]);
  });
});

describe('backup configuration', () => {
  it('spec "每日备份": by default a full backup runs every day, an incremental every hour and a restore drill every week', () => {
    const c = backupConfigFromEnv({ HEOPRESS_BACKUP_TARGET: '/srv/b', DATABASE_URL: 'postgresql://x@db.example.com/h' });
    // node-cron with seconds: second minute hour day-of-month month day-of-week (what the server schedules them with).
    expect(c.schedule).toEqual({ enabled: true, full: '0 30 2 * * *', incremental: '0 15 * * * *', drill: '0 0 4 * * 0' });
    for (const expr of [c.schedule.full, c.schedule.incremental, c.schedule.drill]) expect(cron.validate(expr), expr).toBe(true);
    const fields = (expr: string) => expr.split(' ');
    expect(fields(c.schedule.full).slice(3)).toEqual(['*', '*', '*']); // every day, once (fixed second, minute and hour)
    expect(fields(c.schedule.incremental).slice(2)).toEqual(['*', '*', '*', '*']); // every hour
    expect(fields(c.schedule.drill).slice(3, 5)).toEqual(['*', '*']); // one weekday: weekly
    expect(fields(c.schedule.drill)[5]).toMatch(/^[0-6]$/);
  });

  it('reads the target, method, schedule and retention; refuses what cannot work', () => {
    const c = backupConfigFromEnv({ HEOPRESS_BACKUP_TARGET: 'local:/var/lib/heopress/backups', DATABASE_URL: 'postgresql://app@db.example.com/heopress' });
    expect(c.target.description).toBe('local:/var/lib/heopress/backups');
    expect(c.method).toBe('basebackup');
    expect(c.retention).toEqual({ daily: 14, weekly: 8 });
    expect(c.schedule.enabled).toBe(true);
    expect(backupConfigFromEnv({ HEOPRESS_BACKUP_TARGET: '/srv/b', DATABASE_URL: 'postgresql://x@db.example.com/h', HEOPRESS_BACKUP_SCHEDULE: 'off', HEOPRESS_BACKUP_METHOD: 'dump', HEOPRESS_RETENTION_BACKUP_DAILY: '7' })).toMatchObject({
      method: 'dump',
      schedule: { enabled: false },
      retention: { daily: 7, weekly: 8 },
    });
    expect(() => backupConfigFromEnv({ HEOPRESS_BACKUP_TARGET: 'relative/dir', DATABASE_URL: 'postgresql://x@db.example.com/h' })).toThrow(BackupConfigError);
    expect(() => backupConfigFromEnv({ HEOPRESS_BACKUP_TARGET: 's3', DATABASE_URL: 'postgresql://x@db.example.com/h' })).toThrow(/HEOPRESS_BACKUP_S3_BUCKET/);
    expect(() => backupConfigFromEnv({ HEOPRESS_BACKUP_TARGET: '/srv/b', DATABASE_URL: 'postgresql://x@db.example.com/h', HEOPRESS_BACKUP_METHOD: 'zip' })).toThrow(BackupConfigError);
  });

  it('records settings but only the names of secrets; files only in an encrypted backup', async () => {
    expect(isSecretSetting('HEOPRESS_SMTP_PASSWORD', 'x')).toBe(true);
    expect(isSecretSetting('HEOPRESS_BACKUP_S3_SECRET_ACCESS_KEY', 'x')).toBe(true);
    expect(isSecretSetting('HEOPRESS_PUBLIC_URL', 'https://admin.example.com')).toBe(false);
    expect(isSecretSetting('HEOPRESS_CACHE_URL', 'redis://u:pw@cache.example.com')).toBe(true);
    const dir = await tempDir();
    const file = path.join(dir, 'heopress.env');
    await writeFile(file, 'JWT_SECRET=x\n');
    const env = { HEOPRESS_PUBLIC_URL: 'https://admin.example.com', JWT_SECRET: 'short-fake', DATABASE_URL: 'postgresql://u:pw@db.example.com/h', OTHER: 'ignored' };
    const plain = await instanceConfig(env, [file], false);
    expect(plain.snapshot.settings).toEqual({ HEOPRESS_PUBLIC_URL: 'https://admin.example.com' });
    expect(plain.snapshot.secretsSet).toEqual(['DATABASE_URL', 'JWT_SECRET']);
    expect(JSON.stringify(plain)).not.toContain('short-fake');
    expect(plain.files).toEqual([]);
    expect(plain.snapshot.filesSkipped).toEqual([file]);
    expect((await instanceConfig(env, [file], true)).files.map((f) => f.name)).toEqual(['01-heopress.env']);
  });
});

describe('single-site bundles carry no block IDs', () => {
  it('drops data-block-id from rich text and _blockId from rows, nothing else', () => {
    expect(withoutBlockIds('<p data-block-id="b_1">a</p><h2 class="x" data-block-id=\'b_2\'>b</h2>')).toBe('<p>a</p><h2 class="x">b</h2>');
    expect(withoutBlockIds([{ _blockId: 'b_1', q: 'x' }, 'y'])).toEqual([{ q: 'x' }, 'y']);
    expect(withoutBlockIds(3)).toBe(3);
  });
});
