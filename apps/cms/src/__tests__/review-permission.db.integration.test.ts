import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiKeyRoles, apiKeys, collections, items, permissions, policies, rolePolicies, roles, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { createPlaintextToken } from '../services/api-key-token';
import { EditorialService } from '../services/editorial-service';
import { PermissionService } from '../services/permission-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * The `review` permission and the human review gate (HeoPress P07a tasks 5.1, 5.2; spec studio/review-workspace,
 * design §14): approving and rejecting need `review` on the collection and a person — an API key of any scope (and so
 * an agent or MCP client) is refused before permissions are looked at; the queue lists only reviewable items.
 */

const JWT_SECRET = 'review-permission-secret';

describe.skipIf(!hasDbIntegrationUrl)('review permission — HTTP', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let adminKey = '';
  let runtime: ReturnType<typeof createRuntime>;

  beforeAll(async () => {
    db = await connectDbIntegration('review-permission');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'revperm', jwtSecret: JWT_SECRET });
    const site = fx.sites.a;
    await db.update(collections).set({ meta: { editorialWorkflow: true } }).where(and(eq(collections.siteId, site), eq(collections.name, SHARED.collection)));
    // An API key with the administrator role: full permissions, still not a person.
    const token = await createPlaintextToken();
    const [key] = await db.insert(apiKeys).values({ siteId: site, name: 'revperm admin key', prefix: token.prefix, tokenHash: token.tokenHash }).returning({ id: apiKeys.id });
    const [adminRole] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, site), eq(roles.name, 'Administrator')));
    await db.insert(apiKeyRoles).values({ apiKeyId: key!.id, siteId: site, roleId: adminRole!.id });
    adminKey = token.token;
    await new EditorialService({ db, siteId: site, userId: fx.users.onlyA.id }).submitReview(SHARED.collection, fx.items.a, {});
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const post = (verb: 'approve' | 'reject', bearer: string) =>
    app.request(`/api/v1/editorial/${SHARED.collection}/${fx.items.a}/${verb}`, { method: 'POST', headers: fx.headers('a', bearer), body: JSON.stringify({ reason: 'checked' }) }, env);
  const state = async () => (await db.select({ s: items.editorialState }).from(items).where(eq(items.id, fx.items.a)))[0]?.s;
  const queue = async (bearer: string) =>
    ((await (await app.request('/api/v1/editorial/reviews', { headers: fx.headers('a', bearer) }, env)).json()) as { data: Array<{ itemId: string }> }).data;

  it('task 5.1: an administrator holds review; an editor without the grant does not', async () => {
    const perms = (userId: string) => new PermissionService({ db, ctx: { userId, siteId: fx.sites.a, roleId: null } as never });
    expect(await perms(fx.users.adminA.id).canAccess(SHARED.collection, 'review')).toBeTruthy();
    expect(await perms(fx.users.onlyA.id).canAccess(SHARED.collection, 'review')).toBeNull();
  });

  it('task 5.2: an author without review, an administrator-scope API key and an editor key are refused; the state is unchanged', async () => {
    for (const verb of ['approve', 'reject'] as const) {
      const author = await post(verb, await fx.session('onlyA', 'a'));
      expect(author.status).toBe(403);
      expect(((await author.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('FORBIDDEN');
      for (const key of [adminKey, fx.apiKeys.aEditor.token]) {
        const res = await post(verb, key);
        expect(res.status).toBe(403);
        expect(((await res.json()) as { errors: Array<{ code: string }> }).errors[0]!.code).toBe('HUMAN_REVIEW_REQUIRED');
      }
    }
    expect(await state()).toBe('in_review');
  });

  it('task 5.2: the queue lists only reviewable items; an administrator approves', async () => {
    expect(await queue(await fx.session('onlyA', 'a'))).toEqual([]);
    expect((await queue(await fx.session('adminA', 'a'))).map((r) => r.itemId)).toEqual([fx.items.a]);
    const res = await post('approve', await fx.session('adminA', 'a'));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await state()).toBe('approved');
  });

  it('task 5.1: granting review to the editor role lets its members decide', async () => {
    const site = fx.sites.a;
    const [policy] = await db.insert(policies).values({ siteId: site, name: 'Reviewer', key: 'revperm-reviewer', adminAccess: false, appAccess: true }).returning({ id: policies.id });
    await db.insert(permissions).values({ siteId: site, policyId: policy!.id, collection: SHARED.collection, action: 'review', fields: ['*'] });
    const [editorRole] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, site), eq(roles.name, 'Editor')));
    await db.insert(rolePolicies).values({ roleId: editorRole!.id, policyId: policy!.id });
    // As the policy routes do after a change.
    await PermissionService.bumpVersion(runtime.cache, site);
    expect((await queue(await fx.session('onlyA', 'a'))).map((r) => r.itemId)).toEqual([fx.items.a]);
    const res = await post('reject', await fx.session('onlyA', 'a'));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await state()).toBe('rejected');
  });
});
