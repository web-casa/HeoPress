import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { roles, userSites, users, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import app from '../index';
import { setRuntimeFactory } from '../middleware/runtime';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, type CrossSiteFixture } from './helpers/cross-site-fixture';

/** Settings › Members (HeoPress P07a task 12.5; spec studio/settings "批量邀请"). */

const JWT_SECRET = 'member-invite-secret';

describe.skipIf(!hasDbIntegrationUrl)('inviting members', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};

  beforeAll(async () => {
    db = await connectDbIntegration('member-invite');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development' };
    const runtime = createRuntime(env);
    setRuntimeFactory(() => runtime);
  });
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'invite', jwtSecret: JWT_SECRET });
  });
  afterAll(async () => {
    setRuntimeFactory(null);
    if (fx) await fx.teardown();
  });

  const invite = async (email: string, roleId: string) =>
    app.request('/api/v1/users/invite', { method: 'POST', headers: fx.headers('a', await fx.session('adminA', 'a')), body: JSON.stringify({ email, roleId }) }, env);

  it('a new address is invited; a member is told so and keeps its role', async () => {
    const [member] = await db.insert(roles).values({ siteId: fx.sites.a, name: 'Member', adminAccess: false, appAccess: true }).returning({ id: roles.id });
    const roleOf = async (userId: string) => (await db.select({ roleId: userSites.roleId }).from(userSites).where(and(eq(userSites.siteId, fx.sites.a), eq(userSites.userId, userId))))[0]?.roleId;
    const before = await roleOf(fx.users.onlyA.id);

    const fresh = await invite('invite.newcomer@example.test', member!.id);
    expect(fresh.status, await fresh.clone().text()).toBe(200);
    expect(((await fresh.json()) as { meta: { alreadyMember: boolean }; data: { status: string } })).toMatchObject({ meta: { alreadyMember: false }, data: { status: 'invited' } });

    const again = await invite(fx.users.onlyA.email, member!.id);
    expect(((await again.json()) as { meta: { alreadyMember: boolean } }).meta.alreadyMember).toBe(true);
    expect(await roleOf(fx.users.onlyA.id)).toBe(before);
    await db.delete(users).where(eq(users.email, 'invite.newcomer@example.test'));
  });

  it('inviting a person of another site never returns their account row', async () => {
    await db.update(users).set({ passwordHash: 'scrypt$not-for-site-admins' } as never).where(eq(users.id, fx.users.onlyB.id));
    const res = await invite(fx.users.onlyB.email, (await db.select({ id: roles.id }).from(roles).where(eq(roles.siteId, fx.sites.a)))[0]!.id);
    const text = await res.text();
    expect(text).not.toContain('scrypt$');
    expect(Object.keys((JSON.parse(text) as { data: Record<string, unknown> }).data).sort()).toEqual(['email', 'id', 'status']);
  });
});
