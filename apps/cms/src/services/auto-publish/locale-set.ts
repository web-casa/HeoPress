import { and, eq, isNull } from 'drizzle-orm';
import { autoPublishSettings, collections, items, translationGroupMembers } from '@heopress/database';
import { ItemServiceError } from '../item-service-error';
import type { SiteTransaction } from '../rls-transaction';

/**
 * The required language set of a site (HeoPress P09 task 3.7; spec ai/auto-publish "必需语言集原子发布").
 *
 * A site may name languages (`lumibase_auto_publish_settings.required_locales`) whose versions of one translation
 * group publish together and unpublish together. Only the group's members **on this site** are bound; members on other
 * sites of a cross-site group are not part of the set. Publishing or unpublishing one bound member alone is an explicit
 * exception (a person with publish permission, with a reason: `LocaleSetService`); every other single write that
 * would publish or unpublish a bound member is refused here (`REQUIRED_LOCALE_SET`).
 */

type Tx = SiteTransaction;

const norm = (l: string) => l.trim().toLowerCase();

/** The site's required languages (lower case; empty: no set). */
async function requiredLocalesOf(tx: Tx, siteId: string): Promise<string[]> {
  const [row] = await tx.select({ locales: autoPublishSettings.requiredLocales }).from(autoPublishSettings).where(eq(autoPublishSettings.siteId, siteId));
  return [...new Set((row?.locales ?? []).map(norm))];
}

export interface LocaleSetMember {
  itemId: string;
  locale: string;
  collection: string;
  status: string;
  hold: boolean;
  version: number;
}

export interface LocaleSet {
  groupId: string;
  required: string[];
  /** Same-site members whose language is required (one per language: the first by item id when there are more). */
  members: LocaleSetMember[];
  /** Required languages with no member on this site. */
  missing: string[];
}

/** The set an item belongs to, or null (no set configured, not a group member, or its language is not required). */
export async function localeSetOf(tx: Tx, siteId: string, itemId: string): Promise<LocaleSet | null> {
  const required = await requiredLocalesOf(tx, siteId);
  if (!required.length) return null;
  const [self] = await tx
    .select({ groupId: translationGroupMembers.groupId, locale: translationGroupMembers.locale })
    .from(translationGroupMembers)
    .where(and(eq(translationGroupMembers.siteId, siteId), eq(translationGroupMembers.itemId, itemId)));
  if (!self || !required.includes(norm(self.locale))) return null;
  const rows = await tx
    .select({ itemId: items.id, locale: translationGroupMembers.locale, collection: collections.name, status: items.status, hold: items.hold, version: items.version })
    .from(translationGroupMembers)
    .innerJoin(items, eq(items.id, translationGroupMembers.itemId))
    .innerJoin(collections, eq(collections.id, items.collectionId))
    .where(and(eq(translationGroupMembers.groupId, self.groupId), eq(translationGroupMembers.siteId, siteId), eq(items.siteId, siteId), isNull(items.deletedAt)))
    .orderBy(items.id);
  const byLocale = new Map<string, LocaleSetMember>();
  for (const r of rows) {
    const l = norm(r.locale);
    if (required.includes(l) && !byLocale.has(l)) byLocale.set(l, r);
  }
  return { groupId: self.groupId, required, members: [...byLocale.values()], missing: required.filter((l) => !byLocale.has(l)) };
}

/** Whether a status change makes an item public (`published` from anything else) or takes it down. */
export function publishTransition(before: string, after: string): 'publish' | 'unpublish' | null {
  if (before !== 'published' && after === 'published') return 'publish';
  if (before === 'published' && after !== 'published') return 'unpublish';
  return null;
}

/**
 * The item write guard: a single write that publishes or unpublishes a bound member is refused. Group writes and
 * exceptions (`LocaleSetService`, auto-publish) pass `localeSetWrite` to the item service instead.
 */
export async function assertNotBoundSingleWrite(tx: Tx, siteId: string, itemId: string, before: string, after: string): Promise<void> {
  const change = publishTransition(before, after);
  if (!change) return;
  const set = await localeSetOf(tx, siteId, itemId);
  if (!set) return;
  throw new ItemServiceError(
    'REQUIRED_LOCALE_SET',
    `This item is in the site's required language set (${set.required.join(', ')}): its languages ${change} together. Use the group ${change}, or a single-language exception with a reason.`,
    409,
  );
}
