// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Content version service — named, parallel draft branches over an item.
 *
 * Versions live in `content_versions`, separate from the linear `revisions`
 * history. Creating a version snapshots the live item data; promoting applies
 * a version's data to main via ItemService.patch (so a revision is written and
 * caches invalidate), then removes the version. The `hash` captured at snapshot
 * time lets the caller detect that main has diverged before promoting.
 *
 * See `docs/legacy/kiro-specs/content-versioning`.
 */

import { collections, contentVersions, fields, items, scopeSite } from '@heopress/database';
import { appendItemEvent } from '../modules/cdc/change-feed/outbox-writer';
import type { Database } from '@heopress/database';
import { type Change, diffFields } from '@heopress/contracts';
import { and, eq } from 'drizzle-orm';
import { assignBlockIds, blockFieldsOf, type BlockFieldKind } from './block-ids';
import { diffData, threeWayMerge, type FieldChange, type MergeConflict, type Resolutions } from './branches/branch-merge';
import { rebuildRetranslationMaps } from './pipeline/retranslation-promotion';

export class ContentVersionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    /** Structured detail for the caller (P10: the conflict list of a failed merge, the current versions). */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ContentVersionError';
  }
}

/** Stable order-independent hash of a data object (divergence detection only). */
export function hashData(data: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortKeys(data));
  // FNV-1a 32-bit — cheap, deterministic, runtime-agnostic (no crypto needed).
  let h = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export interface VersionRow {
  id: string;
  siteId: string;
  itemId: string;
  collectionId: string;
  key: string;
  name: string;
  data: Record<string, unknown>;
  hash: string;
  baseData: Record<string, unknown> | null;
  baseVersion: number | null;
  revision: number;
  state: string;
  mergedAt: Date | null;
  mergedBy: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Minimal item access the version service needs — satisfied by ItemService. */
export interface ItemAccess {
  detail(collection: string, id: string): Promise<{ data: Record<string, unknown> } | Record<string, unknown>>;
  patch(
    collection: string,
    id: string,
    patch: { data: Record<string, unknown>; expectedVersion: number | undefined; reason?: string },
  ): Promise<unknown>;
}

interface Deps {
  db: Database;
  siteId: string;
  userId: string | null;
  items: ItemAccess;
}

export class ContentVersionService {
  constructor(private readonly deps: Deps) {}

  private async collectionId(name: string): Promise<string> {
    const [row] = await this.deps.db
      .select({ id: collections.id })
      .from(collections)
      .where(and(scopeSite(collections.siteId, this.deps.siteId), eq(collections.name, name)))
      .limit(1);
    if (!row) throw new ContentVersionError('INVALID_COLLECTION', `Collection "${name}" not found.`, 404);
    return row.id;
  }


  private async mainItem(collection: string, itemId: string): Promise<{ data: Record<string, unknown>; version: number }> {
    const detail = (await this.deps.items.detail(collection, itemId)) as Record<string, unknown>;
    return { data: (detail.data ?? {}) as Record<string, unknown>, version: typeof detail.version === 'number' ? detail.version : 0 };
  }

  private async mainData(collection: string, itemId: string): Promise<Record<string, unknown>> {
    return (await this.mainItem(collection, itemId)).data;
  }

  /** The collection's block fields (rich text, repeaters): they diff and merge block by block (P10). */
  private async blockFields(collId: string): Promise<Map<string, BlockFieldKind>> {
    const rows = await this.deps.db.select({ name: fields.name, interface: fields.interface }).from(fields).where(and(scopeSite(fields.siteId, this.deps.siteId), eq(fields.collectionId, collId)));
    return blockFieldsOf(rows);
  }

  async list(collection: string, itemId: string): Promise<(VersionRow & { mainChanged: boolean })[]> {
    const collId = await this.collectionId(collection);
    const rows = (await this.deps.db
      .select()
      .from(contentVersions)
      .where(
        and(
          scopeSite(contentVersions.siteId, this.deps.siteId),
          eq(contentVersions.collectionId, collId),
          eq(contentVersions.itemId, itemId),
        ),
      )) as VersionRow[];
    const mainHash = hashData(await this.mainData(collection, itemId));
    return rows.map((r) => ({ ...r, mainChanged: r.hash !== mainHash }));
  }

  async get(collection: string, itemId: string, key: string): Promise<VersionRow | null> {
    const collId = await this.collectionId(collection);
    const [row] = await this.deps.db
      .select()
      .from(contentVersions)
      .where(
        and(
          scopeSite(contentVersions.siteId, this.deps.siteId),
          eq(contentVersions.collectionId, collId),
          eq(contentVersions.itemId, itemId),
          eq(contentVersions.key, key),
        ),
      )
      .limit(1);
    return (row as VersionRow) ?? null;
  }

  /** The version's change event (`versions.*`), in the caller's transaction. */
  private event(
    tx: Pick<Database, 'insert'>,
    collection: string,
    itemId: string,
    key: string,
    operation: 'create' | 'update' | 'delete',
  ): Promise<void> {
    return appendItemEvent(tx, {
      siteId: this.deps.siteId,
      resource: 'content_version',
      operation,
      collection,
      itemId,
      itemVersion: null,
      changedFields: [key],
      actor: this.deps.userId ? { type: 'user', id: this.deps.userId } : { type: 'system' },
      source: this.deps.userId ? 'api' : 'system',
    });
  }

  async create(collection: string, itemId: string, key: string, name: string): Promise<VersionRow> {
    const collId = await this.collectionId(collection);
    const existing = await this.get(collection, itemId, key);
    if (existing) throw new ContentVersionError('VERSION_EXISTS', `Version "${key}" already exists.`, 409);
    const main = await this.mainItem(collection, itemId);
    const data = main.data;
    // The version and its change event commit together (HeoPress P04). P10: main as branched is the merge base.
    const row = await this.deps.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(contentVersions)
        .values({
          siteId: this.deps.siteId,
          itemId,
          collectionId: collId,
          key,
          name,
          data,
          hash: hashData(data),
          baseData: data,
          baseVersion: main.version,
          createdBy: this.deps.userId,
        })
        .returning();
      await this.event(tx, collection, itemId, key, 'create');
      return created;
    });
    return row as VersionRow;
  }

  /**
   * Change a branch. `data` replaces its data, `set` changes some fields over it (P10, the agent tool); with
   * `expectedRevision` a stale write is refused (409 BRANCH_STALE). New blocks get their ids. A merged branch that
   * is edited again is open again.
   */
  async update(
    collection: string,
    itemId: string,
    key: string,
    patch: { data?: Record<string, unknown>; set?: Record<string, unknown>; name?: string; expectedRevision?: number },
  ): Promise<VersionRow> {
    const collId = await this.collectionId(collection);
    const blockFields = patch.data !== undefined || patch.set !== undefined ? await this.blockFields(collId) : new Map<string, BlockFieldKind>();
    const where = and(
      scopeSite(contentVersions.siteId, this.deps.siteId),
      eq(contentVersions.collectionId, collId),
      eq(contentVersions.itemId, itemId),
      eq(contentVersions.key, key),
    );
    const row = await this.deps.db.transaction(async (tx) => {
      const [current] = (await tx.select().from(contentVersions).where(where).for('update')) as VersionRow[];
      if (!current) return null;
      if (patch.expectedRevision !== undefined && patch.expectedRevision !== current.revision) {
        throw new ContentVersionError('BRANCH_STALE', 'The branch changed since you read it: read it again.', 409, { currentRevision: current.revision });
      }
      const set: Record<string, unknown> = { updatedAt: new Date(), revision: current.revision + 1 };
      if (patch.data !== undefined || patch.set !== undefined) {
        const next = patch.data ?? { ...current.data, ...patch.set };
        set.data = assignBlockIds(next, blockFields);
        set.state = 'open';
      }
      if (patch.name !== undefined) set.name = patch.name;
      const [updated] = await tx.update(contentVersions).set(set).where(where).returning();
      await this.event(tx, collection, itemId, key, 'update');
      return updated;
    });
    if (!row) throw new ContentVersionError('NOT_FOUND', `Version "${key}" not found.`, 404);
    return row as VersionRow;
  }

  async remove(collection: string, itemId: string, key: string): Promise<void> {
    const collId = await this.collectionId(collection);
    const deleted = await this.deps.db.transaction(async (tx) => {
      const rows = await tx
        .delete(contentVersions)
        .where(
          and(
            scopeSite(contentVersions.siteId, this.deps.siteId),
            eq(contentVersions.collectionId, collId),
            eq(contentVersions.itemId, itemId),
            eq(contentVersions.key, key),
          ),
        )
        .returning({ id: contentVersions.id });
      if (rows.length > 0) await this.event(tx, collection, itemId, key, 'delete');
      return rows;
    });
    if (deleted.length === 0) throw new ContentVersionError('NOT_FOUND', `Version "${key}" not found.`, 404);
  }

  async compare(
    collection: string,
    itemId: string,
    key: string,
  ): Promise<{ main: Record<string, unknown>; version: Record<string, unknown>; changes: Change[] }> {
    const version = await this.get(collection, itemId, key);
    if (!version) throw new ContentVersionError('NOT_FOUND', `Version "${key}" not found.`, 404);
    const main = await this.mainData(collection, itemId);
    return { main, version: version.data, changes: diffFields(main, version.data) };
  }

  /**
   * Field- and block-level diff (P10 task 4.1): what the branch changed and what main changed since the branch's
   * base, and what a merge would do now — the conflicts a person must decide, with the versions to merge against.
   */
  async diff(collection: string, itemId: string, key: string): Promise<BranchDiff> {
    const collId = await this.collectionId(collection);
    const version = await this.get(collection, itemId, key);
    if (!version) throw new ContentVersionError('NOT_FOUND', `Version "${key}" not found.`, 404);
    const main = await this.mainItem(collection, itemId);
    const blockFields = await this.blockFields(collId);
    const base = version.baseData ?? main.data;
    const outcome = threeWayMerge(base, main.data, version.data, blockFields);
    return {
      key: version.key,
      name: version.name,
      state: version.state,
      revision: version.revision,
      baseVersion: version.baseVersion,
      mainVersion: main.version,
      mainChanged: version.baseData ? version.baseVersion !== main.version : version.hash !== hashData(main.data),
      branch: diffData(base, version.data, blockFields),
      main: version.baseData ? diffData(base, main.data, blockFields) : [],
      merge: { clean: outcome.conflicts.length === 0, conflicts: outcome.conflicts, fromBranch: outcome.fromBranch, fromMain: outcome.fromMain },
    };
  }

  /**
   * Merge a branch with main (P10 tasks 4.3, 4.4). Atomic over both versions: main must still be
   * `expectedMainVersion` and the branch `expectedRevision` while both rows are locked — a change after the
   * comparison is a conflict (409 MERGE_STALE), never overwritten. Same field/block changed on both sides: 409
   * MERGE_CONFLICT with the list, unless `resolutions` chose a side for each. The result is **not** written to the
   * item: it becomes the branch's pending revision (`state: merged`, based on main as merged against), which a person
   * promotes through the item write path — version check, Hold and the publish checks apply there.
   */
  async merge(
    collection: string,
    itemId: string,
    key: string,
    input: { expectedMainVersion: number; expectedRevision: number; resolutions?: Resolutions },
  ): Promise<{ branch: VersionRow; conflictsResolved: number; promote: { expectedVersion: number } }> {
    const collId = await this.collectionId(collection);
    const main = await this.mainItem(collection, itemId);
    const stale = (what: string, details: Record<string, unknown>) =>
      new ContentVersionError('MERGE_STALE', `${what} changed since the comparison: compare again before merging.`, 409, details);
    if (main.version !== input.expectedMainVersion) throw stale('Main', { mainVersion: main.version });
    const blockFields = await this.blockFields(collId);
    const where = and(
      scopeSite(contentVersions.siteId, this.deps.siteId),
      eq(contentVersions.collectionId, collId),
      eq(contentVersions.itemId, itemId),
      eq(contentVersions.key, key),
    );
    const result = await this.deps.db.transaction(async (tx) => {
      // Both versions are checked under lock: a concurrent write to main waits for this, or this sees its version.
      const [item] = await tx
        .select({ version: items.version })
        .from(items)
        .where(and(eq(items.siteId, this.deps.siteId), eq(items.id, itemId), eq(items.collectionId, collId)))
        .for('update');
      if (!item) throw new ContentVersionError('NOT_FOUND', 'Item not found.', 404);
      if (item.version !== input.expectedMainVersion) throw stale('Main', { mainVersion: item.version });
      const [branch] = (await tx.select().from(contentVersions).where(where).for('update')) as VersionRow[];
      if (!branch) throw new ContentVersionError('NOT_FOUND', `Version "${key}" not found.`, 404);
      if (branch.revision !== input.expectedRevision) throw stale('The branch', { revision: branch.revision });
      const outcome = threeWayMerge(branch.baseData ?? main.data, main.data, branch.data, blockFields, input.resolutions ?? {});
      if (outcome.unresolved.length) {
        throw new ContentVersionError('MERGE_CONFLICT', 'Main and the branch changed the same content: choose a side for each conflict.', 409, {
          conflicts: outcome.unresolved,
          mainVersion: main.version,
          revision: branch.revision,
        });
      }
      const [updated] = await tx
        .update(contentVersions)
        .set({
          data: outcome.data,
          baseData: main.data,
          baseVersion: main.version,
          hash: hashData(main.data),
          state: 'merged',
          revision: branch.revision + 1,
          mergedAt: new Date(),
          mergedBy: this.deps.userId,
          updatedAt: new Date(),
        })
        .where(where)
        .returning();
      await this.event(tx, collection, itemId, key, 'update');
      return { branch: updated as VersionRow, conflictsResolved: outcome.conflicts.length };
    });
    return { ...result, promote: { expectedVersion: main.version } };
  }

  /**
   * Apply a version's data to main via ItemService.patch (writes a revision + invalidates caches + runs HITL if
   * required, and the Hold / publish checks), then delete the version. Returns the updated item and whether main had
   * diverged from the snapshot.
   *
   * P10: never a silent overwrite. A merged branch promotes only onto main as it was merged against (409
   * BRANCH_STALE otherwise). An open branch whose main moved on is merged first: different fields/blocks combine, a
   * conflict refuses (409 MERGE_CONFLICT) — a person merges and chooses.
   */
  async promote(
    collection: string,
    itemId: string,
    key: string,
    /** The version of main the caller saw when deciding to promote (P04). */
    expectedVersion: number | undefined,
    /** Why (P05): needed when the version changes a published item's sponsor marking. */
    reason?: string,
  ): Promise<{ item: unknown; mainDiverged: boolean }> {
    const version = await this.get(collection, itemId, key);
    if (!version) throw new ContentVersionError('NOT_FOUND', `Version "${key}" not found.`, 404);
    const main = await this.mainItem(collection, itemId);
    const mainDiverged = version.hash !== hashData(main.data);
    let data = version.data;
    if (version.state === 'merged') {
      if (version.baseVersion !== null && version.baseVersion !== main.version) {
        throw new ContentVersionError('BRANCH_STALE', 'Main changed after this branch was merged: merge it again.', 409, { mainVersion: main.version, mergedAgainst: version.baseVersion });
      }
    } else if (version.baseData && version.baseVersion !== main.version) {
      const outcome = threeWayMerge(version.baseData, main.data, version.data, await this.blockFields(version.collectionId));
      if (outcome.unresolved.length) {
        throw new ContentVersionError('MERGE_CONFLICT', 'Main and the branch changed the same content: merge the branch and choose a side for each conflict.', 409, {
          conflicts: outcome.unresolved,
          mainVersion: main.version,
          revision: version.revision,
        });
      }
      data = outcome.data;
    }
    const item = await this.deps.items.patch(collection, itemId, { data, expectedVersion, reason });
    await this.remove(collection, itemId, key);
    // HeoPress P09: a promoted AI retranslation makes its blocks' translation maps current again.
    await rebuildRetranslationMaps(this.deps.db, this.deps.siteId, itemId, key);
    return { item, mainDiverged };
  }
}

export interface BranchDiff {
  key: string;
  name: string;
  state: string;
  revision: number;
  baseVersion: number | null;
  mainVersion: number;
  mainChanged: boolean;
  /** Base → branch. */
  branch: FieldChange[];
  /** Base → main (changes made on main after the branch was created). */
  main: FieldChange[];
  merge: { clean: boolean; conflicts: MergeConflict[]; fromBranch: string[]; fromMain: string[] };
}
