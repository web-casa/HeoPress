import { createHash } from 'node:crypto';
import { and, eq, lt, notExists, sql } from 'drizzle-orm';
import { ingestSnapshots, ingestSourceDocuments, sites, type Database } from '@heopress/database';
import type { StorageProvider } from '@heopress/runtime';
import { runSiteTransaction } from '../rls-transaction';

/**
 * Raw HTML snapshots (HeoPress P08 tasks 2.3, 2.5, 2.7; spec ingest/crawling "规则版本与可恢复登记").
 *
 * Object storage cannot join a PostgreSQL transaction, so a snapshot is written in two steps:
 *
 * 1. `writeSnapshot` registers the snapshot row (site, sha256) — or moves its `last_written_at` on — in its own
 *    committed transaction, **then** puts the bytes at `ingest/snapshots/<site>/<sha256>.html` (same content, same
 *    key: a repeated write is harmless). If the put fails nothing references the row; it is an orphan.
 * 2. The caller commits the source document referencing the row by foreign key (`source-documents.ts`).
 *
 * `sweepOrphanSnapshots` deletes rows no document references whose last write is older than the grace period, and
 * their objects. The row is deleted first, inside a transaction that also deletes the object; a document commit racing
 * it either sees the row (and the sweeper's delete then fails on the foreign key and skips it) or does not (and the
 * document's insert fails, the fetch retries and writes the snapshot again). The grace period (default 24 h,
 * `HEOPRESS_INGEST_SNAPSHOT_GRACE_HOURS`) must exceed the longest retry window of a fetch job (minutes).
 *
 * The key lies outside every site's media prefix (`sites/<site>/media/`): the public media route cannot name it.
 * Administrators download a snapshot only through `GET /api/v1/ingest/documents/:id/snapshot` (attachment, sandboxed).
 */

const SNAPSHOT_PREFIX = 'ingest/snapshots/';
const SNAPSHOT_CONTENT_TYPE = 'text/html; charset=utf-8';

export function snapshotKey(siteId: string, sha256: string): string {
  return `${SNAPSHOT_PREFIX}${siteId}/${sha256}.html`;
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function snapshotGraceMs(env: Record<string, string | undefined> = process.env): number {
  const h = Number(env.HEOPRESS_INGEST_SNAPSHOT_GRACE_HOURS);
  return (Number.isFinite(h) && h >= 1 ? h : 24) * 3600_000;
}

export interface SnapshotRef {
  id: string;
  sha256: string;
  storageKey: string;
}

/** Register and write a snapshot. Idempotent per (site, content). */
export async function writeSnapshot(
  deps: { db: Database; storage: StorageProvider; now?: () => Date },
  siteId: string,
  bytes: Buffer,
): Promise<SnapshotRef> {
  const sha256 = sha256Of(bytes);
  const storageKey = snapshotKey(siteId, sha256);
  const now = deps.now?.() ?? new Date();
  const [row] = await runSiteTransaction(deps.db, siteId, (tx) =>
    tx
      .insert(ingestSnapshots)
      .values({ siteId, sha256, storageKey, byteSize: bytes.byteLength, contentType: SNAPSHOT_CONTENT_TYPE, createdAt: now, lastWrittenAt: now })
      .onConflictDoUpdate({
        target: [ingestSnapshots.siteId, ingestSnapshots.sha256],
        // HeoPress P13 task 5.1: content removed past its retention period is stored again by a new fetch; content
        // erased under a personal-data deletion request is not (its tombstone stays, the bytes are not written).
        set: {
          lastWrittenAt: now,
          contentDeletedAt: sql`CASE WHEN ${ingestSnapshots.deletionReason} = 'personal_data_erasure' THEN ${ingestSnapshots.contentDeletedAt} ELSE NULL END`,
          deletionReason: sql`CASE WHEN ${ingestSnapshots.deletionReason} = 'personal_data_erasure' THEN ${ingestSnapshots.deletionReason} ELSE NULL END`,
        },
      })
      .returning({ id: ingestSnapshots.id, erased: ingestSnapshots.contentDeletedAt }),
  );
  if (!row!.erased) await deps.storage.put(storageKey, bytes, { contentType: SNAPSHOT_CONTENT_TYPE, sha256 });
  return { id: row!.id, sha256, storageKey };
}

/** Read a snapshot's bytes (admin download, tests). */
export async function readSnapshot(storage: StorageProvider, key: string): Promise<Buffer | null> {
  const obj = await storage.get(key);
  if (!obj) return null;
  return Buffer.from(await new Response(obj.body as BodyInit).arrayBuffer());
}

/** Delete unreferenced snapshots older than the grace period, site by site. Returns the keys removed. */
export async function sweepOrphanSnapshots(
  deps: { db: Database; storage: StorageProvider; now?: () => Date; graceMs?: number; limitPerSite?: number },
): Promise<string[]> {
  const cutoff = new Date((deps.now?.() ?? new Date()).getTime() - (deps.graceMs ?? snapshotGraceMs()));
  const siteRows = await deps.db.select({ id: sites.id }).from(sites);
  const removed: string[] = [];
  for (const { id: siteId } of siteRows) {
    const candidates = await runSiteTransaction(deps.db, siteId, (tx) =>
      tx
        .select({ id: ingestSnapshots.id, storageKey: ingestSnapshots.storageKey })
        .from(ingestSnapshots)
        .where(
          and(
            eq(ingestSnapshots.siteId, siteId),
            lt(ingestSnapshots.lastWrittenAt, cutoff),
            notExists(
              deps.db
                .select({ one: sql`1` })
                .from(ingestSourceDocuments)
                .where(and(eq(ingestSourceDocuments.siteId, siteId), eq(ingestSourceDocuments.snapshotId, ingestSnapshots.id))),
            ),
          ),
        )
        .limit(deps.limitPerSite ?? 500),
    );
    for (const c of candidates) {
      try {
        const gone = await runSiteTransaction(
          deps.db,
          siteId,
          async (tx) => {
            // Re-checked under the row lock: a write since the scan moved last_written_at on.
            const [row] = await tx
              .delete(ingestSnapshots)
              .where(and(eq(ingestSnapshots.siteId, siteId), eq(ingestSnapshots.id, c.id), lt(ingestSnapshots.lastWrittenAt, cutoff)))
              .returning({ id: ingestSnapshots.id });
            if (!row) return false;
            await deps.storage.delete(c.storageKey);
            return true;
          },
          { retry: false },
        );
        if (gone) removed.push(c.storageKey);
      } catch {
        // Referenced meanwhile (foreign key) or storage unavailable: next sweep.
      }
    }
  }
  return removed;
}
