import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Database } from '@heopress/database';
import { assertSupportedPostgres, PreflightError, type PreflightQuery } from '../config/preflight';
import { connectDbIntegration, dbIntegrationUrl, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * PostgreSQL version preflight against real servers (P01 `platform/runtime-baseline`).
 *
 * - The integration database (`DATABASE_URL`, PostgreSQL 18 in CI) must pass.
 * - A PostgreSQL 17 server, provided through `HEOPRESS_TEST_PG17_URL`, must be
 *   refused with the required version in the message. CI runs a postgres:17
 *   service for this; without the variable that block is reported as skipped.
 */

const pg17Url = process.env.HEOPRESS_TEST_PG17_URL?.trim() || undefined;

describe.skipIf(!hasDbIntegrationUrl)('PostgreSQL version preflight — supported server', () => {
  let harnessDb: Database | undefined;
  let sql: Sql | undefined;

  beforeAll(async () => {
    harnessDb = await connectDbIntegration('startup-postgres-version');
    sql = postgres(dbIntegrationUrl!, { max: 1 });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    await (harnessDb as unknown as { $client?: { end?: () => Promise<void> } } | undefined)?.$client?.end?.();
  });

  it('accepts the integration server (PostgreSQL 18)', async () => {
    const { versionNum } = await assertSupportedPostgres(sql as unknown as PreflightQuery);
    expect(Math.floor(versionNum / 10_000)).toBeGreaterThanOrEqual(18);
  });
});

describe.skipIf(!hasDbIntegrationUrl || !pg17Url)('PostgreSQL version preflight — PostgreSQL 17', () => {
  let harnessDb: Database | undefined;
  let sql: Sql | undefined;

  beforeAll(async () => {
    harnessDb = await connectDbIntegration('startup-postgres-version-pg17');
    sql = postgres(pg17Url!, { max: 1, connect_timeout: 5 });
    // Fail loudly if the PostgreSQL 17 server was requested but is not reachable.
    await sql`SELECT 1`;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    await (harnessDb as unknown as { $client?: { end?: () => Promise<void> } } | undefined)?.$client?.end?.();
  });

  it('refuses PostgreSQL 17 and names the required version', async () => {
    const check = assertSupportedPostgres(sql as unknown as PreflightQuery, { connectTimeoutMs: 0 });
    await expect(check).rejects.toBeInstanceOf(PreflightError);
    await expect(assertSupportedPostgres(sql as unknown as PreflightQuery, { connectTimeoutMs: 0 })).rejects.toThrow('需要 PostgreSQL >= 18');
  });
});
