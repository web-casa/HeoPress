import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { StorageObject, StorageProvider } from '@heopress/runtime';
import { loadManifest } from '../backup-service';
import { backupConfigFromEnv, backupsConfigured, BackupConfigError } from '../config';
import { backupKeyId, BackupKeyError, decryptStream, encryptStream, loadBackupKey, manifestMac, parseBackupKey } from '../crypto';
import { backupDir, blobPath, encodeManifest, sha256Hex, type BackupManifest } from '../manifest';
import { instanceMediaSource, syncMedia, type MediaSource, type MediaSourceObject } from '../media-backup';
import { openObject, readObject, storeObject } from '../objects';
import { describeConn, findPgTool, parsePgUrl, pgEnv, pgToolsAvailable, redactConn, runTool, withDatabase } from '../pg-tools';
import { resolveChain, restoreMedia, RestoreError, verifyBackup } from '../restore';
import { BundleInvalidError } from '../../site-import/bundle-reader';
import { loadSiteBundle, withoutBlockIds } from '../../site-export/site-bundle';
import { BackupObjectMissing, isSafeTargetPath, LocalDirTarget, ObjectStoreTarget, readAll } from '../target';

/**
 * HeoPress P13 tasks 1.1, 1.5: the edges of the backup module without a database — PostgreSQL program handling,
 * configuration errors, both target kinds' error paths, a wrong or missing key, and every way a restore chain fails
 * before anything is written.
 */

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
  const d = await mkdtemp(path.join(tmpdir(), 'hp-backup-edge-'));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const DB = 'postgresql://backup:s3cret@db.example.com:5433/heopress?sslmode=require';

describe('PostgreSQL programs and connections', () => {
  it('parses connection URLs into libpq settings, never a command line', () => {
    const c = parsePgUrl(DB);
    expect(c).toEqual({ host: 'db.example.com', port: 5433, user: 'backup', password: 's3cret', database: 'heopress', sslmode: 'require' });
    expect(describeConn(c)).toBe('db.example.com:5433/heopress');
    const env = pgEnv(c);
    expect(env).toMatchObject({ PGHOST: 'db.example.com', PGPORT: '5433', PGUSER: 'backup', PGDATABASE: 'heopress', PGPASSWORD: 's3cret', PGSSLMODE: 'require' });
    const bare = parsePgUrl('postgres://app@db.example.com');
    expect(bare).toMatchObject({ port: 5432, password: null, database: 'postgres', sslmode: null });
    expect(pgEnv(bare)).not.toHaveProperty('PGPASSWORD');
    expect(pgEnv(bare)).not.toHaveProperty('PGSSLMODE');
    expect(() => parsePgUrl('mysql://u@db.example.com/x')).toThrow(/Not a PostgreSQL URL/);
    expect(parsePgUrl(withDatabase(DB, 'heopress drill')).database).toBe('heopress drill');
  });

  it('redacts passwords from tool output', () => {
    expect(redactConn(`could not connect to ${DB}`)).toBe('could not connect to postgresql://backup:***@db.example.com:5433/heopress?sslmode=require');
    expect(redactConn('host=db password=hunter2 user=x')).toBe('host=db password=*** user=x');
  });

  it('finds a program in the given directory or reports it missing by name', async () => {
    const dir = await tempDir();
    const tool = path.join(dir, 'pg_fake_tool');
    await writeFile(tool, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    expect(await findPgTool('pg_fake_tool', dir)).toBe(tool);
    await expect(findPgTool('pg_no_such_tool_p13', dir)).rejects.toMatchObject({ code: 'TOOL_MISSING', message: expect.stringMatching(/HEOPRESS_PG_BIN_DIR/) });
    expect(await pgToolsAvailable(['pg_fake_tool'], dir)).toBe(true);
    expect(await pgToolsAvailable(['pg_fake_tool', 'pg_no_such_tool_p13'], dir)).toBe(false);
  });

  it('runs a program with only the environment given; a failure carries its redacted standard error', async () => {
    const env = { PATH: process.env.PATH, SECRET_P13: 'from-the-caller' };
    expect(await runTool('/bin/sh', ['-c', 'printf "%s" "$SECRET_P13"; printf "%s" "$JWT_SECRET"'], { env })).toBe('from-the-caller');
    await expect(runTool('/bin/sh', ['-c', `echo "fatal: ${DB}" >&2; exit 3`], { env })).rejects.toMatchObject({
      code: 'TOOL_FAILED',
      message: expect.stringMatching(/exit 3.*backup:\*\*\*@db\.example\.com/),
    });
    await expect(runTool('/bin/sh', ['-c', 'sleep 5'], { env, timeoutMs: 50 })).rejects.toMatchObject({ code: 'TOOL_FAILED', message: expect.stringMatching(/SIGTERM/) });
    await expect(runTool(path.join(await tempDir(), 'missing'), [], { env })).rejects.toMatchObject({ code: 'TOOL_FAILED', message: expect.stringMatching(/could not start/) });
  });
});

describe('backup configuration errors', () => {
  const base = { HEOPRESS_BACKUP_TARGET: '/srv/backups', DATABASE_URL: 'postgresql://app@db.example.com/heopress' };

  it('is configured only with a target; an s3 target needs its bucket and credentials', () => {
    expect(backupsConfigured({})).toBe(false);
    expect(backupsConfigured({ HEOPRESS_BACKUP_TARGET: '  ' })).toBe(false);
    expect(backupsConfigured(base)).toBe(true);
    const s3 = backupConfigFromEnv({
      ...base,
      HEOPRESS_BACKUP_TARGET: 's3',
      HEOPRESS_BACKUP_S3_BUCKET: 'heopress-backups',
      HEOPRESS_BACKUP_S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      HEOPRESS_BACKUP_S3_SECRET_ACCESS_KEY: 'fake-short',
      HEOPRESS_BACKUP_S3_ENDPOINT: 'https://s3.example.com',
      HEOPRESS_BACKUP_S3_REGION: 'auto',
      HEOPRESS_BACKUP_S3_FORCE_PATH_STYLE: 'true',
    });
    expect(s3.target.description).toBe('s3:heopress-backups/heopress-backups');
    expect(s3.target.localRoot).toBeNull();
    const prefixed = backupConfigFromEnv({ ...base, HEOPRESS_BACKUP_TARGET: 's3', HEOPRESS_BACKUP_S3_BUCKET: 'b', HEOPRESS_BACKUP_S3_ACCESS_KEY_ID: 'a', HEOPRESS_BACKUP_S3_SECRET_ACCESS_KEY: 's', HEOPRESS_BACKUP_S3_PREFIX: 'site-network/backups', HEOPRESS_BACKUP_S3_FORCE_PATH_STYLE: '0' });
    expect(prefixed.target.description).toBe('s3:b/site-network/backups');
    expect(() => backupConfigFromEnv({ ...base, HEOPRESS_BACKUP_TARGET: 's3', HEOPRESS_BACKUP_S3_BUCKET: 'b' })).toThrow(/_ACCESS_KEY_ID/);
  });

  it('prefers the backup role, then the owner, then the application database; one is required', () => {
    expect(backupConfigFromEnv({ ...base, DATABASE_OWNER_URL: 'postgresql://owner@db.example.com/heopress' }).databaseUrl).toMatch(/owner@/);
    expect(backupConfigFromEnv({ ...base, DATABASE_OWNER_URL: 'postgresql://owner@db.example.com/heopress', HEOPRESS_BACKUP_DATABASE_URL: 'postgresql://repl@db.example.com/heopress' }).databaseUrl).toMatch(/repl@/);
    expect(() => backupConfigFromEnv({ HEOPRESS_BACKUP_TARGET: '/srv/backups' })).toThrow(BackupConfigError);
    expect(() => backupConfigFromEnv({ DATABASE_URL: base.DATABASE_URL })).toThrow(/HEOPRESS_BACKUP_TARGET is not set/);
  });

  it('checks the chain length, the configuration files and the schedule', () => {
    expect(backupConfigFromEnv({ ...base, HEOPRESS_BACKUP_MAX_CHAIN: '12' }).maxChain).toBe(12);
    for (const bad of ['0', '1001', '2.5', 'many']) expect(() => backupConfigFromEnv({ ...base, HEOPRESS_BACKUP_MAX_CHAIN: bad })).toThrow(/HEOPRESS_BACKUP_MAX_CHAIN/);
    expect(backupConfigFromEnv({ ...base, HEOPRESS_BACKUP_CONFIG_FILES: '/etc/heopress/heopress.env, /etc/caddy/Caddyfile,' }).configFiles).toEqual(['/etc/heopress/heopress.env', '/etc/caddy/Caddyfile']);
    expect(() => backupConfigFromEnv({ ...base, HEOPRESS_BACKUP_CONFIG_FILES: 'heopress.env' })).toThrow(/absolute/);
    const c = backupConfigFromEnv({
      ...base,
      HEOPRESS_BACKUP_SCHEDULE: 'false',
      HEOPRESS_BACKUP_FULL_CRON: '0 0 1 * * *',
      HEOPRESS_BACKUP_INCREMENTAL_CRON: '0 30 * * * *',
      HEOPRESS_BACKUP_DRILL_CRON: '0 0 5 * * 6',
      HEOPRESS_BACKUP_ENCRYPTION_KEY_FILE: '/etc/heopress/backup.key',
      HEOPRESS_BACKUP_DRILL_DATABASE_URL: 'postgresql://drill@db.example.com/postgres',
      HEOPRESS_PG_BIN_DIR: '/usr/lib/postgresql/18/bin',
    });
    expect(c.schedule).toEqual({ enabled: false, full: '0 0 1 * * *', incremental: '0 30 * * * *', drill: '0 0 5 * * 6' });
    expect(c).toMatchObject({ keyFile: '/etc/heopress/backup.key', drillDatabaseUrl: 'postgresql://drill@db.example.com/postgres', pgBinDir: '/usr/lib/postgresql/18/bin' });
    // An invalid retention value falls back to the policy default, as for every retention job.
    expect(backupConfigFromEnv({ ...base, HEOPRESS_RETENTION_BACKUP_WEEKLY: 'lots' }).retention).toEqual({ daily: 14, weekly: 8 });
  });
});

describe('backup targets: unsafe paths and missing objects', () => {
  it('accepts plain relative paths only', () => {
    for (const ok of ['backups/a/manifest.json', 'media/ab/abcdef', 'backups/a/']) expect(isSafeTargetPath(ok), ok).toBe(true);
    for (const bad of ['', '/etc/passwd', 'a/../b', 'a//b', './a', 'a\\b', 'a\0b', 'x'.repeat(2001)]) expect(isSafeTargetPath(bad), bad).toBe(false);
  });

  it('local: refuses unsafe paths, reports missing objects, lists a single file or nothing, skips temporary files', async () => {
    const root = await tempDir();
    const t = new LocalDirTarget(root);
    await expect(t.write('../outside', Buffer.from('x'))).rejects.toThrow(/Unsafe backup path/);
    await expect(t.read('backups/none/manifest.json')).rejects.toBeInstanceOf(BackupObjectMissing);
    await t.write('backups/b1/database/dump.pgc', Readable.from([Buffer.from('dump')]));
    await expect(t.read('backups/b1/database')).rejects.toBeInstanceOf(BackupObjectMissing);
    expect(await t.list('backups/b1/database/dump.pgc')).toEqual(['backups/b1/database/dump.pgc']);
    expect(await t.list('backups/none/')).toEqual([]);
    await writeFile(path.join(root, 'backups', 'b1', '.tmp-partial'), 'x');
    expect(await t.list('')).toEqual(['backups/b1/database/dump.pgc']);
    // A failed write leaves no temporary file behind.
    const failing = new Readable({
      read() {
        this.destroy(new Error('source failed'));
      },
    });
    await expect(t.write('backups/b1/config/instance.json', failing)).rejects.toThrow('source failed');
    expect(await t.list('backups/b1/config/')).toEqual([]);
    await t.remove('backups/b1/');
    expect(await t.list('')).toEqual([]);
  });

  it('object store: refuses an unsafe prefix, reads a one-part file written as parts, fails a missing part, removes a file with its parts only', async () => {
    expect(() => new ObjectStoreTarget(new MemoryStorage(), { description: 'memory', prefix: '../escape' })).toThrow(/Unsafe/);
    const storage = new MemoryStorage();
    const t = new ObjectStoreTarget(storage, { description: 'memory', partBytes: 4 });
    expect((await t.write('a/exact', Buffer.from('1234'))).parts).toBe(1);
    expect((await readAll(await t.read('a/exact'))).toString()).toBe('1234');
    const { parts } = await t.write('a/big', Buffer.from('0123456789'));
    expect(parts).toBe(3);
    await t.write('a/bigger', Buffer.from('x'));
    expect((await readAll(await t.read('a/big', parts))).toString()).toBe('0123456789');
    // Without its count, a multi-part file is read from its first part (the count comes from the manifest).
    expect((await readAll(await t.read('a/big'))).toString()).toBe('0123');
    await expect(t.read('a/none')).rejects.toBeInstanceOf(BackupObjectMissing);
    storage.objects.delete('a/big.part-00002');
    await expect(readAll(await t.read('a/big', parts))).rejects.toBeInstanceOf(BackupObjectMissing);
    expect(await t.list('a/')).toEqual(['a/big', 'a/bigger', 'a/exact']);
    await t.remove('a/big');
    expect(await t.list('')).toEqual(['a/bigger', 'a/exact']);
  });
});

describe('keys and encrypted objects', () => {
  it('refuses a key that is not 32 bytes, a key file that cannot be read, and a key inside the backups', async () => {
    expect(() => parseBackupKey(Buffer.from('too short'))).toThrow(BackupKeyError);
    expect(() => parseBackupKey(Buffer.from(randomBytes(18).toString('base64')))).toThrow(/32 bytes/);
    const dir = await tempDir();
    await expect(loadBackupKey(path.join(dir, 'none.key'))).rejects.toMatchObject({ code: 'KEY_UNREADABLE' });
    await mkdir(path.join(dir, 'target'));
    await writeFile(path.join(dir, 'target', 'k'), randomBytes(32).toString('hex'));
    await expect(loadBackupKey(path.join(dir, 'target', 'k'), path.join(dir, 'target'))).rejects.toMatchObject({ code: 'KEY_BESIDE_BACKUPS' });
    expect((await loadBackupKey(path.join(dir, 'target', 'k'), path.join(dir, 'elsewhere'))).length).toBe(32);
  });

  it('a wrong key, a file that is not encrypted, or a truncated one fails to decrypt', async () => {
    const key = randomBytes(32);
    const t = new LocalDirTarget(await tempDir());
    const stored = await storeObject(t, 'x/secret', Readable.from([Buffer.from('confidential '.repeat(100))]), key);
    expect((await readObject(t, 'x/secret', stored, key)).toString()).toContain('confidential');
    await expect(readObject(t, 'x/secret', stored, randomBytes(32))).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
    const plain = await storeObject(t, 'x/plain', Readable.from([Buffer.from('not encrypted at all, long enough for a header')]), null);
    await expect(readObject(t, 'x/plain', { ...plain, sha256: plain.sha256 }, key)).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
    const empty = await storeObject(t, 'x/empty', Readable.from([Buffer.alloc(0)]), null);
    await expect(readObject(t, 'x/empty', empty, key)).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
    // Encrypting then decrypting nothing gives nothing.
    const chunks: Buffer[] = [];
    for await (const c of Readable.from([Buffer.alloc(0)]).pipe(encryptStream(key, 16)).pipe(decryptStream(key))) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).length).toBe(0);
    // A stored-hash mismatch is reported as such.
    await expect(openObject(t, 'x/plain', { ...plain, storedSha256: 'f'.repeat(64) }, null).then(readAll)).rejects.toThrow(/as stored/);
  });
});

describe('restore chains fail before anything is written', () => {
  const manifest = (id: string, over: Partial<BackupManifest> = {}): BackupManifest => ({
    format: 'heopress-backup',
    version: 1,
    id,
    kind: 'full',
    method: 'basebackup',
    createdAt: '2026-10-29T02:00:00.000Z',
    finishedAt: '2026-10-29T02:01:00.000Z',
    parent: null,
    base: null,
    chain: [id],
    app: { version: '1.0.0', gitSha: 'abc1234' },
    database: { serverVersion: '18.1', systemIdentifier: null, recoveryPoint: '0/3000000', startLsn: null, rowCounts: {}, rowCountsExact: false },
    contentRepos: [],
    objects: [],
    media: { entries: [], newBlobs: 0 },
    encryption: null,
    warnings: [],
    ...over,
  });
  const put = async (t: LocalDirTarget, m: BackupManifest, key: Buffer | null = null) => {
    const bytes = encodeManifest(m);
    await t.write(`${backupDir(m.id)}/manifest.json`, bytes);
    await t.write(`${backupDir(m.id)}/manifest.json.sha256`, Buffer.from(sha256Hex(bytes)));
    if (key) await t.write(`${backupDir(m.id)}/manifest.json.mac`, Buffer.from(manifestMac(key, bytes)));
  };

  it('names what is wrong: no manifest, a manifest of another backup, a missing key, a broken or partial chain', async () => {
    const t = new LocalDirTarget(await tempDir());
    await expect(resolveChain(t, 'nope', null)).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // A manifest stored under another backup's id.
    const moved = manifest('b-moved');
    const bytes = encodeManifest(moved);
    await t.write(`${backupDir('b-other')}/manifest.json`, bytes);
    await t.write(`${backupDir('b-other')}/manifest.json.sha256`, Buffer.from(sha256Hex(bytes)));
    await expect(loadManifest(t, 'b-other')).rejects.toMatchObject({ code: 'MANIFEST_MISMATCH' });

    const key = randomBytes(32);
    const enc = manifest('b-enc', { encryption: { algorithm: 'AES-256-GCM-STREAM', keyId: backupKeyId(key) } });
    await put(t, enc, key);
    await expect(resolveChain(t, 'b-enc', null)).rejects.toMatchObject({ code: 'KEY_REQUIRED' });
    await expect(resolveChain(t, 'b-enc', randomBytes(32))).rejects.toMatchObject({ code: 'KEY_MISMATCH' });
    expect((await resolveChain(t, 'b-enc', key)).map((m) => m.id)).toEqual(['b-enc']);
    await t.write(`${backupDir('b-enc')}/manifest.json.mac`, Buffer.from('0'.repeat(64)));
    await expect(loadManifest(t, 'b-enc', key)).rejects.toMatchObject({ code: 'MANIFEST_TAMPERED' });

    // An incremental whose recorded parent is not the previous link.
    await put(t, manifest('f1'));
    await put(t, manifest('i1', { kind: 'incremental', parent: 'f-other', base: 'f1', chain: ['f1', 'i1'] }));
    await expect(resolveChain(t, 'i1', null)).rejects.toMatchObject({ code: 'CHAIN_BROKEN' });
    // A chain that does not start with a full backup.
    await put(t, manifest('i0', { kind: 'incremental', parent: null, chain: ['i0'] }));
    await expect(resolveChain(t, 'i0', null)).rejects.toBeInstanceOf(RestoreError);
    // A missing base.
    await put(t, manifest('i2', { kind: 'incremental', parent: 'f-gone', base: 'f-gone', chain: ['f-gone', 'i2'] }));
    await expect(resolveChain(t, 'i2', null)).rejects.toMatchObject({ code: 'BASE_CHAIN_MISSING' });
  });

  it('verify lists every object and media blob that does not match; media restore skips stores and reports failures', async () => {
    const t = new LocalDirTarget(await tempDir());
    const good = await storeObject(t, `${backupDir('v1')}/config/instance.json`, Readable.from([Buffer.from('{}')]), null);
    const bad = await storeObject(t, `${backupDir('v1')}/database/dump.pgc`, Readable.from([Buffer.from('dump')]), null);
    const blob = 'ab' + 'c'.repeat(62);
    const media = await storeObject(t, blobPath(blob), Readable.from([Buffer.from('png')]), null);
    await put(
      t,
      manifest('v1', {
        method: 'dump',
        objects: [
          { path: 'config/instance.json', role: 'config', ...good },
          { path: 'database/dump.pgc', role: 'database', ...bad, sha256: 'e'.repeat(64) },
        ],
        media: {
          entries: [
            { store: 'default', key: 'sites/a/media/x.png', blob, contentType: 'image/png', ...media },
            { store: 'profile:p1', key: 'sites/a/media/x.png', blob, ...media },
            { store: 'default', key: 'sites/a/media/gone.png', blob: 'ff' + '0'.repeat(62), ...media },
          ],
          newBlobs: 1,
        },
      } as Partial<BackupManifest>),
    );
    const r = await verifyBackup(t, 'v1', null);
    expect(r).toMatchObject({ chain: ['v1'], objects: 2, media: 3 });
    expect(r.failures.map((f) => f.object)).toEqual(['v1/database/dump.pgc', 'default/sites/a/media/gone.png']);

    const into = new MemoryStorage();
    const restored = await restoreMedia(t, await loadManifest(t, 'v1'), null, (store) => (store === 'default' ? into : null));
    expect(restored.restored).toBe(1);
    expect(restored.failures.map((f) => f.key)).toEqual(['sites/a/media/gone.png']);
    expect(into.objects.get('sites/a/media/x.png')?.toString()).toBe('png');
  });
});

describe('single-site bundles: the records only a new site takes', () => {
  const header = { type: 'header', format: 'heopress-import', version: 1, source: 'heopress', sourceSite: 'site-a' };
  const item = (id: string) => ({ type: 'item', externalId: id, collection: 'articles', locale: 'en', status: 'published', data: { title: id, slug: id } });
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
  const TEMPLATE = Buffer.from('<main>{% item_body %}</main>');
  const ASSET = Buffer.from('body{color:#111}');
  const theme = (over: Record<string, unknown> = {}) => ({
    type: 'theme',
    name: 'classic-a',
    active: true,
    templates: [{ name: 'item.liquid', size: TEMPLATE.length, sha256: sha(TEMPLATE) }],
    assets: [{ path: 'css/site.css', contentType: 'text/css', size: ASSET.length, sha256: sha(ASSET) }],
    ...over,
  });
  async function bundle(records: unknown[], files: Record<string, Buffer> = { 'templates/item.liquid': TEMPLATE, 'assets/css/site.css': ASSET }): Promise<string> {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'bundle.ndjson'), records.map((r) => JSON.stringify(r)).join('\n'));
    for (const [rel, bytes] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, 'theme', rel)), { recursive: true });
      await writeFile(path.join(dir, 'theme', rel), bytes);
    }
    return dir;
  }
  const problems = async (dir: string) => {
    try {
      await loadSiteBundle(dir);
      return [];
    } catch (err) {
      if (err instanceof BundleInvalidError) return err.problems.map((p) => p.code);
      throw err;
    }
  };

  it('reads schema, relations, theme, settings, sources and auto-publish; theme files only from inside theme/', async () => {
    const dir = await bundle([
      header,
      item('a'),
      item('b'),
      { type: 'collectionSchema', collection: 'articles', fields: [{ name: 'related', type: 'json', interface: 'list-m2m' }] },
      { type: 'relation', externalId: 'a', field: 'related', targets: ['b'], many: true },
      theme(),
      { type: 'siteConfig', content: { defaultLocale: 'en' }, site: { displayTitle: 'A' } },
      { type: 'ingestSource', name: 'News', sourceType: 'url', url: 'https://news.example.com/', scheduleTimes: ['06:00'], timezone: 'UTC' },
      { type: 'autoPublish', settings: { enabled: false } },
    ]);
    const b = await loadSiteBundle(dir);
    expect(b.schemas).toHaveLength(1);
    expect(b.relations[0]).toMatchObject({ externalId: 'a', targets: ['b'] });
    expect(b.theme?.name).toBe('classic-a');
    expect(b.siteConfig?.site).toEqual({ displayTitle: 'A' });
    expect(b.sources.map((s) => s.name)).toEqual(['News']);
    expect(b.autoPublish).not.toBeNull();
    expect((await b.readThemeFile('templates/item.liquid')).toString()).toContain('item_body');
    await expect(b.readThemeFile('../bundle.ndjson')).rejects.toBeInstanceOf(BundleInvalidError);
    const bare = await loadSiteBundle(await bundle([header, item('a')], {}));
    expect(bare).toMatchObject({ theme: null, siteConfig: null, autoPublish: null, relations: [], sources: [] });
  });

  it('refuses unknown relation items, duplicates, and theme files missing, outside, resized or altered', async () => {
    expect(
      await problems(
        await bundle([
          header,
          item('a'),
          { type: 'relation', externalId: 'ghost', field: 'related', targets: ['a', 'nobody'], many: true },
          theme(),
          theme(),
          { type: 'siteConfig', content: {}, site: {} },
          { type: 'siteConfig', content: {}, site: {} },
          { type: 'autoPublish', settings: {} },
          { type: 'autoPublish', settings: {} },
        ]),
      ),
    ).toEqual(expect.arrayContaining(['UNKNOWN_ITEM', 'THEME_DUPLICATE', 'SITE_CONFIG_DUPLICATE', 'AUTO_PUBLISH_DUPLICATE']));
    expect(await problems(await bundle([header, item('a'), theme()], { 'templates/item.liquid': TEMPLATE }))).toEqual(['THEME_FILE_MISSING']);
    expect(await problems(await bundle([header, item('a'), theme()], { 'templates/item.liquid': Buffer.concat([TEMPLATE, Buffer.from('!')]), 'assets/css/site.css': ASSET }))).toEqual(['THEME_FILE_SIZE']);
    expect(await problems(await bundle([header, item('a'), theme()], { 'templates/item.liquid': Buffer.from('<main>{% item_body %}</mAin>'), 'assets/css/site.css': ASSET }))).toEqual(['THEME_FILE_HASH']);
  });

  it('strips block IDs from rich text and repeater rows, leaving other values alone', () => {
    expect(withoutBlockIds('<p data-block-id="b1">x</p><p data-block-id=b2>y</p>')).toBe('<p>x</p><p>y</p>');
    expect(withoutBlockIds('<p>plain</p>')).toBe('<p>plain</p>');
    expect(withoutBlockIds([{ _blockId: 'r1', text: 'a' }, { text: 'b' }, null, ['nested']])).toEqual([{ text: 'a' }, { text: 'b' }, null, ['nested']]);
    expect(withoutBlockIds({ _blockId: 'kept on objects' })).toEqual({ _blockId: 'kept on objects' });
    expect(withoutBlockIds(42)).toBe(42);
  });
});

describe('media sync: unchanged, rewritten, disappeared and unlistable objects', () => {
  const obj = (store: string, key: string, body: Buffer | null, extra: Partial<MediaSourceObject> = {}): MediaSourceObject => ({
    store,
    key,
    read: async () => (body ? { body, ...(key.endsWith('.png') ? { contentType: 'image/png', metadata: { alt: 'a' } } : {}) } : null),
    ...extra,
  });
  const source = (store: string, objects: MediaSourceObject[]): MediaSource => ({ store, list: async () => objects });

  it('keeps content once by hash, reuses known blobs, carries unchanged and vanished objects, and names an unlistable store', async () => {
    const target = new LocalDirTarget(await tempDir());
    const same = Buffer.from('same bytes');
    const first = await syncMedia({
      sources: [source('default', [obj('default', 'a.png', same), obj('default', 'b.txt', same)]), source('profiles', [obj('profile:p1', 'c.txt', Buffer.from('c'), { siteId: 'site_x', version: 'v1' })])],
      target,
      key: null,
      previous: [],
    });
    // Two objects with the same bytes share one blob.
    expect(first.newBlobs).toBe(2);
    expect(first.warnings).toEqual([]);
    expect(first.entries.find((e) => e.key === 'a.png')).toMatchObject({ contentType: 'image/png', metadata: { alt: 'a' } });
    expect(first.entries.find((e) => e.key === 'b.txt')).not.toHaveProperty('contentType');
    expect(first.entries.find((e) => e.key === 'c.txt')).toMatchObject({ siteId: 'site_x', version: 'v1' });

    const seen: string[] = [];
    const second = await syncMedia({
      sources: [
        source('default', [obj('default', 'a.png', null), obj('default', 'gone.txt', null), obj('default', 'b.txt', Buffer.from('rewritten'))]),
        source('profiles', [obj('profile:p1', 'c.txt', null, { siteId: 'site_x', version: 'v1' })]),
      ],
      target,
      key: null,
      previous: first.entries,
      beforeRead: async (o) => void seen.push(o.key),
    });
    // The unchanged profile object is not read again.
    expect(seen).toEqual(['a.png', 'gone.txt', 'b.txt']);
    expect(second.newBlobs).toBe(1);
    expect(second.entries.find((e) => e.key === 'a.png')).toMatchObject({ carried: true });
    expect(second.entries.find((e) => e.key === 'c.txt')).toMatchObject({ siteId: 'site_x', carried: undefined });
    expect(second.entries.find((e) => e.key === 'gone.txt')).toBeUndefined();
    expect(second.warnings).toEqual([expect.stringMatching(/previous backup's copy is kept/), expect.stringMatching(/never backed up/)]);

    const broken: MediaSource = {
      store: 'profiles',
      list: async () => {
        throw new Error('profile offline');
      },
    };
    await expect(syncMedia({ sources: [broken], target, key: null, previous: [] })).rejects.toThrow(/"profiles" could not be listed: profile offline/);
    const odd: MediaSource = {
      store: 'odd',
      list: async () => {
        throw 'plain';
      },
    };
    await expect(syncMedia({ sources: [odd], target, key: null, previous: [] })).rejects.toThrow(/could not be listed: plain/);
  });

  it('reads the instance storage: streams and buffers, metadata only when there is some, nothing for a vanished key', async () => {
    const storage = new MemoryStorage();
    await storage.put('x.txt', Buffer.from('x'));
    await storage.put('y.txt', Buffer.from('y'));
    const streamed: StorageProvider = {
      ...storage,
      put: storage.put.bind(storage),
      delete: storage.delete.bind(storage),
      list: storage.list.bind(storage),
      get: async (key) => {
        if (key === 'y.txt') return null;
        return { body: new Response('x').body!, size: 1, contentType: 'text/plain', metadata: { a: 'b' } } as unknown as StorageObject;
      },
    };
    const listed = await instanceMediaSource(streamed).list();
    expect(listed.map((o) => o.key)).toEqual(['x.txt', 'y.txt']);
    expect(await listed[0]!.read()).toEqual({ body: Buffer.from('x'), contentType: 'text/plain', metadata: { a: 'b' } });
    expect(await listed[1]!.read()).toBeNull();
    const plain = await instanceMediaSource(storage).list();
    expect(await plain[0]!.read()).toEqual({ body: Buffer.from('x'), contentType: undefined, metadata: undefined });
  });
});
