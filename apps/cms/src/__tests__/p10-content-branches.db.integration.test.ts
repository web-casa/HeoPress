import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { collections, fields, items, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { AgentAccessService } from '../services/agent-access/agent-access-service';
import { ItemService } from '../services/item-service';
import { __resetPermissionProcessCacheForTests } from '../services/permission-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * HeoPress P10 tasks 4.1, 4.3, 4.4 (spec agents/content-branches) against the real database: agents edit in a branch
 * through MCP, field- and block-level diff, merge conflicts on the same block vs automatic merge of different blocks,
 * the atomic check of both versions (a change after the comparison is a conflict), and a merge that only produces a
 * pending revision — never live, never past Hold.
 */

const JWT_SECRET = 'p10-branches-secret';
const BASE = 'https://cms.example.com';
const MCP = `${BASE}/api/v1/agents/mcp`;

const para = (id: string, text: string) => `<p data-block-id="${id}">${text}</p>`;
const body = (texts: string[]) => texts.map((t, i) => para(`p${i + 1}`, t)).join('');
const FIVE = ['One', 'Two', 'Three', 'Four', 'Five'];

describe.skipIf(!hasDbIntegrationUrl)('P10 content branches — DB integration', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('p10-content-branches');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development', HEOPRESS_PUBLIC_URL: BASE, HEOPRESS_API_RATE_LIMIT: '100000' };
    setRuntimeFactory(() => createRuntime(env));
  });
  afterAll(() => setRuntimeFactory(null));
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'p10br', jwtSecret: JWT_SECRET });
    __resetPermissionProcessCacheForTests();
    const [coll] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.siteId, fx.sites.a), eq(collections.name, SHARED.collection)));
    await db.insert(fields).values({ siteId: fx.sites.a, collectionId: coll!.id, name: 'body', type: 'text', interface: 'wysiwyg' });
    await db.update(items).set({ data: { title: 'Hello from A', slug: SHARED.slug, path: SHARED.path, body: body(FIVE) } }).where(eq(items.id, fx.items.a));
  });
  afterEach(async () => {
    await db.execute(sql`DELETE FROM lumibase_agent_grants WHERE user_id LIKE 'usr_p10br_%'`);
    if (fx) await fx.teardown();
  });

  const itemRow = async () => (await db.select({ data: items.data, version: items.version, status: items.status }).from(items).where(eq(items.id, fx.items.a)))[0]!;
  const mainEdit = async (data: Record<string, unknown>) => {
    const row = await itemRow();
    await new ItemService({ db, siteId: fx.sites.a }).patch(SHARED.collection, fx.items.a, { data, expectedVersion: row.version });
  };

  async function token(groups = ['read', 'content']) {
    return (await new AgentAccessService({ db, jwtSecret: JWT_SECRET }).createPersonalToken(fx.users.adminA.id, { name: 'branches', siteIds: [fx.sites.a], toolGroups: groups }, MCP)).token;
  }

  async function rpc(bearer: string, name: string, args: Record<string, unknown>) {
    const res = await app.request(
      MCP,
      { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) },
      env,
    );
    const out = (await res.json()) as { result?: { structuredContent?: Record<string, unknown>; isError?: boolean } };
    return { status: res.status, isError: out.result?.isError ?? false, value: (out.result?.structuredContent ?? {}) as Record<string, unknown> & { code?: string; data?: Record<string, unknown> } };
  }

  const at = (extra: Record<string, unknown> = {}) => ({ siteId: fx.sites.a, collection: SHARED.collection, id: fx.items.a, ...extra });

  async function rest(method: string, path: string, json?: unknown, user: 'onlyA' | 'both' = 'onlyA', site: 'a' | 'b' = 'a') {
    const res = await app.request(
      `${BASE}/api/v1/items/${SHARED.collection}/${fx.items.a}/versions${path}`,
      { method, headers: fx.headers(site, await fx.session(user, site)), body: json === undefined ? undefined : JSON.stringify(json) },
      env,
    );
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as { data?: Record<string, unknown> & { [k: string]: unknown }; errors?: Array<{ code: string; meta?: Record<string, unknown> }> } };
  }

  /** An agent's branch with `para` paragraphs changed (by index). */
  async function agentBranch(bearer: string, changes: Record<number, string>) {
    const created = await rpc(bearer, 'branch_create', at({ name: 'Agent rewrite', idempotencyKey: `k-${Object.keys(changes).join('-')}` }));
    expect(created.isError, JSON.stringify(created.value)).toBe(false);
    const branch = created.value.data as { key: string; revision: number };
    const texts = [...FIVE];
    for (const [i, t] of Object.entries(changes)) texts[Number(i)] = t;
    const updated = await rpc(bearer, 'branch_update', at({ branch: branch.key, expectedVersion: branch.revision, data: { body: body(texts) } }));
    expect(updated.isError, JSON.stringify(updated.value)).toBe(false);
    return { key: branch.key, revision: (updated.value.data as { revision: number }).revision };
  }

  it('task 4.1: an agent edits a branch through MCP (idempotent create, versioned writes) and reads a field- and block-level diff; the item is untouched', async () => {
    const t = await token();
    const before = await itemRow();
    const first = await rpc(t, 'branch_create', at({ name: 'Rewrite', idempotencyKey: 'same-key' }));
    const again = await rpc(t, 'branch_create', at({ name: 'Rewrite', idempotencyKey: 'same-key' }));
    const b = first.value.data as { key: string; revision: number; baseVersion: number; state: string };
    expect(b).toMatchObject({ revision: 1, baseVersion: before.version, state: 'open' });
    expect((again.value.data as { key: string }).key).toBe(b.key);
    expect(again.value.replayed).toBe(true);
    expect((await rpc(t, 'branch_create', at({ name: 'Other', idempotencyKey: 'same-key' }))).value.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // A write needs the revision read; a stale one is a conflict.
    expect((await rpc(t, 'branch_update', at({ branch: b.key, data: { title: 'x' } }))).value.code).toBe('VERSION_REQUIRED');
    const ok = await rpc(t, 'branch_update', at({ branch: b.key, expectedVersion: 1, data: { title: 'New title', body: body(['One', 'Two (agent)', 'Three', 'Four', 'Five']) } }));
    expect((ok.value.data as { revision: number }).revision).toBe(2);
    const stale = await rpc(t, 'branch_update', at({ branch: b.key, expectedVersion: 1, data: { title: 'late' } }));
    expect(stale.value.code).toBe('BRANCH_STALE');

    const diff = (await rpc(t, 'branch_diff', at({ branch: b.key }))).value.data as {
      revision: number;
      mainVersion: number;
      branch: Array<{ field: string; kind: string; blocks?: Array<{ blockId: string; kind: string; before: string; after: string }> }>;
      main: unknown[];
      merge: { clean: boolean };
    };
    expect(diff).toMatchObject({ revision: 2, mainVersion: before.version, main: [], merge: { clean: true } });
    expect(diff.branch.map((c) => c.field).sort()).toEqual(['body', 'title']);
    const blocks = diff.branch.find((c) => c.field === 'body')!.blocks!;
    expect(blocks).toEqual([{ blockId: 'p2', kind: 'changed', before: para('p2', 'Two'), after: para('p2', 'Two (agent)') }]);

    // The item did not change.
    const after = await itemRow();
    expect(after.version).toBe(before.version);
    expect(after.data).toEqual(before.data);

    // A reader may not branch: live RBAC on the REST path the tool uses.
    expect((await rest('POST', '', { key: 'r', name: 'r' }, 'both', 'b')).status).toBe(403);
  });

  it('task 4.3: the same paragraph changed on both sides fails the merge with both versions; a person chooses', async () => {
    const t = await token();
    const branch = await agentBranch(t, { 1: 'Two (branch)' });
    await mainEdit({ body: body(['One', 'Two (main)', 'Three', 'Four', 'Five']) });
    const { version: mainVersion } = await itemRow();

    const diff = (await rest('GET', `/${branch.key}/diff`)).body.data as { merge: { clean: boolean; conflicts: Array<{ id: string }> } };
    expect(diff.merge.clean).toBe(false);

    const failed = await rpc(t, 'branch_merge', at({ branch: branch.key, expectedVersion: branch.revision, expectedMainVersion: mainVersion }));
    expect(failed.value.code).toBe('MERGE_CONFLICT');
    const conflicts = (failed.value.errors as Array<{ meta: { conflicts: Array<Record<string, unknown>> } }>)[0]!.meta.conflicts;
    expect(conflicts).toEqual([{ id: 'body#p2', field: 'body', kind: 'block', blockId: 'p2', base: para('p2', 'Two'), main: para('p2', 'Two (main)'), branch: para('p2', 'Two (branch)') }]);
    // Nothing was written.
    expect(((await rest('GET', `/${branch.key}`)).body.data as { state: string; revision: number })).toMatchObject({ state: 'open', revision: branch.revision });

    // The person keeps the branch's paragraph.
    const merged = await rest('POST', `/${branch.key}/merge`, { expectedMainVersion: mainVersion, expectedRevision: branch.revision, resolutions: { 'body#p2': 'branch' } });
    expect(merged.status).toBe(200);
    expect((merged.body.data!.branch as { data: { body: string }; state: string }).data.body).toBe(body(['One', 'Two (branch)', 'Three', 'Four', 'Five']));
    expect((await itemRow()).data).toMatchObject({ body: body(['One', 'Two (main)', 'Three', 'Four', 'Five']) });
  });

  it('task 4.3: different paragraphs merge automatically; the result holds both, and is promoted only by a person onto that main version', async () => {
    const t = await token();
    const branch = await agentBranch(t, { 1: 'Two (branch)' });
    await mainEdit({ body: body(['One', 'Two', 'Three', 'Four', 'Five (main)']) });
    const { version: mainVersion } = await itemRow();

    const merged = await rpc(t, 'branch_merge', at({ branch: branch.key, expectedVersion: branch.revision, expectedMainVersion: mainVersion }));
    expect(merged.isError, JSON.stringify(merged.value)).toBe(false);
    const result = merged.value.data as { branch: { data: { body: string }; state: string; baseVersion: number }; promote: { expectedVersion: number } };
    const both = body(['One', 'Two (branch)', 'Three', 'Four', 'Five (main)']);
    expect(result.branch).toMatchObject({ state: 'merged', baseVersion: mainVersion, data: { body: both } });
    expect(result.promote.expectedVersion).toBe(mainVersion);

    // A pending revision: the item is unchanged until a person promotes it.
    expect((await itemRow()).version).toBe(mainVersion);
    // No tool promotes.
    expect((await rpc(t, 'branch_promote', at({ branch: branch.key }))).value.code).toBe('UNKNOWN_TOOL');
    const promoted = await rest('POST', `/${branch.key}/promote`, { expectedVersion: mainVersion });
    expect(promoted.status).toBe(200);
    expect((await itemRow()).data).toMatchObject({ body: both });
  });

  it('task 4.4: main changed after the comparison → the merge is a conflict and nothing is overwritten; a merged branch never lands on a newer main', async () => {
    const t = await token();
    const branch = await agentBranch(t, { 1: 'Two (branch)' });
    const compared = (await rest('GET', `/${branch.key}/diff`)).body.data as { mainVersion: number; revision: number };
    await mainEdit({ title: 'Changed meanwhile' });

    const stale = await rest('POST', `/${branch.key}/merge`, { expectedMainVersion: compared.mainVersion, expectedRevision: compared.revision });
    expect(stale.status).toBe(409);
    expect(stale.body.errors![0]!.code).toBe('MERGE_STALE');
    expect(((await rest('GET', `/${branch.key}`)).body.data as { state: string }).state).toBe('open');
    expect((await itemRow()).data).toMatchObject({ title: 'Changed meanwhile', body: body(FIVE) });

    // A branch changed after the comparison is stale too.
    const now = (await rest('GET', `/${branch.key}/diff`)).body.data as { mainVersion: number; revision: number };
    await rpc(t, 'branch_update', at({ branch: branch.key, expectedVersion: now.revision, data: { slug: 'moved' } }));
    expect((await rest('POST', `/${branch.key}/merge`, { expectedMainVersion: now.mainVersion, expectedRevision: now.revision })).body.errors![0]!.code).toBe('MERGE_STALE');

    // Merged, then main moves on: promoting refuses (merge again), the newer main stays.
    const fresh = (await rest('GET', `/${branch.key}/diff`)).body.data as { mainVersion: number; revision: number };
    expect((await rest('POST', `/${branch.key}/merge`, { expectedMainVersion: fresh.mainVersion, expectedRevision: fresh.revision })).status).toBe(200);
    await mainEdit({ title: 'Even newer' });
    const latest = (await itemRow()).version;
    const refused = await rest('POST', `/${branch.key}/promote`, { expectedVersion: latest });
    expect(refused.status).toBe(409);
    expect(refused.body.errors![0]!.code).toBe('BRANCH_STALE');
    expect((await itemRow()).data).toMatchObject({ title: 'Even newer' });

    // An open branch whose main moved on is never promoted over a change to the same field.
    const other = await agentBranch(t, { 0: 'One (branch)' });
    await mainEdit({ body: body(['One (main)', 'Two', 'Three', 'Four', 'Five']) });
    const over = await rest('POST', `/${other.key}/promote`, { expectedVersion: (await itemRow()).version });
    expect(over.status).toBe(409);
    expect(over.body.errors![0]!.code).toBe('MERGE_CONFLICT');
  });

  it('task 4.4: merging a published item on hold leaves the live item as it is; promoting is refused by Hold', async () => {
    const t = await token();
    const branch = await agentBranch(t, { 2: 'Three (branch)' });
    await db.update(items).set({ status: 'published', publishedAt: new Date(), hold: true }).where(eq(items.id, fx.items.a));
    const live = await itemRow();

    const merged = await rpc(t, 'branch_merge', at({ branch: branch.key, expectedVersion: branch.revision, expectedMainVersion: live.version }));
    expect(merged.isError, JSON.stringify(merged.value)).toBe(false);
    const after = await itemRow();
    expect(after).toEqual(live);

    const promoted = await rest('POST', `/${branch.key}/promote`, { expectedVersion: live.version });
    expect(promoted.status).toBe(409);
    expect(promoted.body.errors![0]!.code).toBe('ITEM_HELD');
    expect(await itemRow()).toEqual(live);
  });
});
