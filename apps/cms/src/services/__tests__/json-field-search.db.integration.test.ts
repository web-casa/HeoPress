// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { collections, fields, scopedDatabase, sites, type Database } from '@heopress/database';
import { ItemService } from '../item-service';
import { connectDbFixtures, connectDbIntegration, hasDbIntegrationUrl } from '../../__tests__/helpers/db-harness';

/**
 * DB-backed tests for JSON field search (json-field-search Req 1, 2, 3, 7).
 * Filters into nested JSONB and uses containment / key-existence operators on
 * real Postgres. Skips without DATABASE_URL.
 *
 * **Validates: Requirements 1 (dot-path), 3 (json ops), 7 (backward compat)**
 */

const SITE = 'site_jsonsearch_it';
const COLLECTION = 'products';

describe.skipIf(!hasDbIntegrationUrl)('JSON field search — DB integration', () => {
  let db: Database;
  // The owner: test data and checks of the stored rows (row-level security binds the application role `db`).
  let fixtures: Database;

  beforeAll(async () => {
    db = await connectDbIntegration('json-field-search');
    fixtures = await connectDbFixtures('json-field-search');
  });

  afterAll(async () => {
    if (!fixtures) return;
    await fixtures.delete(sites).where(eq(sites.id, SITE)).catch(() => undefined);
  });

  let svc: ItemService;

  beforeEach(async () => {
    await fixtures.delete(sites).where(eq(sites.id, SITE));
    await fixtures.insert(sites).values({ id: SITE, name: 'JSON Search IT' });
    const collId = (await fixtures.insert(collections).values({ siteId: SITE, name: COLLECTION, label: 'Products' }).returning({ id: collections.id }))[0]!.id;
    await fixtures.insert(fields).values([
      { siteId: SITE, collectionId: collId, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE, collectionId: collId, name: 'metadata', type: 'json', interface: 'input' },
      { siteId: SITE, collectionId: collId, name: 'tags', type: 'json', interface: 'input' },
    ]);
    svc = new ItemService({ db: scopedDatabase(db, { site: SITE }), siteId: SITE });
    await svc.create(COLLECTION, { data: { title: 'A', metadata: { author: { country: 'VN' }, featured: true }, tags: ['sale', 'new'] } });
    await svc.create(COLLECTION, { data: { title: 'B', metadata: { author: { country: 'US' }, featured: false }, tags: ['clearance'] } });
    await svc.create(COLLECTION, { data: { title: 'C', metadata: { author: { country: 'VN' } }, tags: ['new'] } });
  });

  async function titles(filter: unknown): Promise<string[]> {
    const res = (await svc.list(COLLECTION, { filter: filter as never })) as unknown as { data: Array<{ data: { title: string } }> };
    return res.data.map((r) => r.data.title).sort();
  }

  it('filters by a nested dot-path (Req 1)', async () => {
    expect(await titles({ 'metadata.author.country': { _eq: 'VN' } })).toEqual(['A', 'C']);
    expect(await titles({ 'metadata.author.country': { _eq: 'US' } })).toEqual(['B']);
  });

  it('still supports top-level keys unchanged (Req 7)', async () => {
    expect(await titles({ title: { _eq: 'A' } })).toEqual(['A']);
  });

  it('_json_contains matches a nested sub-object (Req 3)', async () => {
    expect(await titles({ metadata: { _json_contains: { author: { country: 'VN' } } } })).toEqual(['A', 'C']);
  });

  it('_has_key checks key existence in a JSON object (Req 3)', async () => {
    // Only A and B have metadata.featured.
    expect(await titles({ metadata: { _has_key: 'featured' } })).toEqual(['A', 'B']);
  });

  it('_json_contains matches an array membership on tags (Req 3)', async () => {
    expect(await titles({ tags: { _json_contains: ['new'] } })).toEqual(['A', 'C']);
  });

  it('_has_any_keys / _has_all_keys check multiple keys (Req 3)', async () => {
    // metadata of A,B has author+featured; C has only author.
    expect(await titles({ metadata: { _has_any_keys: ['featured', 'missing'] } })).toEqual(['A', 'B']);
    expect(await titles({ metadata: { _has_all_keys: ['author', 'featured'] } })).toEqual(['A', 'B']);
    expect(await titles({ metadata: { _has_all_keys: ['author'] } })).toEqual(['A', 'B', 'C']);
  });

  it('rejects an injection attempt in the path (Req 6)', async () => {
    await expect(titles({ "metadata->>'x';drop table items;--": { _eq: 'x' } })).rejects.toMatchObject({ code: 'INVALID_FILTER' });
  });

  it('nested-path filters stay scoped to the site (tenant isolation, Req 7.5)', async () => {
    // A second site with a row that WOULD match the same nested filter.
    const SITE_B = `${SITE}_b`;
    await fixtures.delete(sites).where(eq(sites.id, SITE_B));
    await fixtures.insert(sites).values({ id: SITE_B, name: 'JSON Search IT B' });
    const collB = (await fixtures.insert(collections).values({ siteId: SITE_B, name: COLLECTION, label: 'P' }).returning({ id: collections.id }))[0]!.id;
    await fixtures.insert(fields).values([
      { siteId: SITE_B, collectionId: collB, name: 'title', type: 'string', interface: 'input' },
      { siteId: SITE_B, collectionId: collB, name: 'metadata', type: 'json', interface: 'input' },
    ]);
    const svcB = new ItemService({ db: scopedDatabase(db, { site: SITE_B }), siteId: SITE_B });
    await svcB.create(COLLECTION, { data: { title: 'B-LEAK', metadata: { author: { country: 'VN' } } } });

    try {
      // Site A's query returns only A/C — never site B's VN row.
      expect(await titles({ 'metadata.author.country': { _eq: 'VN' } })).toEqual(['A', 'C']);
    } finally {
      await fixtures.delete(sites).where(eq(sites.id, SITE_B)).catch(() => undefined);
    }
  });
});
