import { boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Git snapshots of published content (HeoPress P11 tasks 2.1–2.7, spec publishing/git-snapshots, ADR-0006, ADR-0013).
 * The database stays the authority; the content repository is a readable copy of what is published.
 *
 *   - `lumibase_git_snapshot_repos`: a site's content repository (remote, branch, the commit identity) with its
 *     credential sealed (AES-GCM bound to the site and field; never returned, only a masked hint), and the state of
 *     its last pass (lease, last pushed commit, last error, last reconciliation report).
 *   - `lumibase_git_snapshot_queue`: change events waiting for the site's next pass (one row per event id: an event
 *     delivered twice is queued once); due 30 seconds after the event, so a burst becomes one commit. Rows are
 *     deleted only once the pass's commit is pushed (or there was nothing to commit): a remote that is down keeps them.
 *   - `lumibase_git_snapshot_files`: the files the last pushed commit holds for the site, with their content hashes —
 *     what the next pass compares with to find files to clean up and files changed by hand in the repository.
 */
export const gitSnapshotRepos = pgTable('lumibase_git_snapshot_repos', {
  siteId: text('site_id')
    .primaryKey()
    .references(() => sites.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').default(false).notNull(),
  remoteUrl: text('remote_url').notNull(),
  branch: text('branch').default('main').notNull(),
  /** HTTPS user name sent with the token (`x-access-token` when unset). */
  username: text('username'),
  /** The sealed access token (`CryptoService`, AAD = site + field); null: none. */
  credentialEncrypted: text('credential_encrypted'),
  /** The token's last four characters, for display. */
  credentialHint: text('credential_hint'),
  authorName: text('author_name').default('HeoPress').notNull(),
  authorEmail: text('author_email').default('snapshots@heopress.invalid').notNull(),
  version: integer('version').default(1).notNull(),
  /** One worker at a time works on the site's repository. */
  leasedUntil: timestamp('leased_until', { withTimezone: true }),
  leaseToken: text('lease_token'),
  lastCommitSha: text('last_commit_sha'),
  lastPushedAt: timestamp('last_pushed_at', { withTimezone: true }),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  /** `pushed` | `nothing` | `failed` | `off`. */
  lastStatus: text('last_status'),
  /** Redacted, at most 500 characters. */
  lastError: text('last_error'),
  lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
  lastReport: jsonb('last_report').$type<Record<string, unknown>>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const gitSnapshotQueue = pgTable(
  'lumibase_git_snapshot_queue',
  {
    id: text('id').primaryKey().$defaultFn(() => nanoid()),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    /** `event:<change event id>` or `reconcile:<site>:<day>` (the daily reconciliation). */
    eventId: text('event_id').notNull(),
    /** Who caused it, by kind only (`user`, `agent`, `system`…): commit messages never carry user ids (ADR-0013). */
    actorType: text('actor_type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    leasedUntil: timestamp('leased_until', { withTimezone: true }),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    eventId: uniqueIndex('git_snapshot_queue_event').on(t.eventId),
    due: index('git_snapshot_queue_due').on(t.dueAt),
  }),
);

export const gitSnapshotFiles = pgTable(
  'lumibase_git_snapshot_files',
  {
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    /** The item a content file holds; null for the site's configuration and theme files. */
    itemId: text('item_id'),
    /** SHA-256 of the file's bytes. */
    contentHash: text('content_hash').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.siteId, t.path] }) }),
);
