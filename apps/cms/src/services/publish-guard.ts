/**
 * The one publish guard (HeoPress P04, spec content/write-concurrency
 * "Hold 阻止所有发布路径").
 *
 * Every path that can make content public goes through here: manual saves,
 * bulk publishes, Releases and agents (all through `ItemService.patch`),
 * scheduled publishing (the scheduler's conditional UPDATE, which also carries
 * `hold = false` in SQL), and later publish paths (P09 auto-publish) — they
 * call `assertPublishAllowed` before writing. `publish-guard.test.ts` holds the
 * contract, and a source scan there fails when code outside the known paths
 * writes `status: 'published'` to items.
 */
import { ItemServiceError } from './item-service-error';

/** What the guard needs to know about the item as it is now. */
export interface PublishSubject {
  status: string;
  hold: boolean;
}

/** What the write would do. */
export interface PublishIntent {
  /** The item's status after the write. */
  nextStatus: string;
  /** Whether the write changes the item's content (data). */
  changesContent: boolean;
}

/**
 * A write publishes when the item ends up published and either was not
 * published before, or its live content changes. Both make something public
 * that was not public.
 */
export function isPublishWrite(subject: PublishSubject, intent: PublishIntent): boolean {
  if (intent.nextStatus !== 'published') return false;
  return subject.status !== 'published' || intent.changesContent;
}

export const ITEM_HELD = 'ITEM_HELD';

/** Throws ITEM_HELD (409) when the write would publish a held item. */
export function assertPublishAllowed(subject: PublishSubject, intent: PublishIntent): void {
  if (subject.hold && isPublishWrite(subject, intent)) {
    throw new ItemServiceError(
      ITEM_HELD,
      'This item is on hold: it cannot be published until a person with publish permission releases the hold.',
      409,
    );
  }
}
