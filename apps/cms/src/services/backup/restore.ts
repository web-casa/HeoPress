import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { StorageProvider } from '@heopress/runtime';
import { DATABASE_DIRS, loadManifest } from './backup-service';
import { BackupKeyError, backupKeyId } from './crypto';
import { backupDir, blobPath, type BackupManifest, type MediaEntry } from './manifest';
import { fetchObjectTo, openObject, readObject } from './objects';
import { findPgTool, parsePgUrl, pgEnv, runTool } from './pg-tools';
import { isSafeTargetPath, type BackupTarget } from './target';

/**
 * Restoring a backup (HeoPress P13 tasks 1.3, 1.5; spec ops/backup-restore "一致备份与隔离恢复" — "缺失基础链").
 *
 * The chain is resolved first: an incremental needs every backup back to its full one, each with a readable manifest.
 * A missing link fails the restore before anything is written (`BASE_CHAIN_MISSING`): nothing claims to restore what
 * it cannot. Every object is checked against its manifest hashes as it is read; an encrypted backup needs its key,
 * given separately (never from the backup or the instance settings), and a wrong key is named as such.
 *
 *   - a dump is restored into a database (`pg_restore`, no owners or grants from the source);
 *   - a base backup chain is combined (`pg_combinebackup`) into a data directory and verified (`pg_verifybackup`):
 *     the operator starts PostgreSQL on it;
 *   - media go back into storage providers, by store.
 *
 * Before writes open on the restored database, the deletion ledger is replayed on it (`replayLedgerAfterRestore`,
 * P13 task 5.2).
 */

export class RestoreError extends Error {
  constructor(
    readonly code: 'BASE_CHAIN_MISSING' | 'CHAIN_BROKEN' | 'NOT_FOUND' | 'KEY_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'RestoreError';
  }
}

/** The manifests from the full backup to `id`, each checked; fails when a link is missing or does not fit. */
export async function resolveChain(target: BackupTarget, id: string, key: Buffer | null): Promise<BackupManifest[]> {
  let last: BackupManifest;
  try {
    last = await loadManifest(target, id, key);
  } catch (err) {
    if (err instanceof BackupKeyError) throw err;
    throw new RestoreError('NOT_FOUND', `Backup ${id} has no readable manifest: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (last.encryption && !key) throw new RestoreError('KEY_REQUIRED', `Backup ${id} is encrypted: give its key (key id ${last.encryption.keyId}).`);
  if (last.encryption && key && backupKeyId(key) !== last.encryption.keyId) throw new BackupKeyError('KEY_MISMATCH', `Backup ${id} needs key ${last.encryption.keyId}.`);
  const chain: BackupManifest[] = [];
  for (const member of last.chain.slice(0, -1)) {
    let m: BackupManifest;
    try {
      m = await loadManifest(target, member, key);
    } catch (err) {
      if (err instanceof BackupKeyError) throw err;
      throw new RestoreError('BASE_CHAIN_MISSING', `Backup ${id} needs ${member} of its chain, which is missing or unreadable: it cannot be restored.`);
    }
    chain.push(m);
  }
  chain.push(last);
  for (let i = 1; i < chain.length; i++) {
    if (chain[i]!.parent !== chain[i - 1]!.id) throw new RestoreError('CHAIN_BROKEN', `Backup ${chain[i]!.id} was not taken against ${chain[i - 1]!.id}.`);
  }
  if (chain[0]!.kind !== 'full') throw new RestoreError('CHAIN_BROKEN', `The chain of ${id} does not start with a full backup.`);
  return chain;
}

/** Copy (and check) every database object of `m` into `dir`. */
async function fetchDatabase(target: BackupTarget, m: BackupManifest, key: Buffer | null, dir: string): Promise<void> {
  const listing = m.objects.find((x) => x.path === DATABASE_DIRS);
  if (listing) {
    for (const rel of (await readObject(target, `${backupDir(m.id)}/${listing.path}`, listing, key)).toString('utf8').split('\n')) {
      if (!rel) continue;
      if (!isSafeTargetPath(rel)) throw new RestoreError('CHAIN_BROKEN', `Backup ${m.id} lists an unsafe directory.`);
      await mkdir(path.join(dir, ...rel.split('/')), { recursive: true, mode: 0o700 });
    }
  }
  for (const o of m.objects.filter((x) => x.role === 'database' && x.path !== DATABASE_DIRS)) {
    const rel = o.path.replace(/^database\//, '');
    await fetchObjectTo(target, `${backupDir(m.id)}/${o.path}`, o, key, path.join(dir, ...rel.split('/')));
  }
}

/**
 * The database of a chain, ready to use: the dump file, or a combined and verified data directory. `work` is an empty
 * directory the caller removes.
 */
export async function materializeDatabase(target: BackupTarget, chain: BackupManifest[], key: Buffer | null, work: string, pgBinDir: string | null): Promise<{ kind: 'dump'; file: string } | { kind: 'cluster'; dataDir: string }> {
  const last = chain.at(-1)!;
  if (last.method === 'dump') {
    const dir = path.join(work, 'dump');
    await fetchDatabase(target, last, key, dir);
    return { kind: 'dump', file: path.join(dir, 'dump.pgc') };
  }
  const dirs: string[] = [];
  for (const [i, m] of chain.entries()) {
    const dir = path.join(work, `chain-${String(i).padStart(3, '0')}`);
    await mkdir(dir, { recursive: true });
    await fetchDatabase(target, m, key, dir);
    dirs.push(dir);
  }
  let dataDir = dirs[0]!;
  if (dirs.length > 1) {
    dataDir = path.join(work, 'combined');
    await runTool(await findPgTool('pg_combinebackup', pgBinDir), [...dirs, '-o', dataDir], { env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' }, timeoutMs: 6 * 60 * 60 * 1000 });
  }
  await chmod(dataDir, 0o700);
  // Every file against PostgreSQL's own manifest, and the WAL the copy needs.
  await runTool(await findPgTool('pg_verifybackup', pgBinDir), [dataDir], { env: { PATH: `${path.dirname(await findPgTool('pg_verifybackup', pgBinDir))}:${process.env.PATH ?? ''}`, LANG: 'C', LC_ALL: 'C' }, timeoutMs: 60 * 60 * 1000 });
  return { kind: 'cluster', dataDir };
}

/** `pg_restore` a dump into the (empty) database `databaseUrl` names. */
export async function restoreDump(file: string, databaseUrl: string, pgBinDir: string | null): Promise<void> {
  await runTool(await findPgTool('pg_restore', pgBinDir), ['--no-owner', '--no-privileges', '--exit-on-error', '--no-password', '-d', parsePgUrl(databaseUrl).database, file], {
    env: pgEnv(parsePgUrl(databaseUrl)),
    timeoutMs: 6 * 60 * 60 * 1000,
  });
}

export interface MediaRestoreFailure {
  store: string;
  key: string;
  message: string;
}

/**
 * Put every media object of `m` back, checked against the manifest: `storeFor` names the provider for a store (null:
 * skip it). Failures are listed, never thrown, so a drill reports every object that does not match.
 */
export async function restoreMedia(target: BackupTarget, m: BackupManifest, key: Buffer | null, storeFor: (store: string) => StorageProvider | null): Promise<{ restored: number; failures: MediaRestoreFailure[] }> {
  const byBlob = new Map<string, MediaEntry[]>();
  for (const e of m.media.entries) byBlob.set(e.blob, [...(byBlob.get(e.blob) ?? []), e]);
  let restored = 0;
  const failures: MediaRestoreFailure[] = [];
  for (const [blob, entries] of byBlob) {
    let bytes: Buffer;
    try {
      bytes = await readObject(target, blobPath(blob), entries[0]!, key);
    } catch (err) {
      for (const e of entries) failures.push({ store: e.store, key: e.key, message: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const e of entries) {
      const storage = storeFor(e.store);
      if (!storage) continue;
      await storage.put(e.key, bytes, { ...(e.metadata ?? {}), ...(e.contentType && !e.metadata?.contentType ? { contentType: e.contentType } : {}) });
      restored++;
    }
  }
  return { restored, failures };
}

/**
 * Check a backup without restoring it: its chain and manifests, every database and configuration object of the chain
 * and every media object against their SHA-256. Problems are listed, not thrown (a missing chain link still throws).
 */
export async function verifyBackup(target: BackupTarget, id: string, key: Buffer | null): Promise<{ chain: string[]; objects: number; media: number; failures: Array<{ object: string; message: string }> }> {
  const chain = await resolveChain(target, id, key);
  const failures: Array<{ object: string; message: string }> = [];
  let objects = 0;
  for (const m of chain) {
    for (const o of m.objects) {
      objects++;
      try {
        for await (const _ of await openObject(target, `${backupDir(m.id)}/${o.path}`, o, key)) void _;
      } catch (err) {
        failures.push({ object: `${m.id}/${o.path}`, message: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  const last = chain.at(-1)!;
  const seen = new Set<string>();
  for (const e of last.media.entries) {
    if (seen.has(e.blob)) continue;
    seen.add(e.blob);
    try {
      for await (const _ of await openObject(target, blobPath(e.blob), e, key)) void _;
    } catch (err) {
      failures.push({ object: `${e.store}/${e.key}`, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return { chain: chain.map((m) => m.id), objects, media: last.media.entries.length, failures };
}
