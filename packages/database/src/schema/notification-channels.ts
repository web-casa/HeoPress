import { sql } from 'drizzle-orm';
import { boolean, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { nanoid } from 'nanoid';
import { sites } from './core';

/**
 * Outbound notification channels (HeoPress P10 tasks 5.2, 5.5; spec agents/notifications).
 *
 * A site's administrators connect IM / webhook channels (WeCom, Feishu, DingTalk, Telegram, a signed generic
 * webhook) and pick the event kinds each one receives. The webhook URL and the signing secret / bot token are
 * credentials: both are sealed under the runtime KEK (`target_ciphertext`, AAD bound to the channel id) and never
 * returned or logged; `target_hint` keeps only the host for display.
 *
 * Messages carry a summary (title, site, Studio link) and never article text or secrets. Each send is a delivery
 * row: written in the same transaction as the event (outbox), tried at once, then retried with backoff by the
 * notification sweep until it succeeds or reaches `max_attempts`.
 */
export const notificationChannels = pgTable(
  'lumibase_notification_channels',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** `wecom` | `feishu` | `dingtalk` | `telegram` | `webhook`. */
    kind: text('kind').notNull(),
    /** Sealed JSON `{ url, secret?, chatId? }` (Telegram: `{ token, chatId }`). */
    targetCiphertext: text('target_ciphertext').notNull(),
    /** Display only: the target host, e.g. `qyapi.weixin.qq.com`. */
    targetHint: text('target_hint').notNull(),
    /** Event kinds this channel receives (`approval`, `veto`, `incident`, `budget`, `goal`, `run`). */
    events: jsonb('events').$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    /** Base of the Studio link in messages, e.g. `https://cms.example.com/console`; null: HEOPRESS_PUBLIC_URL. */
    linkBaseUrl: text('link_base_url'),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    siteNameUnique: unique('notification_channels_site_name_unique').on(t.siteId, t.name),
    siteIdUnique: unique('notification_channels_site_id_unique').on(t.siteId, t.id),
  }),
);

/** One message to one channel, with its retry state. */
export const notificationDeliveries = pgTable(
  'lumibase_notification_deliveries',
  {
    id: text('id').$defaultFn(() => nanoid()).primaryKey(),
    siteId: text('site_id')
      .notNull()
      .references(() => sites.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull(),
    /** Event kind (`approval`, `veto`, …). */
    event: text('event').notNull(),
    /** The summary only: `{ title, severity, siteName, path }` — never body text or secrets. */
    message: jsonb('message').$type<{ title: string; severity: string; siteName: string; path: string | null }>().notNull(),
    /** `pending` | `sent` | `failed`. */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(6),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
    /** Last failure, redacted: an HTTP status or an error class, never the URL or a token. */
    lastError: text('last_error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    dueIdx: index('notification_deliveries_due_idx').on(t.siteId, t.status, t.nextAttemptAt),
    // Same site only; deleting a channel removes its deliveries.
    channelFk: foreignKey({
      columns: [t.siteId, t.channelId],
      foreignColumns: [notificationChannels.siteId, notificationChannels.id],
      name: 'notification_deliveries_channel_fk',
    }).onDelete('cascade'),
  }),
);
