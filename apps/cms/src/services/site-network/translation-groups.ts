import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { canonicalLocale, sameLocale } from '@heopress/contracts/schemas';
import { items, sharedFieldSyncs, siteContentSettings, sites, translationGroupMembers, translationGroups } from '@heopress/database';
import { ItemServiceError } from '../item-service-error';
import { isRetryableConflict, isTransaction, MembershipChangedError, retryTransaction, withSiteScope, type SiteTransaction } from '../rls-transaction';
import { appendItemEvent, type OutboxActor } from '../../modules/cdc/change-feed/outbox-writer';
import { dropMapsOf, dropTargetMapsOf, staleMapsOfSource } from './freshness';

/**
 * Translation groups in item writes (HeoPress P05 tasks 4.1, 4.2, 4.5;
 * spec i18n/translation-groups; design D, R1, R2, R9, R13, R18).
 *
 * - Lock order (design §0): the sites' content settings rows (`FOR SHARE`,
 *   site ID order), then the group row (`FOR UPDATE`), then item rows.
 * - An item write that publishes, changes a member's language or deletes a
 *   member holds its group's row (`lockMembership`). Every membership change
 *   (join, leave, move) also locks the item row, so a write that saw no
 *   group before its item UPDATE checks again after it
 *   (`assertMembershipUnchanged`): a group joined meanwhile makes the whole
 *   transaction start over (`MembershipChangedError`, `withMembershipRetry`).
 * - A group may span sites: another site's members and settings are read in
 *   that site's scope (`withSiteScope`), on the same transaction.
 */

type Tx = SiteTransaction;

export type GroupRow = typeof translationGroups.$inferSelect;
export type MemberRow = typeof translationGroupMembers.$inferSelect;

// The item's group changed between the unlocked read and the lock: start the transaction over (design R13).
export { MembershipChangedError };

// The retry boundary, the conflict test and the transaction test live with the site transactions (one owner of retries).
export { isRetryableConflict, isTransaction };

/**
 * Run `attempt` (one whole transaction) again when the membership moved under it; 409 after three tries. With
 * `conflicts`, also on a deadlock or serialization failure (HeoPress P06 design R30) — only where `attempt` is the
 * outermost transaction. Inside another retry boundary it only runs `attempt` (`retryTransaction`).
 */
export function withMembershipRetry<T>(attempt: () => Promise<T>, opts: { conflicts?: boolean } = {}): Promise<T> {
  return retryTransaction(attempt, { conflicts: !!opts.conflicts });
}

/**
 * `attempt` opens a transaction on `db`. On the database it is the outermost one: membership changes,
 * deadlocks and serialization failures restart it (R30). Inside a caller's transaction only a moved
 * membership is retried (as before, P05); a deadlock or serialization failure propagates unchanged,
 * for the caller's own outermost boundary to retry the whole of it.
 */
export function withTransactionRetry<T>(db: unknown, attempt: () => Promise<T>): Promise<T> {
  return withMembershipRetry(attempt, { conflicts: !isTransaction(db) });
}

/** The item's membership with its group row locked, or null when it is in no group. */
export interface HeldMembership {
  group: GroupRow;
  member: MemberRow;
}

async function readMember(tx: Tx, siteId: string, itemId: string): Promise<MemberRow | undefined> {
  const [m] = await tx
    .select()
    .from(translationGroupMembers)
    .where(and(eq(translationGroupMembers.siteId, siteId), eq(translationGroupMembers.itemId, itemId)));
  return m;
}

/** Lock a group row (`FOR UPDATE`); undefined when it is gone. */
export async function lockGroup(tx: Tx, groupId: string): Promise<GroupRow | undefined> {
  // The lock order of every group write (P07, Codex review of batch 4a): the member sites' settings rows, shared and
  // in site order, then the group row — never a settings row after a group row, which could wait for a writer of
  // that site's settings while it waits for this group. A site that joined meanwhile was not locked first: start over.
  const [seen] = await tx.select({ siteIds: translationGroups.siteIds }).from(translationGroups).where(eq(translationGroups.id, groupId));
  if (seen) await crossSiteSwitches(tx, seen.siteIds, 'share');
  const [g] = await tx.select().from(translationGroups).where(eq(translationGroups.id, groupId)).for('update');
  if (g && seen && g.siteIds.some((site) => !seen.siteIds.includes(site))) throw new MembershipChangedError();
  return g;
}

/**
 * Lock the group of `itemId` (a member of the transaction's site). Call after the settings lock and
 * before the item's UPDATE. Throws `MembershipChangedError` when the item moved between the reads.
 */
export async function lockMembership(tx: Tx, siteId: string, itemId: string): Promise<HeldMembership | null> {
  const seen = await readMember(tx, siteId, itemId);
  if (!seen) return null;
  const group = await lockGroup(tx, seen.groupId);
  const member = await readMember(tx, siteId, itemId);
  if (!group || !member || member.groupId !== seen.groupId) throw new MembershipChangedError();
  return { group, member };
}

/** After the item's UPDATE (its row now locked): the item is still in the group held, or still in none. */
export async function assertMembershipUnchanged(tx: Tx, siteId: string, itemId: string, held: HeldMembership | null): Promise<void> {
  const now = await readMember(tx, siteId, itemId);
  if ((now?.groupId ?? null) !== (held?.group.id ?? null)) throw new MembershipChangedError();
}

/** Every member of the group, site by site in each site's scope (members follow the plain site policy). */
async function groupMembers(tx: Tx, group: Pick<GroupRow, 'id' | 'siteIds'>): Promise<MemberRow[]> {
  const out: MemberRow[] = [];
  for (const siteId of [...group.siteIds].sort()) {
    out.push(
      ...(await withSiteScope(tx, siteId, () =>
        tx.select().from(translationGroupMembers).where(and(eq(translationGroupMembers.groupId, group.id), eq(translationGroupMembers.siteId, siteId))),
      )),
    );
  }
  return out;
}

/** The members of `group` with their item's status, deleted flag and data, site by site. */
export async function groupMemberItems(
  tx: Tx,
  group: Pick<GroupRow, 'id' | 'siteIds'>,
): Promise<Array<MemberRow & { status: string; deleted: boolean; data: unknown; version: number }>> {
  const out: Array<MemberRow & { status: string; deleted: boolean; data: unknown; version: number }> = [];
  for (const siteId of [...group.siteIds].sort()) {
    const rows = await withSiteScope(tx, siteId, () =>
      tx
        .select({ m: translationGroupMembers, status: items.status, deletedAt: items.deletedAt, data: items.data, version: items.version })
        .from(translationGroupMembers)
        .innerJoin(items, eq(items.id, translationGroupMembers.itemId))
        .where(and(eq(translationGroupMembers.groupId, group.id), eq(translationGroupMembers.siteId, siteId)))
        .orderBy(asc(translationGroupMembers.joinedAt)),
    );
    for (const r of rows) out.push({ ...r.m, status: r.status, deleted: r.deletedAt !== null, data: r.data, version: r.version });
  }
  return out;
}

/**
 * The language a member records for an item: its `locale` field, else the site's default, in the site's
 * spelling (else the canonical BCP 47 form). Call in the item's site scope.
 */
export async function itemLocale(tx: Tx, siteId: string, data: unknown): Promise<string> {
  const [site] = await tx.select({ defaultLanguage: sites.defaultLanguage }).from(sites).where(eq(sites.id, siteId));
  const [settings] = await tx.select({ locales: siteContentSettings.availableLocales }).from(siteContentSettings).where(eq(siteContentSettings.siteId, siteId));
  const raw = (data as Record<string, unknown> | null)?.locale;
  const locale = typeof raw === 'string' && raw.trim() ? raw.trim() : site!.defaultLanguage;
  return settings?.locales?.find((l) => sameLocale(l, locale)) ?? canonicalLocale(locale) ?? locale;
}

/**
 * The publish check of a member (design D, A "发布转换"), under the group lock: an internal-only member
 * is never published (409 `INTERNAL_ONLY`); a language has at most one published member per group
 * (409 `LOCALE_ALREADY_PUBLISHED`).
 */
export async function assertMayPublishInGroup(tx: Tx, held: HeldMembership, locale: string): Promise<void> {
  if (held.member.internalOnly) {
    throw new ItemServiceError('INTERNAL_ONLY', 'This item is an internal-only translation source: clear the internal-only mark before publishing it.', 409);
  }
  const taken = await publishedMemberIn(tx, held.group, locale, held.member.itemId);
  if (taken) {
    throw new ItemServiceError('LOCALE_ALREADY_PUBLISHED', `The translation group already has a published ${locale} version.`, 409);
  }
}

/** Whether another member of the group in `locale` is published (any site). */
export async function publishedMemberIn(tx: Tx, group: Pick<GroupRow, 'id' | 'siteIds'>, locale: string, exceptItemId: string): Promise<boolean> {
  for (const siteId of [...group.siteIds].sort()) {
    const [row] = await withSiteScope(tx, siteId, () =>
      tx
        .select({ id: items.id })
        .from(translationGroupMembers)
        .innerJoin(items, eq(items.id, translationGroupMembers.itemId))
        .where(
          and(
            eq(translationGroupMembers.groupId, group.id),
            eq(translationGroupMembers.siteId, siteId),
            sql`lower(${translationGroupMembers.locale}) = lower(${locale})`,
            ne(translationGroupMembers.itemId, exceptItemId),
            eq(items.status, 'published'),
            isNull(items.deletedAt),
          ),
        )
        .limit(1),
    );
    if (row) return true;
  }
  return false;
}

/**
 * After a member's write (same transaction, group held): its language follows the item, and a
 * published member's language must stay free in the group. Returns whether the member changed.
 */
export async function followItemLocale(tx: Tx, held: HeldMembership, locale: string, published: boolean): Promise<boolean> {
  if (published && !sameLocale(held.member.locale, locale)) {
    if (await publishedMemberIn(tx, held.group, locale, held.member.itemId)) {
      throw new ItemServiceError('LOCALE_ALREADY_PUBLISHED', `The translation group already has a published ${locale} version.`, 409);
    }
  }
  if (held.member.locale === locale) return false;
  await tx.update(translationGroupMembers).set({ locale }).where(eq(translationGroupMembers.itemId, held.member.itemId));
  await bumpGroup(tx, held.group);
  return true;
}

/** `version + 1` (every member change); returns the new row. */
export async function bumpGroup(tx: Tx, group: GroupRow, set: Partial<Pick<GroupRow, 'sourceItemId' | 'sourceEpoch' | 'siteIds' | 'xDefaultItemId'>> = {}): Promise<GroupRow> {
  const [row] = await tx
    .update(translationGroups)
    .set({ ...set, version: sql`${translationGroups.version} + 1`, updatedAt: new Date() })
    .where(eq(translationGroups.id, group.id))
    .returning();
  Object.assign(group, row);
  return row!;
}

/** A source member's item was deleted: the group has no source until one is set (design R9, R18). */
export async function onMemberDeleted(tx: Tx, held: HeldMembership, actor?: OutboxActor): Promise<void> {
  if (held.member.role !== 'source' || held.group.sourceItemId !== held.member.itemId) {
    // A deleted translation: the maps that target it go (design R9). Maps it is the source of (a former
    // source, now `source_changed`) stay: they are the other translations' review records.
    await dropTargetMapsOf(tx, held.member.siteId, held.member.itemId);
    return;
  }
  // Its maps stay, as review records (design R9).
  await staleMapsOfSource(tx, held.group, held.member.itemId, 'source_removed');
  await bumpGroup(tx, held.group, { sourceItemId: null });
  await writeGroupEvents(tx, held.group, ['source'], actor);
}

/**
 * The group's change events, one per member site, each in its site's scope with only that site's
 * member IDs (design §0 "事件契约"). A site that just left gets its event too (`alsoSites`).
 */
export async function writeGroupEvents(
  tx: Tx,
  group: Pick<GroupRow, 'id' | 'siteIds' | 'version'>,
  changedFields: string[],
  actor?: OutboxActor,
  opts: { alsoSites?: string[]; operation?: 'create' | 'update' | 'delete' } = {},
): Promise<void> {
  const siteIds = [...new Set([...group.siteIds, ...(opts.alsoSites ?? [])])].sort();
  for (const siteId of siteIds) {
    await withSiteScope(tx, siteId, async () => {
      const members = await tx
        .select({ itemId: translationGroupMembers.itemId })
        .from(translationGroupMembers)
        .where(and(eq(translationGroupMembers.groupId, group.id), eq(translationGroupMembers.siteId, siteId)));
      await appendItemEvent(tx, {
        siteId,
        resource: 'translation_group',
        operation: opts.operation ?? 'update',
        collection: '$translation_group',
        itemId: group.id,
        itemVersion: group.version,
        changedFields,
        actor,
        source: actor && actor.type !== 'system' ? 'api' : 'system',
        payload: { groupId: group.id, members: members.map((m) => m.itemId) },
      });
    });
  }
}

/** The sites' cross-site translation switches, each read in its own scope (lock them first when it matters). */
export async function crossSiteSwitches(tx: Tx, siteIds: string[], lock: 'share' | 'none' = 'none'): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (const siteId of [...new Set(siteIds)].sort()) {
    const q = tx
      .select({ allow: siteContentSettings.allowCrossSiteTranslations })
      .from(siteContentSettings)
      .where(eq(siteContentSettings.siteId, siteId));
    const [row] = await withSiteScope(tx, siteId, () => (lock === 'share' ? q.for('share') : q));
    out.set(siteId, row?.allow ?? false);
  }
  return out;
}

/** The groups that have members of `siteId` and of another site (a settings change re-announces them). */
export async function crossSiteGroupsOf(tx: Tx, siteId: string): Promise<GroupRow[]> {
  const ids = await tx
    .selectDistinct({ groupId: translationGroupMembers.groupId })
    .from(translationGroupMembers)
    .where(eq(translationGroupMembers.siteId, siteId));
  if (ids.length === 0) return [];
  const groups = await tx.select().from(translationGroups).where(inArray(translationGroups.id, ids.map((r) => r.groupId)));
  return groups.filter((g) => g.siteIds.length > 1);
}

/**
 * A member leaves its group (removed, moved, or its item deleted for good), group held: its row
 * goes; a source leaves the group without one; a site with no member left drops out of `site_ids`
 * (written in the creating site's scope, which may always write the row); a group with no member
 * left is dissolved. Events for every site involved, the one that left included.
 */
export async function onMemberRemoved(tx: Tx, held: HeldMembership, actor?: OutboxActor): Promise<{ dissolved: boolean }> {
  return onMembersRemoved(tx, held.group, [held.member], actor);
}

/** Several members of one group leave at once (one member read, one group update, one event per site). */
async function onMembersRemoved(tx: Tx, group: GroupRow, leaving: MemberRow[], actor?: OutboxActor): Promise<{ dissolved: boolean }> {
  const bySite = new Map<string, string[]>();
  for (const m of leaving) {
    const ids = bySite.get(m.siteId) ?? [];
    ids.push(m.itemId);
    bySite.set(m.siteId, ids);
  }
  for (const [siteId, ids] of bySite) {
    await withSiteScope(tx, siteId, () => tx.delete(translationGroupMembers).where(inArray(translationGroupMembers.itemId, ids)));
  }
  const left = [...bySite.keys()];
  // Their sync intents go with them (design R9): none left over to swallow a later one after a rejoin;
  // intents from a leaving source to the others are no longer current.
  const ids = leaving.map((m) => m.itemId);
  for (const siteId of [...new Set([...group.siteIds, ...left])].sort()) {
    await withSiteScope(tx, siteId, async () => {
      await tx.delete(sharedFieldSyncs).where(and(eq(sharedFieldSyncs.siteId, siteId), inArray(sharedFieldSyncs.targetItemId, ids)));
      await tx
        .update(sharedFieldSyncs)
        .set({ status: 'superseded', reason: 'the source left the group', resolvedAt: new Date() })
        .where(
          and(
            eq(sharedFieldSyncs.siteId, siteId),
            inArray(sharedFieldSyncs.sourceItemId, ids),
            inArray(sharedFieldSyncs.status, ['pending', 'blocked_permission', 'blocked_hold']),
          ),
        );
    });
  }
  // Block maps with them as target or source, and their baselines (design R9).
  await dropMapsOf(tx, [...group.siteIds, ...left], ids);
  const remaining = await groupMembers(tx, group);
  const siteIds = [...new Set(remaining.map((m) => m.siteId))].sort();
  if (remaining.length === 0) {
    await withSiteScope(tx, group.siteId, () => tx.delete(translationGroups).where(eq(translationGroups.id, group.id)));
    await writeGroupEvents(tx, { ...group, siteIds: [] }, ['members'], actor, { alsoSites: left, operation: 'delete' });
    return { dissolved: true };
  }
  const set: Partial<Pick<GroupRow, 'sourceItemId' | 'siteIds' | 'xDefaultItemId'>> = { siteIds };
  if (group.sourceItemId && leaving.some((m) => m.itemId === group.sourceItemId)) set.sourceItemId = null;
  // The x-default names a member (P07 task 2.2): one leaving takes it along.
  if (group.xDefaultItemId && leaving.some((m) => m.itemId === group.xDefaultItemId)) set.xDefaultItemId = null;
  await withSiteScope(tx, group.siteId, () => bumpGroup(tx, group, set));
  const changed = ['members', ...(set.sourceItemId === null ? ['source'] : []), ...(set.xDefaultItemId === null ? ['xDefault'] : [])];
  await writeGroupEvents(tx, group, changed, actor, { alsoSites: left });
  return { dissolved: false };
}

/**
 * The site's default language changed (settings row held `FOR UPDATE`): members of the site whose
 * item has no `locale` of its own follow it, group by group in ID order under each group's lock. A
 * published one whose new language is already published in its group refuses the change (409).
 */
export async function followDefaultLocale(tx: Tx, siteId: string, actor?: OutboxActor): Promise<void> {
  const rows = await tx
    .select({ itemId: translationGroupMembers.itemId, groupId: translationGroupMembers.groupId, data: items.data, status: items.status, deletedAt: items.deletedAt })
    .from(translationGroupMembers)
    .innerJoin(items, eq(items.id, translationGroupMembers.itemId))
    .where(and(eq(translationGroupMembers.siteId, siteId), sql`coalesce(trim(${items.data}->>'locale'), '') = ''`))
    .orderBy(asc(translationGroupMembers.groupId));
  const byGroup = new Map<string, typeof rows>();
  for (const r of rows) byGroup.set(r.groupId, [...(byGroup.get(r.groupId) ?? []), r]);
  for (const [groupId, members] of byGroup) {
    const group = await lockGroup(tx, groupId);
    if (!group) continue;
    let changed = false;
    for (const r of members) {
      const member = await readMember(tx, siteId, r.itemId);
      if (!member || member.groupId !== groupId) continue;
      // A deleted member keeps its status but holds no language (only live published items do).
      const live = r.status === 'published' && r.deletedAt === null;
      changed = (await followItemLocale(tx, { group, member }, await itemLocale(tx, siteId, r.data), live)) || changed;
    }
    if (changed) await writeGroupEvents(tx, group, ['locale'], actor);
  }
}

/**
 * Lock the groups of several items of the site at once (design §0, R44): their groups in ID order,
 * then the item rows in ID order (which holds off any join or move of these items), then checks the
 * memberships again — an item that changed group meanwhile starts the whole (outermost) transaction
 * over (`MembershipChangedError`). For a transaction that writes many items: each item's own write
 * then finds its group already held, so two such transactions never take groups in opposite orders.
 * Call after the settings lock. Returns each grouped item's membership.
 */
export async function lockGroupsOf(tx: Tx, siteId: string, itemIds: string[]): Promise<Map<string, HeldMembership>> {
  const held = new Map<string, HeldMembership>();
  if (itemIds.length === 0) return held;
  const seen = await tx
    .select()
    .from(translationGroupMembers)
    .where(and(eq(translationGroupMembers.siteId, siteId), inArray(translationGroupMembers.itemId, itemIds)));
  const groups = new Map<string, GroupRow>();
  for (const groupId of [...new Set(seen.map((m) => m.groupId))].sort()) {
    const g = await lockGroup(tx, groupId);
    if (!g) throw new MembershipChangedError();
    groups.set(groupId, g);
  }
  await tx
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.siteId, siteId), inArray(items.id, itemIds)))
    .orderBy(asc(items.id))
    .for('update');
  const now = await tx
    .select()
    .from(translationGroupMembers)
    .where(and(eq(translationGroupMembers.siteId, siteId), inArray(translationGroupMembers.itemId, itemIds)));
  if (now.length !== seen.length) throw new MembershipChangedError();
  for (const m of now) {
    const group = groups.get(m.groupId);
    if (!group) throw new MembershipChangedError();
    held.set(m.itemId, { group, member: m });
  }
  return held;
}

/**
 * Take every membership of the site's items (of one collection, or all) out of their groups, group by
 * group, before the items go without passing through their own deletes (a collection or a site
 * deleted at once). The caller holds the site's settings row `FOR UPDATE` (design R46): every join
 * takes it `FOR SHARE` first, so no item of the site joins a group between this and the delete.
 */
export async function releaseMemberships(tx: Tx, siteId: string, opts: { collectionId?: string } = {}, actor?: OutboxActor): Promise<void> {
  const rows = await tx
    .select({ itemId: translationGroupMembers.itemId })
    .from(translationGroupMembers)
    .where(
      and(
        eq(translationGroupMembers.siteId, siteId),
        opts.collectionId ? eq(translationGroupMembers.collectionId, opts.collectionId) : undefined,
      ),
    );
  const held = await lockGroupsOf(tx, siteId, rows.map((r) => r.itemId));
  const byGroup = new Map<string, { group: GroupRow; members: MemberRow[] }>();
  for (const h of held.values()) {
    const entry = byGroup.get(h.group.id) ?? { group: h.group, members: [] };
    entry.members.push(h.member);
    byGroup.set(h.group.id, entry);
  }
  for (const id of [...byGroup.keys()].sort()) await onMembersRemoved(tx, byGroup.get(id)!.group, byGroup.get(id)!.members, actor);
}

/** The site's content settings row, exclusively (a collection or the site is about to go). */
export async function lockContentSettingsExclusive(tx: Tx, siteId: string): Promise<void> {
  await tx.execute(sql`SELECT 1 FROM ${siteContentSettings} WHERE ${siteContentSettings.siteId} = ${siteId} FOR UPDATE`);
}
