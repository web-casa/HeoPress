import { and, eq, isNotNull } from 'drizzle-orm';
import { mediaObjects, sites, type Database } from '@heopress/database';
import type { KeyProvider, StorageProvider } from '@heopress/runtime';
import { StorageProfileService } from '../storage/storage-profile-service';
import { runSiteTransaction } from '../rls-transaction';
import { blobName } from './crypto';
import { blobPath, sha256Hex, type MediaEntry } from './manifest';
import { storeObject } from './objects';
import type { BackupTarget } from './target';

/**
 * Media in a backup (HeoPress P13 tasks 1.1, 1.5; spec ops/backup-restore "一致备份与隔离恢复").
 *
 * Every object of every media store — the instance storage, and each site's storage profiles — is listed in the
 * manifest with its SHA-256; the content is kept once, by hash, under `media/` of the target (a keyed name when
 * encrypted). The sync is incremental: content already kept is not written again, and a profile object whose change
 * hint (update time and size) is the same as in the previous backup is not even read again.
 *
 * Objects that change while the backup runs are versioned, not torn: what was read is hashed and kept as read, so the
 * manifest always names bytes that exist; an object that disappeared after it was listed keeps the previous backup's
 * copy (`carried`). The database copy is taken first, so every object it refers to was in a store when listed.
 */

export interface MediaSourceObject {
  store: string;
  key: string;
  siteId?: string;
  version?: string;
  read(): Promise<{ body: Buffer; contentType?: string; metadata?: Record<string, string> } | null>;
}

export interface MediaSource {
  store: string;
  list(): Promise<MediaSourceObject[]>;
}

async function bodyOf(body: ReadableStream | Buffer): Promise<Buffer> {
  return Buffer.isBuffer(body) ? body : Buffer.from(await new Response(body).arrayBuffer());
}

/** The instance storage: every object in it. */
export function instanceMediaSource(storage: StorageProvider): MediaSource {
  return {
    store: 'default',
    async list() {
      const { keys } = await storage.list('');
      return keys.map((key) => ({
        store: 'default',
        key,
        async read() {
          const obj = await storage.get(key);
          if (!obj) return null;
          const metadata = obj.metadata && Object.keys(obj.metadata).length ? obj.metadata : undefined;
          return { body: await bodyOf(obj.body), contentType: obj.contentType, metadata };
        },
      }));
    },
  };
}

/** Each site's storage profiles: the objects recorded on them (`lumibase_media_objects`). */
export function profileMediaSource(db: Database, deps: { keys: KeyProvider; defaultStorage: StorageProvider; storageDir?: string }): MediaSource {
  return {
    store: 'profiles',
    async list() {
      const out: MediaSourceObject[] = [];
      for (const { id: siteId } of await db.select({ id: sites.id }).from(sites).orderBy(sites.id)) {
        const rows = await runSiteTransaction(db, siteId, (tx) =>
          tx
            .select({ key: mediaObjects.key, profileId: mediaObjects.storageProfileId, objectKey: mediaObjects.objectKey, updatedAt: mediaObjects.updatedAt, size: mediaObjects.size })
            .from(mediaObjects)
            .where(and(eq(mediaObjects.siteId, siteId), isNotNull(mediaObjects.storageProfileId))),
        );
        // The profile service reads within the site's own transaction (RLS), constructed on it.
        const locate = (key: string) =>
          runSiteTransaction(db, siteId, (tx) => new StorageProfileService({ db: tx as unknown as Database, siteId, keys: deps.keys, defaultStorage: deps.defaultStorage, storageDir: deps.storageDir }).readLocation(key));
        for (const r of rows) {
          out.push({
            store: `profile:${r.profileId}`,
            key: r.objectKey,
            siteId,
            version: `${r.updatedAt.toISOString()}|${r.size ?? ''}`,
            async read() {
              const at = await locate(r.key);
              const obj = await at.storage.get(at.objectKey);
              if (!obj) return null;
              const metadata = obj.metadata && Object.keys(obj.metadata).length ? obj.metadata : undefined;
              return { body: await bodyOf(obj.body), contentType: obj.contentType, metadata };
            },
          });
        }
      }
      return out;
    },
  };
}

export interface MediaSyncResult {
  entries: MediaEntry[];
  newBlobs: number;
  warnings: string[];
}

/**
 * Sync the sources' objects into the target. `previous` is the last backup's media index: unchanged objects are taken
 * from it, and its blobs are known to be in the target. `beforeRead` is a test seam (an object changing mid-backup).
 */
export async function syncMedia(opts: {
  sources: MediaSource[];
  target: BackupTarget;
  key: Buffer | null;
  previous: MediaEntry[];
  beforeRead?: (o: MediaSourceObject) => Promise<void>;
}): Promise<MediaSyncResult> {
  const prev = new Map(opts.previous.map((e) => [`${e.store}\0${e.key}`, e]));
  const knownBlobs = new Map<string, Pick<MediaEntry, 'storedSize' | 'storedSha256' | 'parts'>>();
  for (const e of opts.previous) knownBlobs.set(e.blob, { storedSize: e.storedSize, storedSha256: e.storedSha256, parts: e.parts });
  const entries: MediaEntry[] = [];
  const warnings: string[] = [];
  let newBlobs = 0;
  for (const source of opts.sources) {
    let listed: MediaSourceObject[];
    try {
      listed = await source.list();
    } catch (err) {
      throw new Error(`Media store "${source.store}" could not be listed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }
    for (const o of listed) {
      const before = prev.get(`${o.store}\0${o.key}`);
      if (before && o.version && before.version === o.version) {
        entries.push({ ...before, ...(o.siteId ? { siteId: o.siteId } : {}), carried: undefined });
        continue;
      }
      await opts.beforeRead?.(o);
      const got = await o.read();
      if (!got) {
        if (before) {
          entries.push({ ...before, carried: true });
          warnings.push(`Media "${o.store}/${o.key}" disappeared during the backup; the previous backup's copy is kept.`);
        } else {
          warnings.push(`Media "${o.store}/${o.key}" disappeared during the backup and was never backed up.`);
        }
        continue;
      }
      const sha256 = sha256Hex(got.body);
      const blob = blobName(sha256, opts.key);
      let stored = knownBlobs.get(blob);
      if (!stored) {
        const s = await storeObject(opts.target, blobPath(blob), got.body, opts.key);
        stored = { storedSize: s.storedSize, storedSha256: s.storedSha256, parts: s.parts };
        knownBlobs.set(blob, stored);
        newBlobs++;
      }
      entries.push({
        store: o.store,
        key: o.key,
        ...(o.siteId ? { siteId: o.siteId } : {}),
        size: got.body.length,
        sha256,
        ...(got.contentType ? { contentType: got.contentType } : {}),
        ...(got.metadata ? { metadata: got.metadata } : {}),
        blob,
        ...stored,
        ...(o.version ? { version: o.version } : {}),
      });
    }
  }
  return { entries, newBlobs, warnings };
}
