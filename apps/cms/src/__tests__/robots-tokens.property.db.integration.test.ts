import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { sql } from 'drizzle-orm';
import type { Database } from '@heopress/database';
import { parseItemRobots } from '@heopress/seo-geo';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * An item's own indexing setting read the same in the database and in the code (HeoPress P07 tasks 2.8, 4.1; Codex review
 * of batch 12): `lumibase_robots_noindex` / `lumibase_robots_own_index` (migration 0090), by which the discovery scans
 * select their candidate rows, against `@heopress/seo-geo` `parseItemRobots`, by which every output decides — on values
 * made of the tokens' letters in either case, commas, ASCII and other white space.
 *
 * Failing examples are kept as regression cases below; seeds are not changed to pass.
 */

const REGRESSIONS = ['index,follow', 'Follow , INDEX', 'follow,index,index', ' , index , ', 'noindex,index', ' index', '\tindex\n', 'INDEX,NOFOLLOW', ''];

const unit = fc.constantFrom(...'indexofolwNIDEXFOLW'.split(''), ',', ',', ' ', '\t', '\n', '\v', '\f', '\r', ' ', ' ', '﻿');
const value = fc.oneof(
  fc.string({ unit, maxLength: 24 }),
  // Mostly real tokens, spelled in any case, with white space around.
  fc
    .array(fc.tuple(fc.constantFrom('index', 'noindex', 'follow', 'nofollow', 'INDEX', 'NoIndex', 'Follow', ''), fc.constantFrom('', ' ', '\t', ' ', '\r\n')), { maxLength: 4 })
    .map((parts) => parts.map(([t, ws]) => `${ws}${t}${ws}`).join(',')),
);

describe.skipIf(!hasDbIntegrationUrl)('robots tokens in the database — property', () => {
  let db: Database;
  beforeAll(async () => {
    db = await connectDbIntegration('robots-tokens');
  });

  const inDatabase = async (values: string[]) =>
    (await db.execute(sql`
      SELECT v, public.lumibase_robots_noindex(v) AS noindex, public.lumibase_robots_own_index(v) AS own
      FROM unnest(${sql`ARRAY[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::text[]`}) WITH ORDINALITY AS x(v, n) ORDER BY n`)) as unknown as Array<{ v: string; noindex: boolean; own: boolean }>;

  const agrees = async (values: string[]) => {
    const rows = await inDatabase(values);
    for (const [i, v] of values.entries()) {
      const own = parseItemRobots(v);
      expect({ v, noindex: rows[i]!.noindex, own: rows[i]!.own }).toEqual({ v, noindex: own.index === false, own: own.index === true });
    }
  };

  it('the regression cases', async () => {
    await agrees(REGRESSIONS);
    await agrees([]);
  });

  it('generated values: the database and parseItemRobots agree', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(value, { minLength: 1, maxLength: 50 }), async (values) => {
        await agrees(values);
      }),
      { numRuns: 60, seed: 20261022 },
    );
  });
});
