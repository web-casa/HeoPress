import { sql } from 'drizzle-orm';
import { bigint, boolean, check, integer, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Maintenance mode and the write freeze (HeoPress P13 tasks 2.1, 2.3; spec ops/upgrades "升级写入冻结与数据不丢失").
 * Instance-wide system tables, no `site_id`.
 *
 * `lumibase_maintenance` is one row: while `active`, every HeoPress process refuses new writes (REST, Studio, MCP),
 * stops its schedules, queue workers and event consumers, and reports in `lumibase_maintenance_acks` once it has seen
 * the current `epoch` with nothing in flight. Only the table owner (the upgrade command) switches it: the application
 * role may read it, never write it (`ensureAppRole`).
 */
export const maintenanceState = pgTable(
  'lumibase_maintenance',
  {
    id: smallint('id').primaryKey().default(1),
    active: boolean('active').notNull().default(false),
    /** Bumped on every switch: an acknowledgement is for one epoch. */
    epoch: bigint('epoch', { mode: 'number' }).notNull().default(0),
    /** `upgrade`, or another operator reason. */
    reason: text('reason'),
    upgradeId: text('upgrade_id'),
    fromVersion: text('from_version'),
    toVersion: text('to_version'),
    /** The upgrade step under way (shown in Studio). */
    step: text('step'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    singleton: check('maintenance_singleton', sql`${t.id} = 1`),
  }),
);

/** One row per running HeoPress process: the last maintenance epoch it saw and whether it has drained. */
export const maintenanceAcks = pgTable('lumibase_maintenance_acks', {
  processId: text('process_id').primaryKey(),
  /** `web`, `worker` or `all`. */
  processRole: text('process_role').notNull(),
  epoch: bigint('epoch', { mode: 'number' }).notNull(),
  /** The process refuses writes and has paused its workers for `epoch`. */
  frozen: boolean('frozen').notNull(),
  /** Writes (requests, scheduled runs, queue jobs, consumer passes) still running. */
  inflight: integer('inflight').notNull(),
  seenAt: timestamp('seen_at', { withTimezone: true }).defaultNow().notNull(),
});
