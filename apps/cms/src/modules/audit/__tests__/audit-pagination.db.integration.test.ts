import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { scopedDatabase, sites, type Database } from '@heopress/database';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';
import { auditExportLines, decodeCursor, queryAuditLog } from '../routes';

/**
 * Audit log pages and exports hold every row exactly once (HeoPress P14 tasks
 * 3.1–3.2; spec ops/audit-log "审计日志翻页完整", design D3). The cursor is a
 * millisecond ISO timestamp; with a microsecond column, rows later in the
 * same millisecond than the cursor (e.g. `.000300` against a cursor of
 * `.000`) were neither before nor equal to it and were skipped.
 *
 * Rows are written with explicit sub-millisecond timestamps, as `now()` does
 * when several land in one millisecond, through the owner's fixtures
 * connection; the queries run as the application role on the site's scoped
 * handle (HeoPress P14 task 1.4).
 */

const SITE = 'site_audit_pagination_it';

/** Five records in one millisecond, two in the next. */
const SAME_MS = ['000100', '000200', '000300', '000400', '000450'].map((us) => `2026-03-01 12:00:00.${us}`);
const NEXT_MS = ['001100', '001200'].map((us) => `2026-03-01 12:00:00.${us}`);

describe.skipIf(!hasDbIntegrationUrl)('audit log pagination and export — DB integration', () => {
  let db: Database;
  let fixtures: Database;

  beforeAll(async () => {
    db = scopedDatabase(await connectDbIntegration('audit-pagination'), { site: SITE });
    fixtures = await connectDbFixtures('audit-pagination');
  });
  afterAll(async () => {
    await fixtures?.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  async function write(timestamps: string[], prefix: string): Promise<string[]> {
    const ids: string[] = [];
    for (const [i, ts] of timestamps.entries()) {
      const id = `${prefix}_${i}`;
      await fixtures.execute(sql`
        INSERT INTO lumibase_audit_log (id, timestamp, site_id, event, metadata)
        VALUES (${id}, ${ts}::timestamp, ${SITE}, 'login_success', '{}'::jsonb)`);
      ids.push(id);
    }
    return ids;
  }

  let all: string[] = [];
  beforeEach(async () => {
    await fixtures.delete(sites).where(eq(sites.id, SITE));
    await fixtures.insert(sites).values({ id: SITE, name: 'Audit pagination IT' });
    all = [...(await write(SAME_MS, 'same')), ...(await write(NEXT_MS, 'next'))];
  });

  /** Every page of `limit` rows, following `nextCursor` as a client does (through its string form). */
  async function everyPage(limit: number): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const decoded = cursor ? decodeCursor(cursor) : undefined;
      expect(decoded).not.toBeNull();
      const res = await queryAuditLog(db, { siteId: SITE, limit, ...(decoded ? { cursor: decoded } : {}) });
      seen.push(...res.items.map((e) => e.id));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return seen;
  }

  it('five records in one millisecond, two per page: every record exactly once', async () => {
    const seen = await everyPage(2);
    expect([...seen].sort()).toEqual([...all].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('an export whose batch boundaries fall inside a millisecond: every record exactly once', async () => {
    const lines: string[] = [];
    for await (const line of auditExportLines(db, { siteId: SITE }, { batchSize: 2 })) lines.push(line);
    const seen = lines.map((l) => (JSON.parse(l) as { id: string }).id);
    expect([...seen].sort()).toEqual([...all].sort());
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('newest first: the next millisecond, then the earlier one', async () => {
    const seen = await everyPage(100);
    expect(seen.slice(0, NEXT_MS.length).every((id) => id.startsWith('next_'))).toBe(true);
    expect(seen.slice(NEXT_MS.length).every((id) => id.startsWith('same_'))).toBe(true);
  });
});
