// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Sliding-window failure counters for the Login Guard.
 *
 * Postgres-backed reads from `login_attempts` (HeoPress P03 removed the
 * optional Redis counters: the durable table is the only source, so a cache
 * outage or restart can never reset a lockout budget).
 */

import { and, eq, gte, sql } from 'drizzle-orm';
import { loginAttempts, type Database } from '@heopress/database';

import { normalizeEmail } from './email-normalize';

export interface CounterStore {
  userFailedCount(email: string, windowSeconds: number): Promise<number>;
  ipFailedCount(ip: string, windowSeconds: number): Promise<number>;
}

export class PostgresCounterStore implements CounterStore {
  constructor(private readonly db: Database) {}

  async userFailedCount(email: string, windowSeconds: number): Promise<number> {
    const emailLower = normalizeEmail(email);
    if (emailLower.length === 0) return 0;

    const window = clampWindowSeconds(windowSeconds);
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.emailLower, emailLower),
          eq(loginAttempts.result, 'fail'),
          gte(
            loginAttempts.createdAt,
            sql`now() - (${String(window)} || ' seconds')::interval`,
          ),
        ),
      );
    return rows[0]?.count ?? 0;
  }

  async ipFailedCount(ip: string, windowSeconds: number): Promise<number> {
    const trimmedIp = (ip ?? '').trim();
    if (trimmedIp.length === 0) return 0;

    const window = clampWindowSeconds(windowSeconds);
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(loginAttempts)
      .where(
        and(
          eq(loginAttempts.ip, trimmedIp),
          eq(loginAttempts.result, 'fail'),
          gte(
            loginAttempts.createdAt,
            sql`now() - (${String(window)} || ' seconds')::interval`,
          ),
        ),
      );
    return rows[0]?.count ?? 0;
  }
}

export function userFailedCount(
  db: Database,
  email: string,
  windowSeconds: number,
): Promise<number> {
  return new PostgresCounterStore(db).userFailedCount(email, windowSeconds);
}

export function ipFailedCount(
  db: Database,
  ip: string,
  windowSeconds: number,
): Promise<number> {
  return new PostgresCounterStore(db).ipFailedCount(ip, windowSeconds);
}

export function createCounterStore(db: Database): CounterStore {
  return new PostgresCounterStore(db);
}

function clampWindowSeconds(input: number): number {
  if (!Number.isFinite(input)) return 1;
  const floored = Math.floor(input);
  return floored >= 1 ? floored : 1;
}
