import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { Database } from '@heopress/database';
import { runSiteTransaction, withSiteScope } from '../services/rls-transaction';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';

/**
 * `withSiteScope` (HeoPress P05, design R12): within one transaction a site
 * scope nests — leaving one restores the scope it entered from — a business
 * error still restores it, and two scopes running side by side on one
 * transaction are refused instead of restoring each other's values.
 */
describe.skipIf(!hasDbIntegrationUrl)('withSiteScope — DB integration', () => {
  let db: Database;
  let envBefore: string | undefined;
  beforeAll(async () => {
    db = await connectDbIntegration('site-scope');
  });
  beforeEach(() => {
    envBefore = process.env.HEOPRESS_ENV;
    process.env.HEOPRESS_ENV = 'test'; // scopes are set outside development
  });
  afterEach(() => {
    process.env.HEOPRESS_ENV = envBefore;
  });

  const current = async (tx: Parameters<Parameters<typeof runSiteTransaction>[2]>[0]) =>
    ((await tx.execute(sql`SELECT current_setting('app.site_id', true) AS v`)) as unknown as Array<{ v: string }>)[0]!.v;

  it('nests: A → B → C, and back to B, then A', async () => {
    const seen = await runSiteTransaction(db, 'site_a', async (tx) => {
      const trail: string[] = [await current(tx)];
      await withSiteScope(tx, 'site_b', async () => {
        trail.push(await current(tx));
        await withSiteScope(tx, 'site_c', async () => {
          trail.push(await current(tx));
        });
        trail.push(await current(tx));
      });
      trail.push(await current(tx));
      return trail;
    });
    expect(seen).toEqual(['site_a', 'site_b', 'site_c', 'site_b', 'site_a']);
  });

  it('a business error restores the outer scope; the caller can carry on in the same transaction', async () => {
    const after = await runSiteTransaction(db, 'site_a', async (tx) => {
      await withSiteScope(tx, 'site_b', async () => {
        throw new Error('not allowed');
      }).catch(() => undefined);
      return current(tx);
    });
    expect(after).toBe('site_a');
  });

  it('two scopes side by side on one transaction are refused', async () => {
    const err = await runSiteTransaction(db, 'site_a', async (tx) => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      // B enters first, C second; B leaving while C is still inside is not nesting.
      const first = withSiteScope(tx, 'site_b', () => new Promise<void>((r) => setTimeout(r, 30)));
      const second = withSiteScope(tx, 'site_c', () => gate);
      const firstOutcome = await first.then(() => null, (e: unknown) => e);
      release();
      await second.catch(() => undefined);
      return firstOutcome;
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/interleaved/);
  });
});
