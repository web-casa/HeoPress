// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  collections,
  erasureRequests,
  ingestSnapshots,
  items,
  settings,
  scopeSite,
  type Database,
} from '@heopress/database';
import type { StorageProvider } from '@heopress/runtime';
import { AuditLogger } from '../modules/audit/logger';
import { itemServiceForSystem } from './item-service-factory';
import { dispatchRevalidation, parseTargets } from './revalidation';
import { ledgerEntries, recordLedgerRows, type DeletionLedgerEntry, type DeletionLedgerSink } from './retention/deletion-ledger';
import { eraseSnapshots } from './retention/snapshot-retention';

/**
 * GDPR erasure & crypto-shredding (regulated-content-readiness Req 11).
 *
 * Manages the Erasure_Request lifecycle (pending → confirmed → executing →
 * completed | failed) with optional dual-control, executes hard-delete (or
 * crypto-shred) over a subject scope, and records a tamper-evident
 * `data_erased` audit entry that is never cascade-deleted (Req 11.3).
 *
 * HeoPress P13 (tasks 5.1, 5.2; spec ops/data-retention): a request may instead name raw fetch snapshots that hold
 * personal data (`{ ingestSnapshots: [...] }`) — erased whatever still references them. Every object a request deletes
 * is written to the deletion ledger: the external ledger before the deletion, the ledger table after it, so a restore
 * from an older backup deletes it again (`retention/deletion-ledger.ts`).
 */

export class ErasureError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'ErasureError';
  }
}

export type ErasureAction = 'hard_delete' | 'crypto_shred';

interface ItemErasureScope {
  collection: string;
  /** Equality filter matched against item JSONB data (subject identifier). */
  filter: Record<string, unknown>;
}

/** Raw fetch snapshots that hold the subject's personal data (HeoPress P13 task 5.1). */
export interface SnapshotErasureScope {
  ingestSnapshots: string[];
}

export type ErasureScope = ItemErasureScope | SnapshotErasureScope;

const isSnapshotScope = (scope: ErasureScope): scope is SnapshotErasureScope =>
  Array.isArray((scope as SnapshotErasureScope).ingestSnapshots);

export interface ErasureServiceDeps {
  db: Database;
  siteId: string;
  userId?: string | null;
  actorEmail?: string | null;
  /** Where snapshot objects live (needed for snapshot scopes). */
  storage?: StorageProvider;
  /** The external deletion ledger (HeoPress P13 task 5.2); without one only the ledger table is written. */
  ledger?: DeletionLedgerSink | null;
  now?: () => Date;
}

/** Stable sha256 hex of the subject identifier — never store plaintext (Req 11.3). */
async function hashSubject(scope: ErasureScope): Promise<string> {
  const canonical = isSnapshotScope(scope)
    ? JSON.stringify({ ingestSnapshots: [...scope.ingestSnapshots].sort() })
    : JSON.stringify({ collection: scope.collection, filter: scope.filter });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class ErasureService {
  constructor(private readonly deps: ErasureServiceDeps) {}

  private itemService() {
    // System context: erasure/SAR is gated by admin access + optional
    // dual-control at this service layer, so the ItemService runs with system
    // privileges to reach records the requesting admin may not own row-wise.
    return itemServiceForSystem(
      { db: this.deps.db, siteId: this.deps.siteId, userId: this.deps.userId ?? null },
      'compliance-erasure',
    );
  }

  private async dualControlEnabled(): Promise<boolean> {
    const [row] = await this.deps.db
      .select()
      .from(settings)
      .where(and(eq(settings.siteId, this.deps.siteId), eq(settings.key, 'erasureDualControl')));
    return row?.value === true || (row?.value as { enabled?: boolean })?.enabled === true;
  }

  /** Create a pending Erasure_Request (Req 11.1). */
  async create(scope: ErasureScope, reason?: string) {
    if (scope && isSnapshotScope(scope)) {
      if (scope.ingestSnapshots.length === 0 || scope.ingestSnapshots.some((id) => typeof id !== 'string' || id.length === 0)) {
        throw new ErasureError('INVALID_SCOPE', 'Scope requires at least one snapshot id.', 422);
      }
    } else if (!scope?.collection || !scope.filter || Object.keys(scope.filter).length === 0) {
      throw new ErasureError('INVALID_SCOPE', 'Scope requires a collection and a non-empty filter.', 422);
    }
    const subjectHash = await hashSubject(scope);
    const [row] = await this.deps.db
      .insert(erasureRequests)
      .values({
        siteId: this.deps.siteId,
        scope,
        subjectHash,
        reason: reason ?? null,
        requestedBy: this.deps.userId ?? null,
        status: 'pending',
      })
      .returning();
    return row;
  }

  private async load(id: string) {
    const [row] = await this.deps.db
      .select()
      .from(erasureRequests)
      .where(and(scopeSite(erasureRequests.siteId, this.deps.siteId), eq(erasureRequests.id, id)))
      .limit(1);
    if (!row) throw new ErasureError('NOT_FOUND', `Erasure request "${id}" not found.`, 404);
    return row;
  }

  /** Confirm a pending request; enforces a second admin under dual-control (Req 11.4). */
  async confirm(id: string) {
    const req = await this.load(id);
    if (req.status !== 'pending') {
      throw new ErasureError('INVALID_STATE', `Cannot confirm a request in "${req.status}".`, 409);
    }
    if (await this.dualControlEnabled()) {
      if (req.requestedBy && this.deps.userId && req.requestedBy === this.deps.userId) {
        throw new ErasureError(
          'DUAL_CONTROL_REQUIRED',
          'A second admin must confirm this erasure.',
          409,
        );
      }
    }
    const [row] = await this.deps.db
      .update(erasureRequests)
      .set({ status: 'confirmed', confirmedBy: this.deps.userId ?? null })
      .where(eq(erasureRequests.id, id))
      .returning();
    return row;
  }

  /**
   * Execute a confirmed request: hard-delete (or crypto-shred) every item in
   * scope, record the count + tamper-evident audit, and revalidate (Req 11.2,
   * 11.3, 11.5).
   */
  async execute(id: string, action: ErasureAction = 'hard_delete') {
    const req = await this.load(id);
    if (req.status !== 'confirmed') {
      throw new ErasureError('INVALID_STATE', `Request must be confirmed before execution (is "${req.status}").`, 409);
    }
    await this.deps.db
      .update(erasureRequests)
      .set({ status: 'executing' })
      .where(eq(erasureRequests.id, id));

    try {
      const scope = req.scope as ErasureScope;
      if (isSnapshotScope(scope)) return await this.executeSnapshots(id, req.subjectHash, scope);
      const [coll] = await this.deps.db
        .select({ id: collections.id, name: collections.name })
        .from(collections)
        .where(and(scopeSite(collections.siteId, this.deps.siteId), eq(collections.name, scope.collection)))
        .limit(1);
      if (!coll) throw new ErasureError('NOT_FOUND', `Collection "${scope.collection}" not found.`, 404);

      // Match subject rows by JSONB containment on item data.
      const matches = await this.deps.db
        .select({ id: items.id })
        .from(items)
        .where(
          and(
            scopeSite(items.siteId, this.deps.siteId),
            eq(items.collectionId, coll.id),
            sql`${items.data} @> ${JSON.stringify(scope.filter)}::jsonb`,
          ),
        );

      // The ledger first (HeoPress P13 task 5.2): a crash after it leaves a record whose replay is harmless.
      const entries = await this.ledgerFirst(
        id,
        matches.map((m) => ({ objectKind: 'item' as const, objectScope: scope.collection, objectId: m.id, action })),
      );
      const svc = this.itemService();
      let count = 0;
      const done: DeletionLedgerEntry[] = [];
      for (const [i, m] of matches.entries()) {
        const ok = action === 'crypto_shred'
          ? await svc.cryptoShred(scope.collection, m.id)
          : await svc.hardDelete(scope.collection, m.id);
        if (ok) {
          count += 1;
          done.push(entries[i]!);
        }
      }
      await recordLedgerRows(this.deps.db, this.deps.siteId, done);

      // Tamper-evident proof — scope + count + subject hash, no plaintext (Req 11.3).
      await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
        event: 'data_erased',
        actorEmail: this.deps.actorEmail ?? null,
        requestId: null,
        metadata: {
          siteId: this.deps.siteId,
          collection: scope.collection,
          action,
          recordCount: count,
          subjectHash: req.subjectHash,
          requestId: id,
        },
      });

      await this.revalidate(coll.name);

      const [row] = await this.deps.db
        .update(erasureRequests)
        .set({ status: 'completed', recordCount: count, completedAt: new Date() })
        .where(eq(erasureRequests.id, id))
        .returning();
      return row;
    } catch (err) {
      await this.deps.db
        .update(erasureRequests)
        .set({ status: 'failed', completedAt: new Date() })
        .where(eq(erasureRequests.id, id));
      throw err;
    }
  }

  private async ledgerFirst(
    requestId: string,
    objects: Parameters<typeof ledgerEntries>[1],
  ): Promise<DeletionLedgerEntry[]> {
    const entries = ledgerEntries({ siteId: this.deps.siteId, requestId, erasedAt: this.deps.now?.() ?? new Date() }, objects);
    if (this.deps.ledger) await this.deps.ledger.append(entries);
    return entries;
  }

  /** Erase raw fetch snapshots: no reference keeps them (spec ops/data-retention "个人数据删除请求"). */
  private async executeSnapshots(id: string, subjectHash: string | null, scope: SnapshotErasureScope) {
    if (!this.deps.storage) throw new ErasureError('STORAGE_UNAVAILABLE', 'Snapshot erasure needs the object store.', 500);
    const requested = [...new Set(scope.ingestSnapshots)];
    const present = await this.deps.db
      .select({ id: ingestSnapshots.id })
      .from(ingestSnapshots)
      .where(and(scopeSite(ingestSnapshots.siteId, this.deps.siteId), inArray(ingestSnapshots.id, requested)));
    const entries = await this.ledgerFirst(
      id,
      present.map((p) => ({ objectKind: 'ingest_snapshot' as const, objectScope: null, objectId: p.id, action: 'tombstone' as const })),
    );
    const now = this.deps.now?.() ?? new Date();
    const result = await eraseSnapshots({ db: this.deps.db, storage: this.deps.storage }, this.deps.siteId, present.map((p) => p.id), now);
    await recordLedgerRows(this.deps.db, this.deps.siteId, entries.filter((e) => result.erased.includes(e.objectId)));
    await new AuditLogger({ db: this.deps.db, siteId: this.deps.siteId }).write({
      event: 'data_erased',
      actorEmail: this.deps.actorEmail ?? null,
      requestId: null,
      metadata: {
        siteId: this.deps.siteId,
        objectKind: 'ingest_snapshot',
        action: 'tombstone',
        recordCount: result.erased.length,
        sentToReview: result.sentToReview.length,
        subjectHash,
        requestId: id,
      },
    });
    const [row] = await this.deps.db
      .update(erasureRequests)
      .set({ status: 'completed', recordCount: result.erased.length, completedAt: new Date() })
      .where(eq(erasureRequests.id, id))
      .returning();
    return row;
  }

  private async revalidate(collectionName: string): Promise<void> {
    try {
      const [row] = await this.deps.db
        .select()
        .from(settings)
        .where(and(eq(settings.siteId, this.deps.siteId), eq(settings.key, 'revalidation.targets')));
      const targets = parseTargets(row?.value);
      if (targets.length > 0) await dispatchRevalidation(targets, [collectionName]);
    } catch {
      // best-effort
    }
  }
}
