/**
 * Review reminders (HeoPress v1.1; spec content/review-reminders).
 *
 * A timeliness mark can carry a deadline (`needs_update_due_at`), and until this pass existed that deadline was only
 * recorded: the operator who picked the date had to remember it. This daily job is the other half — when the date
 * arrives, the people who can actually resolve the mark are told once, as a digest, instead of every day forever.
 *
 * Three deliberate choices, explained further in `openspec/specs/content/review-reminders`:
 *
 * - **The deadline is the only trigger.** An automatic staleness mark has no `due_at` and therefore never reminds: a
 *   reminder is a promise about a date, and the sweep cannot make one.
 * - **One digest per person per run**, not one notification per item: a backlog of ten due items must not turn into ten
 *   inbox rows. The digest lists up to five titles and links to the review queue, which is where items are worked.
 * - **The watermark is per item, not per person.** `needs_update_reminded_at` is reset by every mark, re-mark and clear
 *   (a new deadline deserves a new reminder) and gates the repeat interval, so an ignored item comes back after a week
 *   rather than silently disappearing or nagging daily.
 *
 * Everything runs per site inside that site's row-level-security scope. Items are **claimed first** by a guarded
 * update and only then notified, all in the **same transaction**: a failure rolls the claim back, a mark cleared or
 * re-dated in between is not claimed, and an overlapping run claims nothing left to send (so one item is never in two
 * digests). A run with nothing due writes nothing at all.
 */

import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { collections, items, userPolicies, userRoles, userSites, users, type Database } from '@heopress/database';
import { NotificationService } from '../notification-service';
import { PermissionService } from '../permission-service';
import { runItemWriteTransaction, type SiteTransaction } from '../rls-transaction';
import { allSiteIds } from '../site-scope';

/** How long an ignored reminder waits before it is repeated. */
export const DEFAULT_REMINDER_REPEAT_DAYS = 7;

/** Environment override for {@link DEFAULT_REMINDER_REPEAT_DAYS}; a non-positive or unparseable value falls back. */
export const REMINDER_REPEAT_DAYS_ENV = 'HEOPRESS_REVIEW_REMINDER_DAYS';

/** Studio's review queue (`apps/studio` route); the digest links here rather than to a single item. */
export const REVIEW_QUEUE_PATH = '/content/review-queue';

/** The digest lists this many titles, then counts the rest. */
export const DIGEST_TITLE_LIMIT = 5;

/** How many due items one site may cover in one run; a larger backlog spreads over the next runs. */
const REVIEW_REMINDER_BATCH = 200;

/** The title shown for an item, identical to the review queue's: its title, its name, or its id. */
const titleOf = sql<string>`coalesce(nullif(${items.data}->>'title', ''), nullif(${items.data}->>'name', ''), ${items.id})`;

/**
 * The threshold in days: `HEOPRESS_REVIEW_REMINDER_DAYS` when it names a positive integer, the default otherwise.
 * Same rule as the staleness threshold — the whole value must be a number, so a typo falls back instead of meaning 7.
 */
export function reminderRepeatDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env[REMINDER_REPEAT_DAYS_ENV];
  const days = Number(raw);
  return Number.isInteger(days) && days > 0 ? days : DEFAULT_REMINDER_REPEAT_DAYS;
}

/** The instant a previous reminder must be older than to justify another one at `now`. */
export function reminderCutoff(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export interface ReviewReminderDeps {
  /** The root application-role handle: each site's work runs in that site's own scope. */
  db: Database;
  /** The instant the pass runs; injectable so the due and repeat arithmetic is testable. */
  now?: Date;
  /** Repeat interval in days; defaults to `HEOPRESS_REVIEW_REMINDER_DAYS` or {@link DEFAULT_REMINDER_REPEAT_DAYS}. */
  repeatAfterDays?: number;
  /** Per-site cap on due items a single run covers; defaults to {@link REVIEW_REMINDER_BATCH}. */
  limitPerSite?: number;
}

interface ReviewReminderRecipient {
  userId: string;
  /** The notification row written for this person. */
  notificationId: string;
  /** The items the digest covered for this person (and therefore stamped). */
  itemIds: string[];
}

export interface ReviewReminderSiteResult {
  siteId: string;
  /** Items the run stamped `needs_update_reminded_at` on (the union of every digest's coverage). */
  reminded: string[];
  /** One entry per person who received a digest; empty when nothing was due or nobody could act. */
  recipients: ReviewReminderRecipient[];
}

/**
 * One review-reminder pass over every site.
 *
 * Returns what it sent, per site, so the caller can log a summary; a second run the same day returns empty arrays and
 * writes nothing (the watermark gate), and a site with nothing due is a complete no-op.
 */
export async function sendReviewReminders(deps: ReviewReminderDeps): Promise<ReviewReminderSiteResult[]> {
  const now = deps.now ?? new Date();
  const repeatDays = Math.max(1, Math.trunc(deps.repeatAfterDays ?? reminderRepeatDays()));
  const cutoff = reminderCutoff(now, repeatDays);
  const batch = Math.max(1, Math.trunc(deps.limitPerSite ?? REVIEW_REMINDER_BATCH));
  const results: ReviewReminderSiteResult[] = [];
  for (const siteId of await allSiteIds(deps.db)) {
    results.push(await runItemWriteTransaction(deps.db, siteId, (tx) => remindSite({ tx, siteId, now, cutoff, batch })));
  }
  return results;
}

/** The rows the pass may remind: marked, dated and due, not deleted, and not reminded inside the repeat interval. */
function dueForReview(siteId: string, now: Date, cutoff: Date): SQL | undefined {
  return and(
    eq(items.siteId, siteId),
    isNull(items.deletedAt),
    isNotNull(items.needsUpdateSince),
    isNotNull(items.needsUpdateDueAt),
    lte(items.needsUpdateDueAt, now),
    or(isNull(items.needsUpdateRemindedAt), lte(items.needsUpdateRemindedAt, cutoff)),
  );
}

/** A title safe to put in one notification line: collapsed whitespace, bounded, never empty. */
export function digestTitle(raw: string, fallback: string): string {
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

export interface DigestContent {
  subject: string;
  message: string;
}

/**
 * The digest for one person: up to {@link DIGEST_TITLE_LIMIT} titles, the remainder as a count, and the queue link.
 * It names the collection next to each title because a digest spans collections, and a title alone is ambiguous.
 */
export function buildDigest(entries: Array<{ title: string; collection: string; dueAt: Date }>): DigestContent {
  const total = entries.length;
  const shown = entries.slice(0, DIGEST_TITLE_LIMIT);
  const remaining = total - shown.length;
  const subject = `${total} item${total === 1 ? '' : 's'} due for review`;
  const lines = shown.map(
    (entry) => `- "${digestTitle(entry.title, 'Untitled')}" (${entry.collection}) — due ${entry.dueAt.toISOString().slice(0, 10)}`,
  );
  if (remaining > 0) lines.push(`and ${remaining} more.`);
  lines.push(`Open the review queue: ${REVIEW_QUEUE_PATH}`);
  return {
    subject,
    message: [`${total} item${total === 1 ? ' has' : 's have'} reached ${total === 1 ? 'its' : 'their'} review date:`, ...lines].join('\n'),
  };
}

type Tx = SiteTransaction;

/**
 * Every active person with a site-level grant: a primary role, an extra role, or a direct policy. `invited` and
 * `suspended` accounts cannot sign in (`middleware/auth.ts` refuses them), so they cannot act on a mark either.
 */
async function memberIds(tx: Tx, siteId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const row of await tx.selectDistinct({ userId: userSites.userId }).from(userSites).where(eq(userSites.siteId, siteId))) {
    ids.add(row.userId);
  }
  for (const row of await tx.selectDistinct({ userId: userRoles.userId }).from(userRoles).where(eq(userRoles.siteId, siteId))) {
    ids.add(row.userId);
  }
  for (const row of await tx.selectDistinct({ userId: userPolicies.userId }).from(userPolicies).where(eq(userPolicies.siteId, siteId))) {
    ids.add(row.userId);
  }
  if (ids.size === 0) return [];
  const active = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(inArray(users.id, [...ids]), eq(users.status, 'active')));
  return active.map((row) => row.id).sort();
}

async function remindSite(input: {
  tx: Tx;
  siteId: string;
  now: Date;
  cutoff: Date;
  batch: number;
}): Promise<ReviewReminderSiteResult> {
  const { tx, siteId, now, cutoff, batch } = input;
  const empty: ReviewReminderSiteResult = { siteId, reminded: [], recipients: [] };

  const due = await tx
    .select({
      id: items.id,
      collectionId: items.collectionId,
      title: titleOf,
      dueAt: items.needsUpdateDueAt,
    })
    .from(items)
    .where(dueForReview(siteId, now, cutoff))
    .orderBy(asc(items.needsUpdateDueAt), asc(items.id))
    .limit(batch);
  if (due.length === 0) return empty;

  const names = new Map(
    (await tx.select({ id: collections.id, name: collections.name }).from(collections).where(eq(collections.siteId, siteId))).map(
      (c) => [c.id, c.name] as const,
    ),
  );
  const dueIds = due.map((row) => row.id);
  const collectionsInPlay = [...new Set(due.map((row) => row.collectionId))];

  // Who can act on which of these items (row rules included). This is a read pass; the write below claims rows
  // first, so a concurrent run cannot send a second digest for an item this one already claimed.
  const candidates: Array<{ userId: string; covered: typeof due }> = [];
  for (const userId of await memberIds(tx, siteId)) {
    // The action that resolves a mark is `update` (the same one `PUT|DELETE …/timeliness` requires); an administrator
    // passes through the service's admin bypass. Building the bundle per member is why this runs once a day.
    const permissions = new PermissionService({
      db: tx,
      ctx: { userId, siteId, roleId: null, ip: null, headers: {}, principal: 'user', now },
    });
    const clauses: SQL[] = [];
    for (const collectionId of collectionsInPlay) {
      const name = names.get(collectionId);
      if (!name) continue;
      const perm = await permissions.canAccess(name, 'update');
      if (!perm) continue;
      const rule = permissions.whereFor(perm);
      clauses.push(rule ? and(eq(items.collectionId, collectionId), rule)! : eq(items.collectionId, collectionId));
    }
    if (clauses.length === 0) continue;

    // Row rules, not just the collection: a reminder must not show a title this person could not open in the queue.
    const covered = await tx
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.siteId, siteId), inArray(items.id, dueIds), or(...clauses)));
    const coveredIds = new Set(covered.map((row) => row.id));
    if (coveredIds.size === 0) continue;
    candidates.push({ userId, covered: due.filter((row) => coveredIds.has(row.id)) });
  }
  if (candidates.length === 0) return empty;

  // Claim the items first, guarded by the same predicate the read used: a mark cleared or re-dated in between no longer
  // matches, and a concurrent run that already stamped a row claims 0 of it. Only a claimed item is notified, so a
  // duplicate digest for the same item is impossible even if two passes overlap.
  const claim = [...new Set(candidates.flatMap((candidate) => candidate.covered.map((row) => row.id)))];
  const claimed = await tx
    .update(items)
    .set({ needsUpdateRemindedAt: now })
    .where(and(dueForReview(siteId, now, cutoff), inArray(items.id, claim)))
    .returning({ id: items.id });
  const claimedIds = new Set(claimed.map((row) => row.id));
  if (claimedIds.size === 0) return empty;

  // One digest per person, covering only the rows this run claimed for them.
  const notifications = new NotificationService({ db: tx, siteId });
  const recipients: ReviewReminderRecipient[] = [];
  for (const candidate of candidates) {
    const coveredRows = candidate.covered.filter((row) => claimedIds.has(row.id));
    if (coveredRows.length === 0) continue;
    const digest = buildDigest(
      coveredRows.map((row) => ({
        title: row.title,
        collection: names.get(row.collectionId) ?? row.collectionId,
        dueAt: row.dueAt!,
      })),
    );
    const notification = await notifications.create({
      recipient: candidate.userId,
      subject: digest.subject,
      message: digest.message,
      // One digest, many items and possibly many collections: naming a single one would be a lie.
      collection: null,
      item: null,
    });
    recipients.push({ userId: candidate.userId, notificationId: notification.id, itemIds: coveredRows.map((row) => row.id) });
  }

  return { siteId, reminded: [...claimedIds].sort(), recipients };
}
