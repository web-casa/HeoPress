import { mkdir, open, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { deletionLedger, ingestSnapshots, items, sites, type Database } from '@heopress/database';
import type { StorageProvider } from '@heopress/runtime';
import { itemServiceForSystem } from '../item-service-factory';
import { runSiteTransaction } from '../rls-transaction';
import { tombstoneSnapshot } from './snapshot-retention';

/**
 * The deletion ledger (HeoPress P13 task 5.2; spec ops/data-retention "删除账本与恢复后重放"; ADR-0013 §3).
 *
 * After a personal-data deletion request runs, every object it deleted is recorded — identifiers and time only, never
 * content — in two places:
 *
 * - the **external ledger** (`DeletionLedgerSink`): an append-only store outside the database, written *before* the
 *   objects are deleted, so a crash in between leaves a record whose replay is harmless (the object is gone or goes);
 * - the `lumibase_deletion_ledger` table, written after each deletion.
 *
 * Restoring a backup brings back an older database — and an older table. The restore flow therefore calls
 * `replayDeletionLedger` **after the restore and before writes open**: it reads the union of the external ledger and
 * the table, deletes again every object that came back, writes the missing rows into the table and returns a report
 * listing each replayed record. The external ledger must live where a restore does not roll it back
 * (`HEOPRESS_DELETION_LEDGER_DIR` on its own volume, or the object store under `ops/deletion-ledger/`, which a
 * database-only restore leaves alone); `docs/en/operations/data-retention.md` describes the operator side.
 */

export type LedgerObjectKind = 'item' | 'ingest_snapshot';
export type LedgerAction = 'hard_delete' | 'crypto_shred' | 'tombstone';

export interface DeletionLedgerEntry {
  id: string;
  siteId: string;
  requestId: string;
  objectKind: LedgerObjectKind;
  /** The collection name of an item; null for a snapshot. */
  objectScope: string | null;
  objectId: string;
  action: LedgerAction;
  /** ISO 8601. */
  erasedAt: string;
}

/** An append-only store of ledger entries outside the database. */
export interface DeletionLedgerSink {
  readonly name: string;
  append(entries: readonly DeletionLedgerEntry[]): Promise<void>;
  readAll(): Promise<DeletionLedgerEntry[]>;
}

const KINDS = new Set<string>(['item', 'ingest_snapshot']);
const ACTIONS = new Set<string>(['hard_delete', 'crypto_shred', 'tombstone']);

/** Parse one stored entry; anything else (a torn line, a foreign object) is skipped. */
function parseEntry(raw: unknown): DeletionLedgerEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : null);
  const id = str(e.id);
  const siteId = str(e.siteId);
  const requestId = str(e.requestId);
  const objectId = str(e.objectId);
  const erasedAt = str(e.erasedAt);
  if (!id || !siteId || !requestId || !objectId || !erasedAt || Number.isNaN(Date.parse(erasedAt))) return null;
  if (typeof e.objectKind !== 'string' || !KINDS.has(e.objectKind)) return null;
  if (typeof e.action !== 'string' || !ACTIONS.has(e.action)) return null;
  return {
    id,
    siteId,
    requestId,
    objectKind: e.objectKind as LedgerObjectKind,
    objectScope: typeof e.objectScope === 'string' ? e.objectScope : null,
    objectId,
    action: e.action as LedgerAction,
    erasedAt,
  };
}

function toLine(e: DeletionLedgerEntry): string {
  const { id, siteId, requestId, objectKind, objectScope, objectId, action, erasedAt } = e;
  return JSON.stringify({ id, siteId, requestId, objectKind, objectScope, objectId, action, erasedAt });
}

/** NDJSON files, one per UTC month, appended and synced to disk. */
export function fileLedgerSink(dir: string): DeletionLedgerSink {
  return {
    name: 'file',
    async append(entries) {
      if (entries.length === 0) return;
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const byFile = new Map<string, string[]>();
      for (const e of entries) {
        const file = path.join(dir, `deletion-ledger-${e.erasedAt.slice(0, 7)}.ndjson`);
        byFile.set(file, [...(byFile.get(file) ?? []), toLine(e)]);
      }
      for (const [file, lines] of byFile) {
        const fh = await open(file, 'a', 0o600);
        try {
          await fh.appendFile(`${lines.join('\n')}\n`);
          await fh.sync();
        } finally {
          await fh.close();
        }
      }
    },
    async readAll() {
      let names: string[];
      try {
        names = (await readdir(dir)).filter((n) => /^deletion-ledger-\d{4}-\d{2}\.ndjson$/.test(n)).sort();
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const out: DeletionLedgerEntry[] = [];
      for (const n of names) {
        for (const line of (await readFile(path.join(dir, n), 'utf8')).split('\n')) {
          if (!line.trim()) continue;
          try {
            const e = parseEntry(JSON.parse(line));
            if (e) out.push(e);
          } catch {
            // A torn last line (a crash mid-append): the entry was not acknowledged, its deletion did not start.
          }
        }
      }
      return out;
    },
  };
}

const STORAGE_LEDGER_PREFIX = 'ops/deletion-ledger/';

/** One object per entry under `ops/deletion-ledger/<site>/<entry>.json` (outside every site's media prefix). */
export function storageLedgerSink(storage: StorageProvider, prefix = STORAGE_LEDGER_PREFIX): DeletionLedgerSink {
  return {
    name: 'storage',
    async append(entries) {
      for (const e of entries) {
        await storage.put(`${prefix}${e.siteId}/${e.id}.json`, Buffer.from(toLine(e)), { contentType: 'application/json' });
      }
    },
    async readAll() {
      const { keys } = await storage.list(prefix);
      const out: DeletionLedgerEntry[] = [];
      for (const key of keys.filter((k) => k.endsWith('.json')).sort()) {
        const obj = await storage.get(key);
        if (!obj) continue;
        try {
          const e = parseEntry(JSON.parse(Buffer.from(await new Response(obj.body as BodyInit).arrayBuffer()).toString('utf8')));
          if (e) out.push(e);
        } catch {
          // Not a ledger entry.
        }
      }
      return out;
    },
  };
}

/** `HEOPRESS_DELETION_LEDGER_DIR` set: files there; otherwise the object store. */
export function deletionLedgerSinkFromEnv(env: Record<string, string | undefined>, storage: StorageProvider): DeletionLedgerSink {
  const dir = env.HEOPRESS_DELETION_LEDGER_DIR?.trim();
  return dir ? fileLedgerSink(dir) : storageLedgerSink(storage);
}

/** New ledger entries for objects about to be deleted by one request (ids assigned here). */
export function ledgerEntries(
  base: { siteId: string; requestId: string; erasedAt: Date },
  objects: ReadonlyArray<{ objectKind: LedgerObjectKind; objectScope: string | null; objectId: string; action: LedgerAction }>,
): DeletionLedgerEntry[] {
  return objects.map((o) => ({ id: nanoid(), siteId: base.siteId, requestId: base.requestId, erasedAt: base.erasedAt.toISOString(), ...o }));
}

/** Write entries into the table (idempotent: an entry already there is left alone). */
export async function recordLedgerRows(db: Database, siteId: string, entries: readonly DeletionLedgerEntry[]): Promise<number> {
  const mine = entries.filter((e) => e.siteId === siteId);
  if (mine.length === 0) return 0;
  const rows = await runSiteTransaction(db, siteId, (tx) =>
    tx
      .insert(deletionLedger)
      .values(mine.map((e) => ({ ...e, erasedAt: new Date(e.erasedAt) })))
      .onConflictDoNothing()
      .returning({ id: deletionLedger.id }),
  );
  return rows.length;
}

interface LedgerReplayRecord extends DeletionLedgerEntry {
  /** `deleted_again`: the object had come back and was deleted again; `already_absent`: nothing to do; `failed`. */
  outcome: 'deleted_again' | 'already_absent' | 'failed';
  error?: string;
}

export interface DeletionLedgerReplayReport {
  startedAt: string;
  finishedAt: string;
  /** Every ledger record replayed, oldest first. */
  records: LedgerReplayRecord[];
  deletedAgain: number;
  alreadyAbsent: number;
  failed: number;
  /** Rows written back into `lumibase_deletion_ledger` (the restored table was older). */
  rowsRestored: number;
  /** Where the entries came from: the sink's name and/or `database`. */
  sources: string[];
}

async function replayOne(db: Database, storage: StorageProvider, e: DeletionLedgerEntry, now: Date): Promise<LedgerReplayRecord['outcome']> {
  if (e.objectKind === 'item') {
    const [row] = await runSiteTransaction(db, e.siteId, (tx) =>
      tx
        .select({ id: items.id, dek: items.dekWrapped })
        .from(items)
        .where(and(eq(items.siteId, e.siteId), eq(items.id, e.objectId)))
        .limit(1),
    );
    if (!row || !e.objectScope) return 'already_absent';
    const svc = itemServiceForSystem({ db, siteId: e.siteId, userId: null }, 'compliance-erasure');
    if (e.action === 'crypto_shred') {
      if (row.dek === null) return 'already_absent';
      return (await svc.cryptoShred(e.objectScope, e.objectId)) ? 'deleted_again' : 'already_absent';
    }
    return (await svc.hardDelete(e.objectScope, e.objectId)) ? 'deleted_again' : 'already_absent';
  }
  const [snap] = await runSiteTransaction(db, e.siteId, (tx) =>
    tx
      .select({ id: ingestSnapshots.id, storageKey: ingestSnapshots.storageKey, deletedAt: ingestSnapshots.contentDeletedAt })
      .from(ingestSnapshots)
      .where(and(eq(ingestSnapshots.siteId, e.siteId), eq(ingestSnapshots.id, e.objectId)))
      .limit(1),
  );
  if (!snap) return 'already_absent';
  // A restored object store may hold the bytes again even when the row still carries its tombstone.
  const stored = (await storage.get(snap.storageKey)) !== null;
  if (snap.deletedAt && !stored) return 'already_absent';
  await tombstoneSnapshot({ db, storage }, e.siteId, snap.id, 'personal_data_erasure', now);
  return 'deleted_again';
}

/**
 * Replay the deletion ledger after a restore — call it before writes open (task 5.2).
 *
 * Reads the external ledger (`sink`) and the table of every site, deletes again every recorded object that exists,
 * re-applies snapshot tombstones, writes missing table rows and returns the report (each record with its outcome). It
 * never throws for one record: a record that failed is in the report with `failed`, and the restore flow must keep
 * writes closed while `failed > 0`.
 */
export async function replayDeletionLedger(deps: {
  db: Database;
  storage: StorageProvider;
  sink?: DeletionLedgerSink | null;
  now?: () => Date;
}): Promise<DeletionLedgerReplayReport> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const all = new Map<string, DeletionLedgerEntry>();
  const sources: string[] = [];
  if (deps.sink) {
    for (const e of await deps.sink.readAll()) all.set(e.id, e);
    sources.push(deps.sink.name);
  }
  const siteRows = await deps.db.select({ id: sites.id }).from(sites).orderBy(asc(sites.id));
  const known = new Set(siteRows.map((s) => s.id));
  for (const { id: siteId } of siteRows) {
    const rows = await runSiteTransaction(deps.db, siteId, (tx) =>
      tx.select().from(deletionLedger).where(eq(deletionLedger.siteId, siteId)),
    );
    for (const r of rows) {
      if (all.has(r.id)) continue;
      const e = parseEntry({ ...r, erasedAt: r.erasedAt.toISOString() });
      if (e) all.set(e.id, e);
    }
  }
  sources.push('database');

  const ordered = [...all.values()].sort((a, b) => a.erasedAt.localeCompare(b.erasedAt) || a.id.localeCompare(b.id));
  const records: LedgerReplayRecord[] = [];
  for (const e of ordered) {
    // A site the restored database does not have holds none of its data.
    if (!known.has(e.siteId)) {
      records.push({ ...e, outcome: 'already_absent' });
      continue;
    }
    try {
      records.push({ ...e, outcome: await replayOne(deps.db, deps.storage, e, now()) });
    } catch (err) {
      records.push({ ...e, outcome: 'failed', error: err instanceof Error ? err.name : 'error' });
    }
  }
  let rowsRestored = 0;
  for (const siteId of known) {
    rowsRestored += await recordLedgerRows(deps.db, siteId, ordered.filter((e) => e.siteId === siteId));
  }
  return {
    startedAt,
    finishedAt: now().toISOString(),
    records,
    deletedAgain: records.filter((r) => r.outcome === 'deleted_again').length,
    alreadyAbsent: records.filter((r) => r.outcome === 'already_absent').length,
    failed: records.filter((r) => r.outcome === 'failed').length,
    rowsRestored,
    sources,
  };
}
