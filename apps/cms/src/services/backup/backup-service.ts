import { createReadStream } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { backups, gitSnapshotRepos, sites, type Database } from '@heopress/database';
import { formatSafeError } from '@heopress/contracts/utils';
import type { BackupConfig } from './config';
import { instanceConfig } from './config-backup';
import { backupKeyId, BackupKeyError, loadBackupKey, macMatches, manifestMac } from './crypto';
import { incrementalPrerequisites, takeBasebackup, takeDump, type DatabaseInfo } from './database-backup';
import { withBackupLock } from './lock';
import { BACKUP_FORMAT, BACKUP_FORMAT_VERSION, backupDir, decodeManifest, encodeManifest, sha256Hex, type BackupManifest, type BackupObject } from './manifest';
import { syncMedia, type MediaSource, type MediaSourceObject } from './media-backup';
import { fetchObjectTo, storeObject } from './objects';
import { notifyInstanceAdministrator } from './notify';
import { redactConn } from './pg-tools';
import { readAll, type BackupTarget } from './target';
import { runSiteTransaction } from '../rls-transaction';

/**
 * Scheduled backups (HeoPress P13 tasks 1.1, 1.5; spec ops/backup-restore "带清单的定时备份", "一致备份与隔离恢复").
 *
 * One run: the database (a full or incremental base backup, or a dump), the configuration, then the media; then the
 * manifest (versions, content repository commits, every object with its SHA-256), written last — a backup without a
 * manifest is not a backup, and its partial files are removed. Runs are serialised (`withBackupLock`) and recorded in
 * `lumibase_backups`; a failure is recorded with its reason and the instance administrator is told.
 *
 * Incrementals: taken against the latest successful backup of the same chain (same method and key) while the chain is
 * shorter than `maxChain`. Asked for explicitly (`incremental`), a missing base or unmet prerequisites fail the run —
 * nothing claims to be restorable that is not. The hourly schedule asks for `auto`: no usable base means a full backup.
 */

export interface BackupDeps {
  db: Database;
  config: BackupConfig;
  mediaSources: MediaSource[];
  /** The environment whose non-secret settings are recorded (`config/instance.json`). */
  env: Record<string, string | undefined>;
  app: { version: string; gitSha: string };
  /** Test seam: called before each media object is read. */
  beforeMediaRead?: (o: MediaSourceObject) => Promise<void>;
}

export type BackupKindRequest = 'full' | 'incremental' | 'auto';

class BackupError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

export type BackupRow = typeof backups.$inferSelect;

function newBackupId(now: Date, kind: 'full' | 'incremental'): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}-${kind === 'full' ? 'f' : 'i'}-${randomBytes(4).toString('hex')}`;
}

const MANIFEST = 'manifest.json';
/** A base backup's directory list (not part of the data directory). */
export const DATABASE_DIRS = 'database.dirs';

/** Read and check a backup's manifest (SHA-256; and the MAC when a key is given and the backup is encrypted). */
export async function loadManifest(target: BackupTarget, id: string, key: Buffer | null = null): Promise<BackupManifest> {
  const dir = backupDir(id);
  const bytes = await readAll(await target.read(`${dir}/${MANIFEST}`));
  const recorded = (await readAll(await target.read(`${dir}/${MANIFEST}.sha256`))).toString('utf8');
  const m = decodeManifest(bytes, recorded);
  if (m.id !== id) throw new BackupError('MANIFEST_MISMATCH', `The manifest in ${dir} is for backup ${m.id}.`);
  if (m.encryption && key) {
    if (backupKeyId(key) !== m.encryption.keyId) throw new BackupKeyError('KEY_MISMATCH', `Backup ${id} was encrypted with key ${m.encryption.keyId}, not this one (${backupKeyId(key)}).`);
    const mac = (await readAll(await target.read(`${dir}/${MANIFEST}.mac`))).toString('utf8').trim();
    if (!macMatches(mac, manifestMac(key, bytes))) throw new BackupError('MANIFEST_TAMPERED', `The manifest of backup ${id} does not carry a valid MAC for this key.`);
  }
  return m;
}

/** The files under `root`, and (in `dirs`) every directory — empty ones matter to PostgreSQL (`pg_tblspc`, …). */
async function walkFiles(root: string, dirs: string[] = []): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        dirs.push(path.relative(root, f).split(path.sep).join('/'));
        await walk(f);
      }
      else if (e.isFile()) out.push(path.relative(root, f).split(path.sep).join('/'));
      else throw new BackupError('UNSUPPORTED_FILE', `The database copy holds "${path.relative(root, f)}", which is not a file (tablespaces are not supported).`);
    }
  };
  await walk(root);
  return out.sort();
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const t = items[i++]!;
      await fn(t);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** A short temporary directory (unix socket paths have a length limit). */
export async function workDir(prefix: string): Promise<string> {
  const base = tmpdir().length > 60 ? '/tmp' : tmpdir();
  return mkdtemp(path.join(base, prefix));
}

/** Catalogue rows, newest first (`removed` ones only when asked). */
export async function listBackups(db: Database, opts: { includeRemoved?: boolean; limit?: number } = {}): Promise<BackupRow[]> {
  const q = db.select().from(backups);
  const rows = await (opts.includeRemoved ? q : q.where(ne(backups.status, 'removed'))).orderBy(desc(backups.createdAt)).limit(opts.limit ?? 1000);
  return rows;
}

/** Ask for a full backup now: a `queued` row the worker's backup tick takes up. */
export async function requestBackup(db: Database, input: { requestedBy: string | null; method: BackupConfig['method'] }): Promise<BackupRow> {
  const id = newBackupId(new Date(), 'full');
  const [row] = await db.insert(backups).values({ id, kind: 'full', method: input.method, status: 'queued', trigger: 'manual', requestedBy: input.requestedBy }).returning();
  return row!;
}

interface ChainParent {
  row: BackupRow;
  manifest: BackupManifest;
}

/** The backup an incremental would be taken against, or why there is none. */
async function chainParent(deps: BackupDeps, keyId: string | null): Promise<ChainParent | { missing: string }> {
  const [latest] = await deps.db
    .select()
    .from(backups)
    .where(and(eq(backups.status, 'succeeded'), eq(backups.method, 'basebackup')))
    .orderBy(desc(backups.createdAt))
    .limit(1);
  if (!latest) return { missing: 'There is no full base backup to take an incremental against.' };
  if ((latest.keyId ?? null) !== keyId) return { missing: 'The latest backup was taken with another encryption key; a new chain starts with a full backup.' };
  let manifest: BackupManifest;
  try {
    manifest = await loadManifest(deps.config.target, latest.id);
  } catch (err) {
    return { missing: `The base backup ${latest.id} is not readable in the target: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (manifest.chain.length > deps.config.maxChain) return { missing: `The chain from ${manifest.chain[0]} already has ${manifest.chain.length - 1} incrementals.` };
  // Every backup of the chain must still be there.
  for (const id of manifest.chain) {
    const list = await deps.config.target.list(`${backupDir(id)}/${MANIFEST}`).catch(() => []);
    if (list.length === 0) return { missing: `Backup ${id} of the chain is missing from the target.` };
  }
  return { row: latest, manifest };
}

/**
 * Take a backup. Resolves with the catalogue row, `succeeded` or `failed` (a failure is recorded and reported, not
 * thrown); throws `BackupBusyError` when another backup operation holds the lock.
 */
export async function runBackup(deps: BackupDeps, req: { kind: BackupKindRequest; trigger: 'schedule' | 'manual'; requestedBy?: string | null; queuedId?: string }): Promise<BackupRow> {
  const { db, config } = deps;
  return withBackupLock(config.databaseUrl, async () => {
    // Nothing else runs under the lock: a `running` row left behind was interrupted.
    await db.update(backups).set({ status: 'failed', error: 'Interrupted (the worker stopped during the backup).', finishedAt: new Date() }).where(eq(backups.status, 'running'));
    const started = new Date();
    let id = req.queuedId ?? null;
    let kind: 'full' | 'incremental' = req.kind === 'incremental' ? 'incremental' : 'full';
    const recordFailure = async (code: string, message: string) => {
      const values = { status: 'failed', error: `${code}: ${message}`.slice(0, 2000), finishedAt: new Date(), startedAt: started };
      if (id) await db.update(backups).set(values).where(eq(backups.id, id));
      else {
        id = newBackupId(started, kind);
        await db.insert(backups).values({ id, kind: 'full', method: config.method, trigger: req.trigger, requestedBy: req.requestedBy ?? null, target: config.target.description, ...values });
      }
      await notifyInstanceAdministrator(db, {
        event: 'backup_failed',
        subject: `Backup failed: ${code}`,
        message: `The ${req.trigger} backup ${id} failed: ${message}`,
        data: { backupId: id, code },
      });
      const [row] = await db.select().from(backups).where(eq(backups.id, id!));
      return row!;
    };

    let key: Buffer | null = null;
    try {
      key = config.keyFile ? await loadBackupKey(config.keyFile, config.target.localRoot) : null;
    } catch (err) {
      return recordFailure(err instanceof BackupKeyError ? err.code : 'KEY_UNREADABLE', err instanceof Error ? err.message : String(err));
    }
    const keyId = key ? backupKeyId(key) : null;

    // Which kind, against what.
    let parent: ChainParent | null = null;
    if (req.kind !== 'full') {
      if (config.method === 'dump') {
        if (req.kind === 'incremental') return recordFailure('INCREMENTAL_UNSUPPORTED', 'The dump method takes full backups only (set HEOPRESS_BACKUP_METHOD=basebackup for incrementals).');
      } else {
        const found = await chainParent(deps, keyId);
        if ('missing' in found) {
          if (req.kind === 'incremental') return recordFailure('INCREMENTAL_BASE_MISSING', found.missing);
        } else {
          const problems = await incrementalPrerequisites(config.databaseUrl).catch((err: unknown) => [`The server could not be asked: ${err instanceof Error ? err.message : String(err)}`]);
          if (problems.length > 0) return recordFailure('INCREMENTAL_PREREQUISITES', problems.join(' '));
          parent = found;
          kind = 'incremental';
        }
      }
    }

    if (!id) id = newBackupId(started, kind);
    const base = parent ? (parent.manifest.base ?? parent.manifest.id) : null;
    const values = {
      kind,
      method: config.method,
      status: 'running',
      trigger: req.trigger,
      parentId: parent?.row.id ?? null,
      baseId: base,
      target: config.target.description,
      encrypted: key !== null,
      keyId,
      startedAt: started,
      error: null,
    };
    if (req.queuedId) await db.update(backups).set(values).where(eq(backups.id, id));
    else await db.insert(backups).values({ id, requestedBy: req.requestedBy ?? null, ...values });

    const dir = backupDir(id);
    const work = await workDir('hpbk-');
    const warnings: string[] = [];
    try {
      const objects: BackupObject[] = [];
      const put = async (rel: string, role: BackupObject['role'], file: string) => {
        const s = await storeObject(config.target, `${dir}/${rel}`, createReadStream(file), key);
        objects.push({ path: rel, role, ...s });
      };

      // 1. The database.
      let info: DatabaseInfo;
      if (config.method === 'dump') {
        const file = path.join(work, 'dump.pgc');
        info = await takeDump({ databaseUrl: config.databaseUrl, file, pgBinDir: config.pgBinDir });
        await put('database/dump.pgc', 'database', file);
      } else {
        let incrementalManifest: string | undefined;
        if (parent) {
          const pm = parent.manifest.objects.find((o) => o.path === 'database/backup_manifest');
          if (!pm) throw new BackupError('INCREMENTAL_BASE_MISSING', `Backup ${parent.row.id} has no backup_manifest.`);
          incrementalManifest = path.join(work, 'parent_backup_manifest');
          await fetchObjectTo(config.target, `${backupDir(parent.row.id)}/${pm.path}`, pm, key, incrementalManifest);
        }
        const dbDir = path.join(work, 'db');
        info = await takeBasebackup({ databaseUrl: config.databaseUrl, dir: dbDir, label: `heopress ${id}`, pgBinDir: config.pgBinDir, incrementalManifest });
        const dirs: string[] = [];
        const files = await walkFiles(dbDir, dirs);
        await pool(files, 8, (rel) => put(`database/${rel}`, 'database', path.join(dbDir, ...rel.split('/'))));
        // The directory list (empty directories included), recreated on restore before the files.
        const listing = path.join(work, 'dirs');
        await writeFile(listing, `${dirs.sort().join('\n')}\n`);
        await put(DATABASE_DIRS, 'database', listing);
      }

      // 2. The configuration.
      const cfg = await instanceConfig(deps.env, config.configFiles, key !== null);
      if (cfg.snapshot.filesSkipped.length) warnings.push(`Configuration files are only included in encrypted backups: ${cfg.snapshot.filesSkipped.length} skipped.`);
      const instanceJson = Buffer.from(`${JSON.stringify(cfg.snapshot, null, 2)}\n`);
      objects.push({ path: 'config/instance.json', role: 'config', ...(await storeObject(config.target, `${dir}/config/instance.json`, instanceJson, key)) });
      for (const f of cfg.files) objects.push({ path: `config/files/${f.name}`, role: 'config', ...(await storeObject(config.target, `${dir}/config/files/${f.name}`, f.bytes, key)) });

      // 3. Media, against the last backup made with the same key.
      const [prevRow] = await db
        .select()
        .from(backups)
        .where(and(eq(backups.status, 'succeeded'), ...(keyId ? [eq(backups.keyId, keyId)] : [eq(backups.encrypted, false)])))
        .orderBy(desc(backups.createdAt))
        .limit(1);
      const previous = prevRow ? await loadManifest(config.target, prevRow.id).catch(() => null) : null;
      const media = await syncMedia({ sources: deps.mediaSources, target: config.target, key, previous: previous?.media.entries ?? [], beforeRead: deps.beforeMediaRead });
      warnings.push(...media.warnings);

      // 4. Each site's content repository commit.
      const contentRepos: BackupManifest['contentRepos'] = [];
      for (const { id: siteId } of await db.select({ id: sites.id }).from(sites).orderBy(sites.id)) {
        const [repo] = await runSiteTransaction(db, siteId, (tx) => tx.select({ commit: gitSnapshotRepos.lastCommitSha }).from(gitSnapshotRepos).where(eq(gitSnapshotRepos.siteId, siteId)));
        if (repo) contentRepos.push({ siteId, commit: repo.commit ?? null });
      }

      // 5. The manifest, last.
      const manifest: BackupManifest = {
        format: BACKUP_FORMAT,
        version: BACKUP_FORMAT_VERSION,
        id,
        kind,
        method: config.method,
        createdAt: started.toISOString(),
        finishedAt: new Date().toISOString(),
        parent: parent?.row.id ?? null,
        base,
        chain: parent ? [...parent.manifest.chain, id] : [id],
        app: deps.app,
        database: {
          serverVersion: info.serverVersion,
          systemIdentifier: info.systemIdentifier,
          recoveryPoint: info.recoveryPoint,
          startLsn: info.startLsn,
          rowCounts: info.rowCounts,
          rowCountsExact: info.rowCountsExact,
        },
        contentRepos,
        objects: objects.sort((a, b) => (a.path < b.path ? -1 : 1)),
        media: { entries: media.entries, newBlobs: media.newBlobs },
        encryption: key ? { algorithm: 'AES-256-GCM-STREAM', keyId: keyId! } : null,
        warnings,
      };
      const bytes = encodeManifest(manifest);
      const digest = sha256Hex(bytes);
      await config.target.write(`${dir}/${MANIFEST}`, bytes);
      await config.target.write(`${dir}/${MANIFEST}.sha256`, Buffer.from(`${digest}\n`));
      if (key) await config.target.write(`${dir}/${MANIFEST}.mac`, Buffer.from(`${manifestMac(key, bytes)}\n`));

      const [row] = await db
        .update(backups)
        .set({
          status: 'succeeded',
          manifestSha256: digest,
          sizeBytes: objects.reduce((n, o) => n + o.storedSize, 0),
          objectCount: objects.length,
          mediaObjects: media.entries.length,
          mediaNew: media.newBlobs,
          recoveryPoint: new Date(info.recoveryPoint),
          finishedAt: new Date(),
          error: warnings.length ? `warnings: ${warnings.length}` : null,
        })
        .where(eq(backups.id, id))
        .returning();
      return row!;
    } catch (err) {
      await config.target.remove(`${dir}/`).catch(() => undefined);
      const code = err instanceof BackupError ? err.code : ((err as { code?: string }).code ?? 'BACKUP_FAILED');
      const message = redactConn(err instanceof Error ? err.message : JSON.stringify(formatSafeError(err)));
      return recordFailure(String(code), message);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });
}

/** Queued backups (asked for from Studio or the API), oldest first. */
export async function queuedBackups(db: Database): Promise<BackupRow[]> {
  return db.select().from(backups).where(inArray(backups.status, ['queued'])).orderBy(backups.createdAt);
}
