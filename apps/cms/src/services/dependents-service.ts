// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * dependents-service.ts — reverse foreign-key dependency resolution
 * (spec: docs/legacy/kiro-specs/fk-dependent-records).
 *
 * HeoPress stores item references in JSONB (`items.data->>field`), not physical
 * FK columns, so `relations.on_delete` is APPLICATION-enforced metadata. This
 * service finds records that reference a given item (the reverse of
 * ItemService's forward relation expansion) and applies batch resolutions
 * (set_null / delete / reassign). Delete delegates to ItemService so hooks /
 * search-deindex / realtime fire as usual.
 *
 * Decision (design §7): only `restrict` blocks a delete (application-level);
 * `set null` / `cascade` are NOT auto-run on soft-delete — the editor clears
 * them explicitly via resolveAction.
 */

import { and, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { appendItemEvent } from '../modules/cdc/change-feed/outbox-writer';
import { collections, fields, items, relations, scopeSite, type Database } from '@heopress/database';
import type { ItemService } from './item-service';
import { itemServiceForSystem } from './item-service-factory';
import type { PermissionAction, PermissionService } from './permission-service';
import { lockContentSettingsShared } from './site-network/content-routes';
import { lockGroupsOf, withTransactionRetry } from './site-network/translation-groups';
import { sharedFieldsOf } from './site-network/shared-fields';
import { projectedTransaction } from './site-network/public-projection';

export class DependentsError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = 'DependentsError';
  }
}

export interface DependentGroup {
  relation: string;
  collection: string; // manyCollection
  field: string; // manyField
  onDelete: string;
  count: number;
  sample: Array<{ id: string }>;
}

export interface DependentsReport {
  blocking: boolean;
  dependents: DependentGroup[];
}

export type ResolveAction = 'set_null' | 'delete' | 'reassign';

export interface DependentsServiceDeps {
  db: Database;
  siteId: string;
  userId?: string | null;
  /**
   * PermissionService bound to the calling principal. REQUIRED on request
   * paths — it is the authority for the read/update/delete gates below. When
   * omitted the service runs fail-open (system/background context, e.g. tests),
   * mirroring the explicit posture of {@link itemServiceForSystem}.
   */
  permissions?: PermissionService | null;
  /**
   * Factory for a permission-carrying ItemService bound to the same site,
   * rebindable to a tx handle (for delete delegation). On request paths this
   * MUST be `(db) => itemServiceForRequest(c, { db })` so the delegated
   * soft/hard-delete enforces the caller's per-item RBAC — never
   * `itemServiceForSystem`, which would bypass it.
   */
  itemServiceFactory?: (db: Database) => ItemService;
}

const SAMPLE_LIMIT = 10;

export class DependentsService {
  constructor(private readonly deps: DependentsServiceDeps) {}

  private itemService(db: Database = this.deps.db): ItemService {
    if (this.deps.itemServiceFactory) return this.deps.itemServiceFactory(db);
    // No factory → system/background context (no request principal). Delete
    // delegation runs fail-open by design; request paths inject a
    // permission-carrying factory (see DependentsServiceDeps.itemServiceFactory).
    return itemServiceForSystem(
      { db, siteId: this.deps.siteId, userId: this.deps.userId ?? null },
      'background-worker',
    );
  }

  /**
   * Enforce that the calling principal may perform `action` on `collection`.
   * Returns the compiled permission (for row-level `whereFor` scoping) or
   * `null` when running system/fail-open (no PermissionService injected).
   * Throws `FORBIDDEN` (403) when a principal is present but lacks the grant.
   */
  private async requirePerm(collection: string, action: PermissionAction) {
    const permissions = this.deps.permissions;
    if (!permissions) return null; // system/background: fail-open by design.
    const perm = await permissions.canAccess(collection, action);
    if (!perm) {
      throw new DependentsError('FORBIDDEN', `Action "${action}" on "${collection}" is not allowed.`, 403);
    }
    return perm;
  }

  /**
   * Row-level read scope for the dependent sample. `allowed=false` means the
   * principal has no read grant on `collection` at all (hide specific ids);
   * `where` narrows the sample to the rows the principal may read. Counts stay
   * unfiltered — blocking detection is an integrity concern (a `restrict`
   * child the caller cannot see must still block the parent delete).
   */
  private async readScope(collection: string): Promise<{ allowed: boolean; where: SQL | undefined }> {
    const permissions = this.deps.permissions;
    if (!permissions) return { allowed: true, where: undefined };
    const perm = await permissions.canAccess(collection, 'read');
    if (!perm) return { allowed: false, where: undefined };
    return { allowed: true, where: permissions.whereFor(perm) };
  }

  private async collectionIdByName(name: string): Promise<string | null> {
    const [row] = await this.deps.db
      .select({ id: collections.id })
      .from(collections)
      .where(and(scopeSite(collections.siteId, this.deps.siteId), eq(collections.name, name)))
      .limit(1);
    return row?.id ?? null;
  }

  /** Find records that reference `(collection, itemId)`. Only groups with count>0. */
  async resolveDependents(collection: string, itemId: string, limit = SAMPLE_LIMIT): Promise<DependentGroup[]> {
    // Relations where this collection is the "one" side (others point at it).
    const rels = await this.deps.db
      .select()
      .from(relations)
      .where(and(scopeSite(relations.siteId, this.deps.siteId), eq(relations.oneCollection, collection)));

    const groups: DependentGroup[] = [];
    for (const rel of rels) {
      const manyCollectionId = await this.collectionIdByName(rel.manyCollection);
      if (!manyCollectionId) continue;

      const whereRef = and(
        scopeSite(items.siteId, this.deps.siteId),
        eq(items.collectionId, manyCollectionId),
        isNull(items.deletedAt),
        sql`${items.data}->>${sql.raw(`'${escapeIdent(rel.manyField)}'`)} = ${itemId}`,
      );

      const countRows = await this.deps.db
        .select({ count: sql<number>`count(*)::int` })
        .from(items)
        .where(whereRef);
      const count = countRows[0]?.count ?? 0;
      if (count === 0) continue;

      // Count is unfiltered (integrity), but the sample ids are only revealed
      // to a principal that may read the dependent collection, scoped to its
      // row-level read grant.
      const scope = await this.readScope(rel.manyCollection);
      const sample = scope.allowed
        ? await this.deps.db
            .select({ id: items.id })
            .from(items)
            .where(scope.where ? and(whereRef, scope.where) : whereRef)
            .limit(limit)
        : [];

      groups.push({
        relation: rel.id,
        collection: rel.manyCollection,
        field: rel.manyField,
        onDelete: rel.onDelete,
        count,
        sample,
      });
    }
    return groups;
  }

  /** A delete is blocked iff a `restrict` relation has dependents. */
  isBlocking(groups: DependentGroup[]): boolean {
    return groups.some((g) => g.count > 0 && g.onDelete === 'restrict');
  }

  /**
   * Convenience: report for an item (groups + blocking).
   *
   * `requireTarget` gates the caller against the *target* collection before any
   * dependent data is returned — preflight passes `'read'`, the delete guard
   * passes `'delete'` — so a principal never sees dependent counts/ids for an
   * item it may not read or delete.
   */
  async report(
    collection: string,
    itemId: string,
    opts: { limit?: number; requireTarget?: PermissionAction } = {},
  ): Promise<DependentsReport> {
    if (opts.requireTarget) await this.requirePerm(collection, opts.requireTarget);
    const dependents = await this.resolveDependents(collection, itemId, opts.limit ?? SAMPLE_LIMIT);
    return { dependents, blocking: this.isBlocking(dependents) };
  }

  /**
   * Batch-resolve one relation's dependents. Transactional; delete delegates to
   * ItemService.softDelete (or hardDelete when `hard`). Returns affected count.
   */
  async applyResolution(
    targetCollection: string,
    itemId: string,
    action: ResolveAction,
    relationId: string,
    opts: { newTargetId?: string; hard?: boolean } = {},
  ): Promise<{ action: ResolveAction; relation: string; affected: number; policyOverridden: boolean }> {
    const [rel] = await this.deps.db
      .select()
      .from(relations)
      .where(and(scopeSite(relations.siteId, this.deps.siteId), eq(relations.id, relationId)))
      .limit(1);
    if (!rel || rel.oneCollection !== targetCollection) {
      throw new DependentsError('RELATION_NOT_FOUND', 'Relation not found for this item.', 404);
    }
    const manyCollectionId = await this.collectionIdByName(rel.manyCollection);
    if (!manyCollectionId) throw new DependentsError('RELATION_NOT_FOUND', 'Dependent collection not found.', 404);

    // Permission gate on the dependent (many) collection, per action. `delete`
    // is additionally re-checked per item by the delegated ItemService; the
    // gate here fails fast and also covers the raw set_null/reassign writes
    // that bypass ItemService. `updatePerm` carries the row-level scope so a
    // row-restricted principal can only mutate rows it is allowed to update.
    const requiredAction: PermissionAction = action === 'delete' ? 'delete' : 'update';
    const grant = await this.requirePerm(rel.manyCollection, requiredAction);
    const rowScope = action === 'delete' ? undefined : this.deps.permissions?.whereFor(grant);

    // Guards.
    if (action === 'set_null') {
      const [f] = await this.deps.db
        .select({ required: fields.required })
        .from(fields)
        .where(and(scopeSite(fields.siteId, this.deps.siteId), eq(fields.collectionId, manyCollectionId), eq(fields.name, rel.manyField)))
        .limit(1);
      if (f?.required) {
        throw new DependentsError('FIELD_REQUIRED', `Field "${rel.manyField}" is required; cannot set it null.`, 409);
      }
    }
    if (action === 'reassign') {
      const target = opts.newTargetId;
      if (!target || target === itemId) {
        throw new DependentsError('INVALID_TARGET', 'A distinct newTargetId is required for reassign.', 422);
      }
      const oneCollectionId = await this.collectionIdByName(rel.oneCollection);
      const [exists] = await this.deps.db
        .select({ id: items.id })
        .from(items)
        .where(and(scopeSite(items.siteId, this.deps.siteId), eq(items.collectionId, oneCollectionId ?? '__none__'), eq(items.id, target), isNull(items.deletedAt)))
        .limit(1);
      if (!exists) throw new DependentsError('INVALID_TARGET', 'Reassign target does not exist.', 422);
    }

    // Collect the dependent ids (in the request db, before the tx). Row-level
    // update scope is folded in for set_null/reassign so a restricted principal
    // only ever touches rows within its grant; delete rows are re-checked
    // per item by the delegated ItemService.
    const whereRef = and(
      scopeSite(items.siteId, this.deps.siteId),
      eq(items.collectionId, manyCollectionId),
      isNull(items.deletedAt),
      sql`${items.data}->>${sql.raw(`'${escapeIdent(rel.manyField)}'`)} = ${itemId}`,
      ...(rowScope ? [rowScope] : []),
    );
    const dependentIds = (await this.deps.db.select({ id: items.id }).from(items).where(whereRef)).map((r) => r.id);

    const db = this.deps.db as Database & { transaction?: <T>(cb: (tx: Database) => Promise<T>) => Promise<T> };
    let affected = 0;
    const run = async (tx: Database) => {
      if (action === 'set_null' || action === 'reassign') {
        const value = action === 'reassign' ? opts.newTargetId! : null;
        if (dependentIds.length === 0) return;
        // Only the dependents enumerated (and checked below): a row that starts to match meanwhile is not
        // this resolution's — and it would not have been through the shared-field check (P05).
        const enumerated = and(whereRef, inArray(items.id, [...dependentIds]));
        // A shared field of a translation group (P05, design D) changes only through the item's own write
        // (the source's sync, the translations' refusal): not in bulk here. Locks as for any group write.
        const [many] = await tx.select({ meta: collections.meta }).from(collections).where(eq(collections.id, manyCollectionId));
        // The site's settings row before the item rows, for every resolution (the order of site and collection deletions; P07).
        await lockContentSettingsShared(tx as never, this.deps.siteId);
        if (sharedFieldsOf(many?.meta).includes(rel.manyField)) {
          const grouped = await lockGroupsOf(tx as never, this.deps.siteId, [...dependentIds]);
          if (grouped.size > 0) {
            throw new DependentsError(
              'SHARED_FIELD_IN_GROUP',
              `"${rel.manyField}" is a shared field of a translation group (item ${[...grouped.keys()][0]}); change it in the group's source item instead.`,
              409,
            );
          }
        }
        // jsonb_set on each dependent's manyField.
        // The publish guard (P04): changing a held item's live content would
        // publish a change. Refuse the whole resolution rather than skip rows.
        const held = await tx
          .select({ id: items.id })
          .from(items)
          .where(and(enumerated, eq(items.hold, true), eq(items.status, 'published')))
          .limit(1);
        if (held.length > 0) {
          throw new DependentsError(
            'ITEM_HELD',
            `A dependent item (${held[0]!.id}) is published and on hold; release the hold or unpublish it first.`,
            409,
          );
        }
        const res = await tx
          .update(items)
          .set({
            data: sql`jsonb_set(${items.data}, ${sql.raw(`'{${escapeIdent(rel.manyField)}}'`)}, ${value === null ? sql`'null'::jsonb` : sql`to_jsonb(${value}::text)`}, true)`,
            updatedAt: new Date(),
            version: sql`${items.version} + 1`,
          })
          // A hold set after the check above still wins.
          .where(and(enumerated, sql`NOT (${items.hold} AND ${items.status} = 'published')`))
          .returning({ id: items.id, version: items.version });
        affected = res.length;
        // Each changed item's event, in the same transaction (P04).
        for (const r of res) {
          await appendItemEvent(tx, {
            siteId: this.deps.siteId,
            collection: rel.manyCollection,
            itemId: r.id,
            itemVersion: r.version,
            changedFields: [rel.manyField],
            actor: this.deps.userId ? { type: 'user', id: this.deps.userId } : { type: 'system' },
            source: this.deps.userId ? 'api' : 'system',
          });
        }
      } else {
        // delete: delegate per-item so hooks/deindex fire; bind ItemService to tx.
        const svc = this.itemService(tx);
        // Settings, then every translation group involved in ID order, before the first delete (P05, design §0):
        // the per-item deletes then never take groups in an order another such transaction reverses.
        await lockContentSettingsShared(tx as never, this.deps.siteId);
        await lockGroupsOf(tx as never, this.deps.siteId, [...dependentIds]);
        for (const depId of dependentIds) {
          if (opts.hard) await svc.hardDelete(rel.manyCollection, depId);
          else await svc.softDelete(rel.manyCollection, depId);
          affected++;
        }
      }
    };
    // A translation group joined meanwhile by an item being deleted starts the whole transaction over (P05, R44).
    if (typeof db.transaction === 'function') await withTransactionRetry(db, () => projectedTransaction(db, run));
    else await run(this.deps.db);

    const defaultForOnDelete: Record<string, ResolveAction | undefined> = {
      'set null': 'set_null',
      cascade: 'delete',
      restrict: undefined,
      'no action': undefined,
    };
    const policyOverridden = defaultForOnDelete[rel.onDelete] !== action;

    return { action, relation: relationId, affected, policyOverridden };
  }
}

/** Reject identifiers that could break out of the quoted JSON path. */
function escapeIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new DependentsError('INVALID_FIELD', `Unsafe field name "${name}".`, 400);
  }
  return name;
}
