import { and, eq } from 'drizzle-orm';
import { collections, contentRoutes, items, publicItems, siteContentSettings, sites, translationBlockMap, translationGroupMembers, translationGroups, type Database } from '@heopress/database';
import { AuditLogger } from '../../modules/audit/logger';
import type { OutboxActor } from '../../modules/cdc/change-feed/outbox-writer';
import { ItemServiceError } from '../item-service-error';
import type { ItemService } from '../item-service';
import { runSiteTransaction, withSiteScope, type SiteTransaction } from '../rls-transaction';
import { publicUrlOf } from '@heopress/public-site';
import { publicItemPredicate } from './public-path';
import { loadSpace } from './site-rules';
import { publicItemIndexable, seoSettingsOf } from './public-projection';
import {
  bumpGroup,
  crossSiteSwitches,
  groupMemberItems,
  itemLocale,
  lockGroup,
  MembershipChangedError,
  onMemberRemoved,
  publishedMemberIn,
  withTransactionRetry,
  writeGroupEvents,
  type GroupRow,
  type MemberRow,
} from './translation-groups';
import { applyIntent, latestOpenIntent, resyncFromSource, triggerOf, type SyncOutcome } from './shared-fields';
import { blocksOfItem, recordBaselines, refreshSource, retranslation, staleMapsOfSource } from './freshness';
import { memberState, translationStatus, type StatusMember, type TranslationState } from './translation-status';

/**
 * Translation group management (HeoPress P05 tasks 4.1–4.5; spec
 * i18n/translation-groups; design §0, D, R1, R9, R18, R24).
 *
 * - Changing a group needs update permission on every item involved, each
 *   checked by that site's `ItemService` built for the caller there (row
 *   rules included). Only a person crosses sites: an API key or MCP token
 *   reaches its own site's members alone.
 * - Members of different sites need both (all) sites' cross-site switch on
 *   (409 naming the site that has it off). Switching it off keeps the
 *   records but hides the other site's members from public data at once.
 * - Reading a group shows a member in full when the caller may read it
 *   there; otherwise only `{ locale, url }` when it is public and, for
 *   another site's member, both switches are on; otherwise nothing.
 * - Every change runs under the locks of design §0 (sites' settings rows,
 *   the group row, the item rows), checks the group version the caller saw
 *   and writes one event per member site.
 */

type Tx = SiteTransaction;

export interface TranslationGroupDeps {
  db: Database;
  /** The caller's site (the request's). */
  siteId: string;
  actor: OutboxActor | undefined;
  userId: string | null;
  /**
   * The caller's ItemService on `siteId`, on transaction `tx` (run inside that site's scope), or
   * null when the caller cannot act there at all (an API key, another site).
   */
  itemsOn: (siteId: string, tx: Tx) => ItemService | null;
  /** A member of `siteId` as a writer (who could confirm a blocked shared field sync). */
  personOn?: (userId: string, siteId: string, tx: Tx) => Promise<ItemService | null>;
}

interface MemberView {
  itemId: string;
  siteId: string;
  collection: string;
  locale: string;
  role: 'source' | 'translation';
  internalOnly: boolean;
  status: string;
  version: number;
  title: string | null;
  /** Shared fields waiting to sync from the source (P05 task 4.6), or null. */
  sharedSync: { status: 'pending' | 'blocked_permission' | 'blocked_hold'; fields: string[] } | null;
}

export interface PublicMemberView {
  locale: string;
  url: string;
}

export interface GroupView {
  id: string;
  version: number;
  sourceEpoch: number;
  /** The source member's item, when the caller may read it (null: no source, or not readable). */
  sourceItemId: string | null;
  /** The x-default member's item, when the caller may read it (P07 task 2.2). */
  xDefaultItemId: string | null;
  members: MemberView[];
  /** Members the caller may not read, as the public sees them. */
  public: PublicMemberView[];
}

export interface Alternate {
  locale: string;
  url: string;
  current: boolean;
  /**
   * Whether the member may be indexed (P07 task 2.6): its site's SEO settings and its own setting, the decision of its
   * page and of the public hreflang. A language switch lists every public member; hreflang only the indexable ones.
   */
  indexable: boolean;
}

const notFound = () => new ItemServiceError('NOT_FOUND', 'Translation group not found.', 404);
/** The one refusal for an item the caller may not edit, whichever site or membership (no oracle). */
const editElsewhereForbidden = () => new ItemServiceError('FORBIDDEN', 'You need edit permission on every site of the translation group.', 403);

export class TranslationGroupService {
  constructor(private readonly deps: TranslationGroupDeps) {}

  private run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return withTransactionRetry(this.deps.db, () => runSiteTransaction(this.deps.db, this.deps.siteId, fn));
  }

  // ---------- reads ----------

  /** The group of an item of the caller's site (null: in no group). The item must be readable. */
  async forItem(itemId: string): Promise<GroupView | null> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      const member = await this.ownMember(tx, itemId);
      await this.readable(tx, this.deps.siteId, itemId, true);
      if (!member) return null;
      const [group] = await tx.select().from(translationGroups).where(eq(translationGroups.id, member.groupId));
      return group ? this.view(tx, group) : null;
    });
  }

  async get(groupId: string): Promise<GroupView> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      const [group] = await tx.select().from(translationGroups).where(eq(translationGroups.id, groupId));
      if (!group) throw notFound();
      const view = await this.view(tx, group);
      // Nothing the caller may read: as good as no group (existence is not disclosed).
      if (view.members.length === 0) throw notFound();
      return view;
    });
  }

  /**
   * The language switch data of an item of the caller's site (spec "双方开启"; design D): the
   * group's public members — published, not deleted, not internal-only — with their public URLs;
   * another site's members only while both sites have the switch on. The item must be readable.
   */
  async alternates(collection: string, itemId: string): Promise<Alternate[]> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      await this.itemsOrThrow(this.deps.siteId, tx).detail(collection, itemId);
      const member = await this.ownMember(tx, itemId);
      const self = await this.publicMember(tx, this.deps.siteId, itemId);
      if (!member) return self ? [{ ...self, current: true, indexable: await this.indexable(tx, this.deps.siteId, itemId) }] : [];
      const [group] = await tx.select().from(translationGroups).where(eq(translationGroups.id, member.groupId));
      if (!group) return [];
      const switches = await crossSiteSwitches(tx, group.siteIds);
      const out: Alternate[] = [];
      for (const m of await groupMemberItems(tx, group)) {
        if (m.siteId !== this.deps.siteId && !(switches.get(m.siteId) && switches.get(this.deps.siteId))) continue;
        const pub = await this.publicMember(tx, m.siteId, m.itemId);
        if (pub) out.push({ ...pub, current: m.itemId === itemId, indexable: await this.indexable(tx, m.siteId, m.itemId) });
      }
      return out;
    });
  }

  // ---------- changes ----------

  /** A new group with an item of the caller's site as its source (design R9 "建组"). */
  async create(itemId: string): Promise<GroupView> {
    return this.run(async (tx) => {
      const siteId = this.deps.siteId;
      await crossSiteSwitches(tx, [siteId], 'share');
      const item = await this.lockItem(tx, siteId, itemId);
      await this.assertMayUpdate(tx, siteId, item.collection, itemId);
      if (await this.memberOf(tx, siteId, itemId)) throw new ItemServiceError('ALREADY_IN_GROUP', 'The item is already in a translation group.', 409);
      const [group] = await tx
        .insert(translationGroups)
        .values({ siteId, siteIds: [siteId], sourceItemId: itemId, sourceEpoch: 1, createdBy: this.deps.userId })
        .returning();
      await tx.insert(translationGroupMembers).values({
        groupId: group!.id,
        siteId,
        itemId,
        collectionId: item.collectionId,
        locale: await itemLocale(tx, siteId, item.data),
        role: 'source',
        joinedBy: this.deps.userId,
      });
      await writeGroupEvents(tx, group!, ['members', 'source'], this.deps.actor, { operation: 'create' });
      return this.view(tx, group!);
    });
  }

  /** Add an item (of the caller's site, or — for a person — of another site) to the group. */
  async addMember(groupId: string, input: { siteId?: string; itemId: string; expectedVersion: number }): Promise<GroupView> {
    return this.run((tx) => this.addMemberTx(tx, groupId, input));
  }

  private async addMemberTx(tx: Tx, groupId: string, input: { siteId?: string; itemId: string; expectedVersion: number }): Promise<GroupView> {
    const itemSite = input.siteId ?? this.deps.siteId;
    {
      // Another site's item: nothing about it (existence, state, group) is told before the caller is
      // known to edit it there — a caller who cannot act there, or may not edit it, gets the same 403.
      if (itemSite !== this.deps.siteId) await this.assertMayEditElsewhere(tx, itemSite, input.itemId);
      const group = await this.lockForChange(tx, groupId, input.expectedVersion, [itemSite]);
      const item = await this.lockItem(tx, itemSite, input.itemId);
      const members = await groupMemberItems(tx, group);
      await this.assertMayChange(tx, members, [{ siteId: itemSite, collection: item.collection, itemId: input.itemId }]);
      if (await this.memberOf(tx, itemSite, input.itemId)) throw new ItemServiceError('ALREADY_IN_GROUP', 'The item is already in a translation group.', 409);
      const siteIds = [...new Set([...group.siteIds, itemSite])].sort();
      await this.assertCrossSiteAllowed(tx, siteIds);
      const locale = await withSiteScope(tx, itemSite, () => itemLocale(tx, itemSite, item.data));
      if (item.status === 'published' && (await publishedMemberIn(tx, group, locale, input.itemId))) {
        throw new ItemServiceError('LOCALE_ALREADY_PUBLISHED', `The translation group already has a published ${locale} version.`, 409);
      }
      await withSiteScope(tx, group.siteId, () => bumpGroup(tx, group, { siteIds }));
      await withSiteScope(tx, itemSite, () =>
        tx.insert(translationGroupMembers).values({
          groupId,
          siteId: itemSite,
          itemId: input.itemId,
          collectionId: item.collectionId,
          locale,
          role: 'translation',
          joinedBy: this.deps.userId,
        }),
      );
      // The new member takes the source's shared values (design R18).
      await resyncFromSource(tx, group, triggerOf(this.deps.actor, this.deps.userId), [input.itemId]);
      await writeGroupEvents(tx, group, ['members'], this.deps.actor);
      return this.view(tx, group);
    }
  }

  /** Take a member out (design R9): a source only when it is the last member (the group goes with it). */
  async removeMember(groupId: string, itemId: string, expectedVersion: number): Promise<GroupView | null> {
    return this.run(async (tx) => {
      const group = await this.lockForChange(tx, groupId, expectedVersion, []);
      const members = await groupMemberItems(tx, group);
      const member = members.find((m) => m.itemId === itemId);
      if (!member) throw new ItemServiceError('NOT_A_MEMBER', 'The item is not in this translation group.', 404);
      await this.lockItem(tx, member.siteId, itemId, { deleted: true });
      await this.assertMayChange(tx, members, []);
      if (group.sourceItemId === itemId && members.length > 1) {
        throw new ItemServiceError('CHANGE_SOURCE_FIRST', 'Make another member the source before removing this one.', 409);
      }
      const { dissolved } = await onMemberRemoved(tx, { group, member }, this.deps.actor);
      return dissolved ? null : this.view(tx, group);
    });
  }

  /** Make a member the source (design R9, R18, R24): a new source epoch. */
  async setSource(groupId: string, itemId: string, expectedVersion: number): Promise<GroupView> {
    return this.run(async (tx) => {
      const group = await this.lockForChange(tx, groupId, expectedVersion, []);
      const members = await groupMemberItems(tx, group);
      const next = members.find((m) => m.itemId === itemId);
      if (!next) throw new ItemServiceError('NOT_A_MEMBER', 'The item is not in this translation group.', 404);
      if (next.deleted) throw new ItemServiceError('SOURCE_DELETED', 'A deleted item cannot be the source.', 409);
      await this.assertMayChange(tx, members, []);
      if (group.sourceItemId === itemId) return this.view(tx, group);
      const previous = members.find((m) => m.role === 'source');
      if (previous && group.sourceItemId === previous.itemId && previous.internalOnly) {
        throw new ItemServiceError('CLEAR_INTERNAL_FIRST', 'Clear the internal-only mark of the current source first.', 409);
      }
      if (previous) {
        // Its maps are no longer current: review (design R9).
        await staleMapsOfSource(tx, group, previous.itemId, 'source_changed');
        // A deleted former source becomes a translation and loses its internal-only mark (R18).
        await withSiteScope(tx, previous.siteId, () =>
          tx.update(translationGroupMembers).set({ role: 'translation', internalOnly: false }).where(eq(translationGroupMembers.itemId, previous.itemId)),
        );
      }
      await withSiteScope(tx, next.siteId, () => tx.update(translationGroupMembers).set({ role: 'source' }).where(eq(translationGroupMembers.itemId, itemId)));
      await withSiteScope(tx, group.siteId, () => bumpGroup(tx, group, { sourceItemId: itemId, sourceEpoch: group.sourceEpoch + 1 }));
      // Members that differ from the new source take its shared values (design R18, R24).
      await resyncFromSource(tx, group, triggerOf(this.deps.actor, this.deps.userId));
      await writeGroupEvents(tx, group, ['source'], this.deps.actor);
      return this.view(tx, group);
    });
  }

  /**
   * The group's x-default (HeoPress P07 task 2.2; spec seo/page-metadata "翻译组的 x-default"): a member that is
   * published and indexable on its site now, or none (`null`). Changing it needs edit permission on every member,
   * like any change of the group; every member site's language switch is refreshed with it. Later it is output only
   * while that member stays published and indexable (the projection decides, not this check).
   */
  async setXDefault(groupId: string, itemId: string | null, expectedVersion: number): Promise<GroupView> {
    return this.run(async (tx) => {
      const group = await this.lockForChange(tx, groupId, expectedVersion, []);
      const members = await groupMemberItems(tx, group);
      // Permission first: a caller who may not change the group learns nothing of the target (membership,
      // publication, indexing) from the answer — every target is the same 403 (Codex review of batch 4a).
      await this.assertMayChange(tx, members, []);
      if (itemId !== null) {
        const member = members.find((m) => m.itemId === itemId);
        if (!member) throw new ItemServiceError('NOT_A_MEMBER', 'The item is not in this translation group.', 404);
        await this.lockItem(tx, member.siteId, itemId, { deleted: true });
        if (member.deleted || !(await this.indexable(tx, member.siteId, itemId))) {
          throw new ItemServiceError('X_DEFAULT_NOT_INDEXABLE', 'The x-default must be a published, indexable member of the group.', 409);
        }
      }
      if (group.xDefaultItemId === itemId) return this.view(tx, group);
      await withSiteScope(tx, group.siteId, () => bumpGroup(tx, group, { xDefaultItemId: itemId }));
      await writeGroupEvents(tx, group, ['xDefault'], this.deps.actor);
      return this.view(tx, group);
    });
  }

  /**
   * Mark or clear the source as internal-only (spec "仅内部的源语言成员"; design D): only the source,
   * and only while it is not published (409 `UNPUBLISH_FIRST`).
   */
  async setInternalOnly(groupId: string, itemId: string, internalOnly: boolean, expectedVersion: number): Promise<GroupView> {
    return this.run(async (tx) => {
      const group = await this.lockForChange(tx, groupId, expectedVersion, []);
      const members = await groupMemberItems(tx, group);
      const member = members.find((m) => m.itemId === itemId);
      if (!member) throw new ItemServiceError('NOT_A_MEMBER', 'The item is not in this translation group.', 404);
      const item = await this.lockItem(tx, member.siteId, itemId);
      await this.assertMayChange(tx, members, []);
      if (member.internalOnly === internalOnly) return this.view(tx, group);
      if (internalOnly) {
        if (member.role !== 'source' || group.sourceItemId !== itemId) {
          throw new ItemServiceError('SOURCE_ONLY', 'Only the source of a translation group can be internal-only.', 409);
        }
        if (item.status === 'published') throw new ItemServiceError('UNPUBLISH_FIRST', 'Unpublish the item before marking it internal-only.', 409);
      }
      await withSiteScope(tx, member.siteId, () => tx.update(translationGroupMembers).set({ internalOnly }).where(eq(translationGroupMembers.itemId, itemId)));
      await withSiteScope(tx, group.siteId, () => bumpGroup(tx, group));
      await writeGroupEvents(tx, group, ['internalOnly'], this.deps.actor);
      return this.view(tx, group);
    });
  }

  /**
   * Apply the member's blocked shared field sync as the caller (spec "对部分成员站点没有权限": confirmed
   * by someone with permission there). Only the member's latest intent, and only while it is still
   * current; 409 `SHARED_SYNC_BLOCKED` when the caller cannot apply it either.
   */
  async applyShared(groupId: string, itemId: string): Promise<{ outcome: SyncOutcome }> {
    const target = await runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      const [group] = await tx.select().from(translationGroups).where(eq(translationGroups.id, groupId));
      if (!group) throw notFound();
      const member = (await groupMemberItems(tx, group)).find((m) => m.itemId === itemId);
      // The caller must be able to edit the item before anything about its membership or sync is told:
      // another site's member the caller cannot edit, and an item that is not on this site, answer alike.
      const forbidden = editElsewhereForbidden();
      if (member && member.siteId !== this.deps.siteId) await this.assertMayEditElsewhere(tx, member.siteId, itemId);
      else {
        const [c] = await tx
          .select({ name: collections.name })
          .from(items)
          .innerJoin(collections, eq(collections.id, items.collectionId))
          .where(and(eq(items.siteId, this.deps.siteId), eq(items.id, itemId)));
        if (!c) throw forbidden;
        await this.assertMayUpdate(tx, this.deps.siteId, c.name, itemId).catch(() => {
          throw forbidden;
        });
      }
      if (!member) throw new ItemServiceError('NOT_A_MEMBER', 'The item is not in this translation group.', 404);
      const intent = await latestOpenIntent(tx, member.siteId, itemId);
      if (!intent || !intent.status.startsWith('blocked_')) throw new ItemServiceError('NOTHING_TO_APPLY', 'No blocked shared field sync for this item.', 409);
      return { siteId: member.siteId, intentId: intent.id };
    });
    const outcome = await applyIntent(
      this.deps.db,
      target.intentId,
      target.siteId,
      {
        writer: async (_intent, tx) => this.deps.itemsOn(target.siteId, tx),
        person: async (userId, tx) => (this.deps.personOn ? this.deps.personOn(userId, target.siteId, tx) : null),
      },
      { accept: ['blocked_permission', 'blocked_hold'], resolvedBy: this.deps.userId },
    );
    if (outcome === 'blocked_permission' || outcome === 'blocked_hold') {
      throw new ItemServiceError('SHARED_SYNC_BLOCKED', outcome === 'blocked_hold' ? 'The item is on hold: release it first.' : 'You cannot edit this item either.', 409);
    }
    return { outcome };
  }

  /**
   * Write block maps from the group's source to one translation (design E; used by the translation
   * pipeline and by people aligning blocks): the source must be readable and the target writable by
   * the caller. Existing maps of those target blocks are rebuilt but keep `human_edited`. The source's
   * baseline order is recorded for the fields involved, after judging the old maps against the old one.
   */
  async writeMaps(groupId: string, input: { targetItemId: string; pairs: Array<{ sourceKey: string; targetKey: string }> }): Promise<{ written: number }> {
    if (input.pairs.length === 0) return { written: 0 };
    return this.run((tx) => this.writeMapsTx(tx, groupId, input));
  }

  private async writeMapsTx(tx: Tx, groupId: string, input: { targetItemId: string; pairs: Array<{ sourceKey: string; targetKey: string }> }): Promise<{ written: number }> {
    {
      const { group, source, target } = await this.mapEnds(tx, groupId, input.targetItemId);
      await this.readable(tx, source.siteId, source.itemId, true);
      await this.assertMayUpdate(tx, target.siteId, target.collection, target.itemId);
      const srcBlocks = new Map(source.blocks.map((b) => [b.key, b]));
      const tgtBlocks = new Map(target.blocks.map((b) => [b.key, b]));
      for (const p of input.pairs) {
        if (!srcBlocks.has(p.sourceKey) || !tgtBlocks.has(p.targetKey)) {
          throw new ItemServiceError('UNKNOWN_BLOCK', `No block ${!srcBlocks.has(p.sourceKey) ? p.sourceKey : p.targetKey} in the ${!srcBlocks.has(p.sourceKey) ? 'source' : 'translation'}.`, 422);
        }
      }
      await refreshSource(tx, source.siteId, source.itemId);
      await withSiteScope(tx, target.siteId, async () => {
        for (const p of input.pairs) {
          const values = {
            siteId: target.siteId,
            groupId: group.id,
            sourceItemId: source.itemId,
            sourceKey: p.sourceKey,
            sourceHash: srcBlocks.get(p.sourceKey)!.hash,
            targetItemId: target.itemId,
            targetKey: p.targetKey,
            targetHash: tgtBlocks.get(p.targetKey)!.hash,
            mappedBy: this.deps.userId,
          };
          await tx
            .insert(translationBlockMap)
            .values(values)
            .onConflictDoUpdate({
              target: [translationBlockMap.targetItemId, translationBlockMap.targetKey],
              // `human_edited` is never cleared here (spec "增量重译保护人工修改").
              set: { sourceItemId: values.sourceItemId, sourceKey: values.sourceKey, sourceHash: values.sourceHash, targetHash: values.targetHash, stale: false, staleReason: null, mappedBy: values.mappedBy, mappedAt: new Date(), updatedAt: new Date() },
            });
        }
      });
      await recordBaselines(tx, source.siteId, source.itemId, source.blocks, input.pairs.map((p) => p.sourceKey.split('#')[0]!));
      return { written: input.pairs.length };
    }
  }

  /**
   * A person accepts a translation as up to date with its source (design E): at the target version
   * they saw, its maps (or the keys given) take the current hashes; stale and human marks are cleared;
   * audited. Only a person who may edit the translation.
   */
  async acceptMaps(groupId: string, input: { targetItemId: string; expectedTargetVersion: number; keys?: string[] }): Promise<{ accepted: number }> {
    if (this.deps.actor?.type !== 'user' || !this.deps.userId) throw new ItemServiceError('FORBIDDEN', 'Only a person can accept a translation.', 403);
    return this.run(async (tx) => {
      const { source, target } = await this.mapEnds(tx, groupId, input.targetItemId);
      await this.assertMayUpdate(tx, target.siteId, target.collection, target.itemId);
      if (target.version !== input.expectedTargetVersion) {
        throw new ItemServiceError('VERSION_CONFLICT', `The translation changed since the version you read (now version ${target.version}).`, 409);
      }
      // Judge against the old baseline before it is replaced (R7): moves the acceptance does not cover stay found.
      await refreshSource(tx, source.siteId, source.itemId);
      const srcBlocks = new Map(source.blocks.map((b) => [b.key, b.hash]));
      const tgtBlocks = new Map(target.blocks.map((b) => [b.key, b.hash]));
      const accepted = await withSiteScope(tx, target.siteId, async () => {
        const maps = await tx
          .select()
          .from(translationBlockMap)
          .where(and(eq(translationBlockMap.siteId, target.siteId), eq(translationBlockMap.targetItemId, target.itemId)));
        const chosen = maps.filter((m) => !input.keys || input.keys.includes(m.targetKey));
        for (const m of chosen) {
          await tx
            .update(translationBlockMap)
            .set({
              sourceItemId: source.itemId,
              sourceHash: srcBlocks.get(m.sourceKey) ?? m.sourceHash,
              targetHash: tgtBlocks.get(m.targetKey) ?? m.targetHash,
              stale: false,
              staleReason: null,
              humanEdited: false,
              updatedAt: new Date(),
            })
            .where(eq(translationBlockMap.id, m.id));
        }
        await new AuditLogger({ db: tx as unknown as Database, siteId: target.siteId }).writeInTransaction(tx, {
          siteId: target.siteId,
          event: 'translation_blocks_accepted',
          metadata: { operator: this.deps.userId, groupId, targetItemId: target.itemId, targetVersion: target.version, keys: chosen.map((m) => m.targetKey) },
        });
        return chosen;
      });
      await recordBaselines(tx, source.siteId, source.itemId, source.blocks, accepted.map((m) => m.sourceKey.split('#')[0]!));
      return { accepted: accepted.length };
    });
  }

  /** The retranslation contract of a translation of this site (spec "增量重译保护人工修改"): read only. */
  async retranslate(collection: string, itemId: string): Promise<Awaited<ReturnType<typeof retranslation>>> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      await this.itemsOrThrow(this.deps.siteId, tx).detail(collection, itemId);
      return retranslation(tx, this.deps.siteId, itemId);
    });
  }

  /**
   * A new translation draft of the group's source in `locale`, on this site (spec "新建译文"; design E):
   * the source's SEO title, description, social image and indexing setting are copied; the canonical
   * URL is not (empty: each language version is its own canonical). The draft joins the group and its
   * SEO pseudo blocks are mapped to the source's, so a later change of the source's SEO marks them stale.
   */
  async createDraft(groupId: string, input: { locale: string }): Promise<{ itemId: string; group: GroupView }> {
    const siteId = this.deps.siteId;
    const afterCommit: Array<() => Promise<void>> = [];
    // One transaction (design §0 locks: settings rows, the group, then the items): the source cannot
    // change between the copy and the maps, and nothing is left behind when a step fails.
    const itemId = await this.run(async (tx) => {
      afterCommit.length = 0;
      const [seen] = await tx.select().from(translationGroups).where(eq(translationGroups.id, groupId));
      if (!seen) throw notFound();
      await crossSiteSwitches(tx, seen.siteIds, 'share');
      const group = await lockGroup(tx, groupId);
      if (!group) throw notFound();
      // A site added between the reads has a settings row not locked yet: start over (no lock after the group's).
      if (group.siteIds.some((s) => !seen.siteIds.includes(s))) throw new MembershipChangedError();
      if (!group.sourceItemId) throw new ItemServiceError('NO_SOURCE', 'The translation group has no source.', 409);
      const member = (await groupMemberItems(tx, group)).find((m) => m.itemId === group.sourceItemId)!;
      const source = await this.readable(tx, member.siteId, member.itemId, true);
      const [coll] = await withSiteScope(tx, member.siteId, () => tx.select({ name: collections.name }).from(collections).where(eq(collections.id, member.collectionId)));
      const sourceData = (source?.data ?? {}) as Record<string, unknown>;
      const copied = Object.fromEntries(
        ['seo_title', 'seo_description', 'seo_image', 'seo_robots'].filter((f) => sourceData[f] !== undefined).map((f) => [f, sourceData[f]]),
      );
      // The title and slug start as the source's (to be translated): a draft of a preset collection needs both;
      // paths are per language, so the same slug does not collide with the source's.
      const draft = {
        ...copied,
        ...(sourceData.title !== undefined ? { title: sourceData.title } : {}),
        ...(sourceData.slug !== undefined ? { slug: sourceData.slug } : {}),
        canonical_url: null,
        locale: input.locale,
      };
      const writer = this.itemsOrThrow(siteId, tx);
      const created = await writer.createInTransaction(coll!.name, { data: draft, status: 'draft' }, afterCommit);
      await this.addMemberTx(tx, groupId, { itemId: created.id, expectedVersion: group.version });
      const seoKeys = ['seo_title', 'seo_description', 'seo_image'].filter((f) => copied[f] !== undefined).map((f) => `${f}#$`);
      if (seoKeys.length > 0) await this.writeMapsTx(tx, groupId, { targetItemId: created.id, pairs: seoKeys.map((k) => ({ sourceKey: k, targetKey: k })) });
      return created.id;
    });
    for (const fn of afterCommit) await fn().catch((err: unknown) => console.warn('[translation-groups] after-commit work failed', { itemId, err: String(err) }));
    return { itemId, group: await this.get(groupId) };
  }

  /**
   * The translation status of an item's group for each language of this site (spec "翻译状态"):
   * computed from the members the caller may read (their status, review state and stale maps); a
   * member of another site the caller may not read counts only as published when it is public.
   */
  async translationStatus(collection: string, itemId: string): Promise<{
    locales: Array<{ locale: string; state: TranslationState; itemId: string | null }>;
    /** Each member the caller may read, with its own state (design E "逐成员状态"). */
    members: Array<{ itemId: string; siteId: string; locale: string; state: TranslationState }>;
  }> {
    return runSiteTransaction(this.deps.db, this.deps.siteId, async (tx) => {
      await this.itemsOrThrow(this.deps.siteId, tx).detail(collection, itemId);
      const [settings] = await tx.select({ locales: siteContentSettings.availableLocales }).from(siteContentSettings).where(eq(siteContentSettings.siteId, this.deps.siteId));
      const [site] = await tx.select({ defaultLanguage: sites.defaultLanguage }).from(sites).where(eq(sites.id, this.deps.siteId));
      const locales = settings?.locales?.length ? settings.locales : [site!.defaultLanguage];
      const member = await this.ownMember(tx, itemId);
      const members: StatusMember[] = [];
      const readableMembers: Array<{ itemId: string; siteId: string; locale: string; state: TranslationState }> = [];
      if (member) {
        const [group] = await tx.select().from(translationGroups).where(eq(translationGroups.id, member.groupId));
        const switches = group ? await crossSiteSwitches(tx, group.siteIds) : new Map<string, boolean>();
        for (const m of group ? await groupMemberItems(tx, group) : []) {
          if (m.deleted) continue;
          if (await this.readable(tx, m.siteId, m.itemId)) {
            const [row] = await withSiteScope(tx, m.siteId, () => tx.select({ editorialState: items.editorialState }).from(items).where(eq(items.id, m.itemId)));
            const [stale] = await withSiteScope(tx, m.siteId, () =>
              tx
                .select({ id: translationBlockMap.id })
                .from(translationBlockMap)
                .where(and(eq(translationBlockMap.siteId, m.siteId), eq(translationBlockMap.targetItemId, m.itemId), eq(translationBlockMap.stale, true)))
                .limit(1),
            );
            const entry: StatusMember = { itemId: m.itemId, locale: m.locale, status: m.status, editorialState: row?.editorialState ?? null, deleted: false, stale: !!stale };
            members.push(entry);
            readableMembers.push({ itemId: m.itemId, siteId: m.siteId, locale: m.locale, state: memberState(entry) });
          } else if ((m.siteId === this.deps.siteId || (switches.get(m.siteId) && switches.get(this.deps.siteId))) && (await this.publicMember(tx, m.siteId, m.itemId))) {
            // Public only: published, nothing more is told (no item ID of another site).
            members.push({ itemId: '', locale: m.locale, status: 'published', editorialState: null, deleted: false, stale: false });
          }
        }
      } else {
        const [row] = await tx.select({ status: items.status, editorialState: items.editorialState, data: items.data }).from(items).where(eq(items.id, itemId));
        const entry: StatusMember = { itemId, locale: await itemLocale(tx, this.deps.siteId, row?.data), status: row!.status, editorialState: row!.editorialState ?? null, deleted: false, stale: false };
        members.push(entry);
        readableMembers.push({ itemId, siteId: this.deps.siteId, locale: entry.locale, state: memberState(entry) });
      }
      return { locales: translationStatus(locales, members).map((l) => ({ ...l, itemId: l.itemId || null })), members: readableMembers };
    });
  }

  /** The group's source and a translation member, with their blocks (group visible from this site). */
  private async mapEnds(tx: Tx, groupId: string, targetItemId: string) {
    // Lock order (design §0): the sites' settings rows, then the group.
    const [seen] = await tx.select().from(translationGroups).where(eq(translationGroups.id, groupId));
    if (!seen) throw notFound();
    await crossSiteSwitches(tx, seen.siteIds, 'share');
    const group = await lockGroup(tx, groupId);
    if (!group) throw notFound();
    if (group.siteIds.some((s) => !seen.siteIds.includes(s))) throw new MembershipChangedError();
    if (!group.sourceItemId) throw new ItemServiceError('NO_SOURCE', 'The translation group has no source.', 409);
    const members = await groupMemberItems(tx, group);
    const sourceMember = members.find((m) => m.itemId === group.sourceItemId);
    const targetMember = members.find((m) => m.itemId === targetItemId);
    if (!sourceMember || !targetMember || targetMember.itemId === sourceMember.itemId) {
      throw new ItemServiceError('NOT_A_MEMBER', 'The item is not a translation in this group.', 404);
    }
    const source = await blocksOfItem(tx, sourceMember.siteId, sourceMember.itemId);
    const target = await blocksOfItem(tx, targetMember.siteId, targetMember.itemId);
    if (!source || !target || target.deleted) throw new ItemServiceError('NOT_FOUND', 'Item not found.', 404);
    return {
      group,
      source: { ...source, siteId: sourceMember.siteId, itemId: sourceMember.itemId },
      target: { ...target, siteId: targetMember.siteId, itemId: targetMember.itemId, version: targetMember.version },
    };
  }

  // ---------- internals ----------

  /**
   * Lock for a change (design §0): the settings rows of every site involved (`FOR SHARE`, in ID
   * order), then the group row; the group the caller saw (`expectedVersion`, 409 otherwise). A group
   * that gained a site between the reads starts the transaction over.
   */
  private async lockForChange(tx: Tx, groupId: string, expectedVersion: number, extraSites: string[]): Promise<GroupRow> {
    const [seen] = await tx.select().from(translationGroups).where(eq(translationGroups.id, groupId));
    if (!seen) throw notFound();
    await crossSiteSwitches(tx, [...seen.siteIds, ...extraSites], 'share');
    const group = await lockGroup(tx, groupId);
    if (!group) throw notFound();
    if (group.siteIds.some((s) => !seen.siteIds.includes(s))) throw new MembershipChangedError();
    if (group.version !== expectedVersion) {
      throw new ItemServiceError('VERSION_CONFLICT', `The translation group changed since the version you read (now version ${group.version}).`, 409);
    }
    return group;
  }

  /** Lock an item row of `siteId` (`FOR UPDATE`, in its scope): a concurrent publish or join waits. */
  private async lockItem(
    tx: Tx,
    siteId: string,
    itemId: string,
    opts: { deleted?: boolean } = {},
  ): Promise<{ collectionId: string; collection: string; status: string; data: unknown }> {
    const [row] = await withSiteScope(tx, siteId, () =>
      tx
        .select({ collectionId: items.collectionId, collection: collections.name, status: items.status, data: items.data, deletedAt: items.deletedAt })
        .from(items)
        .innerJoin(collections, eq(collections.id, items.collectionId))
        .where(and(eq(items.siteId, siteId), eq(items.id, itemId)))
        .for('update', { of: items }),
    );
    if (!row || (row.deletedAt && !opts.deleted)) throw new ItemServiceError('NOT_FOUND', `Item "${itemId}" not found.`, 404);
    return row;
  }

  private async memberOf(tx: Tx, siteId: string, itemId: string): Promise<MemberRow | undefined> {
    const [m] = await withSiteScope(tx, siteId, () => tx.select().from(translationGroupMembers).where(eq(translationGroupMembers.itemId, itemId)));
    return m;
  }

  private ownMember(tx: Tx, itemId: string): Promise<MemberRow | undefined> {
    return this.memberOf(tx, this.deps.siteId, itemId);
  }

  private itemsOrThrow(siteId: string, tx: Tx): ItemService {
    const svc = this.deps.itemsOn(siteId, tx);
    if (!svc) throw new ItemServiceError('FORBIDDEN', 'Only a person can work with another site’s items.', 403);
    return svc;
  }

  /** 403 unless the caller may edit `itemId` on another site (also when it does not exist there). */
  private async assertMayEditElsewhere(tx: Tx, siteId: string, itemId: string): Promise<void> {
    const forbidden = editElsewhereForbidden();
    if (!this.deps.itemsOn(siteId, tx)) throw forbidden;
    const [c] = await withSiteScope(tx, siteId, () =>
      tx
        .select({ name: collections.name })
        .from(items)
        .innerJoin(collections, eq(collections.id, items.collectionId))
        .where(and(eq(items.siteId, siteId), eq(items.id, itemId))),
    );
    if (!c) throw forbidden;
    await this.assertMayUpdate(tx, siteId, c.name, itemId);
  }

  private async assertMayUpdate(tx: Tx, siteId: string, collection: string, itemId: string): Promise<void> {
    const svc = this.itemsOrThrow(siteId, tx);
    await withSiteScope(tx, siteId, () => svc.assertMayUpdate(collection, itemId)).catch((err: unknown) => {
      // Another site's item the caller may not change: forbidden, whatever the reason (no existence oracle).
      if (siteId !== this.deps.siteId && err instanceof ItemServiceError) throw editElsewhereForbidden();
      throw err;
    });
  }

  /** Update permission on every live member and on the items joining (spec "翻译组权限"). */
  private async assertMayChange(
    tx: Tx,
    members: Array<MemberRow & { deleted: boolean }>,
    joining: Array<{ siteId: string; collection: string; itemId: string }>,
  ): Promise<void> {
    const names = await this.collectionNames(tx, members);
    for (const m of members) {
      if (m.deleted) continue;
      await this.assertMayUpdate(tx, m.siteId, names.get(m.collectionId)!, m.itemId);
    }
    for (const j of joining) await this.assertMayUpdate(tx, j.siteId, j.collection, j.itemId);
  }

  private async collectionNames(tx: Tx, members: MemberRow[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const m of members) {
      if (out.has(m.collectionId)) continue;
      const [c] = await withSiteScope(tx, m.siteId, () => tx.select({ name: collections.name }).from(collections).where(eq(collections.id, m.collectionId)));
      out.set(m.collectionId, c?.name ?? '');
    }
    return out;
  }

  /** Members of more than one site need every site's switch on (409 naming the first that has it off). */
  private async assertCrossSiteAllowed(tx: Tx, siteIds: string[]): Promise<void> {
    if (siteIds.length < 2) return;
    const switches = await crossSiteSwitches(tx, siteIds);
    for (const siteId of siteIds) {
      if (switches.get(siteId)) continue;
      const [site] = await withSiteScope(tx, siteId, () => tx.select({ name: sites.name }).from(sites).where(eq(sites.id, siteId)));
      throw Object.assign(
        new ItemServiceError('CROSS_SITE_DISABLED', `Site "${site?.name ?? siteId}" must turn on cross-site translations first.`, 409),
        { details: { siteId } },
      );
    }
  }

  /** Whether the caller can read the item there (its ItemService's detail: grant, row rule). */
  private async readable(tx: Tx, siteId: string, itemId: string, mustRead = false): Promise<{ data: Record<string, unknown> } | null> {
    const svc = this.deps.itemsOn(siteId, tx);
    if (!svc) {
      // A caller who cannot act on that site at all (an API key elsewhere) must not get past a required read.
      if (mustRead) throw editElsewhereForbidden();
      return null;
    }
    const [c] = await withSiteScope(tx, siteId, () =>
      tx.select({ name: collections.name }).from(items).innerJoin(collections, eq(collections.id, items.collectionId)).where(eq(items.id, itemId)),
    );
    if (!c) {
      if (mustRead) throw new ItemServiceError('NOT_FOUND', `Item "${itemId}" not found.`, 404);
      return null;
    }
    try {
      const row = (await withSiteScope(tx, siteId, () => svc.detail(c.name, itemId))) as { data: Record<string, unknown> };
      return row;
    } catch (err) {
      if (mustRead || !(err instanceof ItemServiceError) || (err.status !== 403 && err.status !== 404)) throw err;
      return null;
    }
  }

  /** `{ locale, url }` of a member the public may see (design §0 "公开摘要"), or null. */
  /** Whether a member is public and indexable now: its projection row (this transaction's) and its site's SEO settings. */
  private async indexable(tx: Tx, siteId: string, itemId: string): Promise<boolean> {
    return withSiteScope(tx, siteId, async () => {
      const [p] = await tx
        .select({ collection: publicItems.collection, seoRobots: publicItems.seoRobots })
        .from(publicItems)
        .where(and(eq(publicItems.siteId, siteId), eq(publicItems.itemId, itemId)));
      return !!p && publicItemIndexable(await seoSettingsOf(tx, siteId), p);
    });
  }

  private async publicMember(tx: Tx, siteId: string, itemId: string): Promise<PublicMemberView | null> {
    return withSiteScope(tx, siteId, async () => {
      const [route] = await tx
        .select({ locale: contentRoutes.locale, path: contentRoutes.path })
        .from(contentRoutes)
        .innerJoin(items, eq(items.id, contentRoutes.itemId))
        .where(and(eq(contentRoutes.siteId, siteId), eq(contentRoutes.itemId, itemId), publicItemPredicate()));
      if (!route) return null;
      const url = publicUrlOf(await loadSpace(tx, siteId), route.locale, route.path);
      return url ? { locale: route.locale, url } : null;
    });
  }

  private async view(tx: Tx, group: GroupRow): Promise<GroupView> {
    const switches = await crossSiteSwitches(tx, group.siteIds);
    const names = new Map<string, string>();
    const out: GroupView = { id: group.id, version: group.version, sourceEpoch: group.sourceEpoch, sourceItemId: null, xDefaultItemId: null, members: [], public: [] };
    for (const m of await groupMemberItems(tx, group)) {
      const row = m.deleted ? null : await this.readable(tx, m.siteId, m.itemId);
      if (row) {
        if (!names.has(m.collectionId)) names.set(m.collectionId, (await this.collectionNames(tx, [m])).get(m.collectionId)!);
        const title = row.data?.title ?? row.data?.name;
        out.members.push({
          itemId: m.itemId,
          siteId: m.siteId,
          collection: names.get(m.collectionId)!,
          locale: m.locale,
          role: m.role as 'source',
          internalOnly: m.internalOnly,
          status: m.status,
          version: m.version,
          title: typeof title === 'string' ? title : null,
          sharedSync: await latestOpenIntent(tx, m.siteId, m.itemId).then((i) => (i ? { status: i.status as 'pending', fields: i.fields } : null)),
        });
        if (group.sourceItemId === m.itemId) out.sourceItemId = m.itemId;
        if (group.xDefaultItemId === m.itemId) out.xDefaultItemId = m.itemId;
        continue;
      }
      if (m.siteId !== this.deps.siteId && !(switches.get(m.siteId) && switches.get(this.deps.siteId))) continue;
      const pub = await this.publicMember(tx, m.siteId, m.itemId);
      if (pub) out.public.push(pub);
    }
    return out;
  }
}
