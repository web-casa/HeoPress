import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { auditLog, sites, type Database } from '@heopress/database';
import { EnvKeyProvider } from '@heopress/runtime';
import { DeploymentService } from '../deployment-service';
import { registerProvider, type DeploymentProvider } from '../providers';
import { connectDbIntegration, hasDbIntegrationUrl } from '../../../__tests__/helpers/db-harness';

/**
 * Secret boundary for configured endpoints and credentials (P03 task 4.4,
 * spec platform/outbound-security "权限与秘密边界", scenario "跨站调用模型配置").
 *
 * A deployment target holds a provider token. A service bound to site A,
 * pointed at site B's target in every way the API allows, must behave as if
 * the target did not exist — and the token must appear in no response, error
 * or audit entry. (Who may change these configs at all — site admins only —
 * is enforced by `requireSiteAdmin`, see middleware/__tests__/site-admin.test.ts.)
 */

const SITE_A = 'site_cfg_boundary_a';
const SITE_B = 'site_cfg_boundary_b';
const PROVIDER_KEY = 'it-boundary-provider';
const SECRET = 'tok-site-b-SECRET-5f2c9e';
const keys = new EnvKeyProvider(new Map([['v0', Buffer.alloc(32, 9).toString('base64')]]), 'v0');

const usedTokens: string[] = [];
const provider: DeploymentProvider = {
  key: PROVIDER_KEY,
  verifyToken: async () => ({ ok: true }),
  trigger: async (token: string) => {
    usedTokens.push(token);
    return { providerDeploymentId: `dep_${usedTokens.length}`, status: 'queued', url: null };
  },
  getStatus: async () => ({ providerDeploymentId: 'x', status: 'ready', url: null }),
  getLogs: async () => '',
  verifyWebhook: async () => true,
} as unknown as DeploymentProvider;

describe.skipIf(!hasDbIntegrationUrl)('configured credentials stay within their site (PostgreSQL)', () => {
  let db: Database;
  let targetB: string;
  const svc = (siteId: string) => new DeploymentService({ db, siteId, keys } as never);

  beforeAll(async () => {
    db = await connectDbIntegration('config-boundary');
    registerProvider(provider);
  });

  beforeEach(async () => {
    usedTokens.length = 0;
    for (const id of [SITE_A, SITE_B]) await db.delete(sites).where(eq(sites.id, id));
    await db.insert(sites).values([
      { id: SITE_A, name: 'Boundary A' },
      { id: SITE_B, name: 'Boundary B' },
    ]);
    targetB = (await svc(SITE_B).createTarget({ provider: PROVIDER_KEY, name: 'B prod', projectId: 'prj_b', token: SECRET })).id;
  });

  afterAll(async () => {
    if (!db) return;
    for (const id of [SITE_A, SITE_B]) await db.delete(sites).where(eq(sites.id, id)).catch(() => undefined);
  });

  it("site A cannot list, change, delete or trigger site B's target", async () => {
    const a = svc(SITE_A);
    expect(await a.listTargets()).toEqual([]);
    expect(await a.updateTarget(targetB, { name: 'hijacked', token: 'tok-attacker' })).toBeNull();
    expect(await a.deleteTarget(targetB)).toBe(false);
    await expect(a.trigger(targetB, { source: 'manual' } as never)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(usedTokens).toEqual([]);
    // Site B's target is untouched.
    expect((await svc(SITE_B).listTargets()).map((t) => t.name)).toEqual(['B prod']);
  });

  it('the token appears in no response, error or audit entry', async () => {
    const listed = JSON.stringify(await svc(SITE_B).listTargets());
    expect(listed).not.toContain(SECRET);
    const error = await svc(SITE_A).trigger(targetB, { source: 'manual' } as never).catch((e: unknown) => e);
    expect(JSON.stringify(error) + String(error)).not.toContain(SECRET);
    await new Promise((r) => setTimeout(r, 200)); // audit writes are fire-and-forget
    const audits = await db.select().from(auditLog).where(sql`${auditLog.siteId} IN (${SITE_A}, ${SITE_B})`);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    // The owner can still use it: the token reaches the provider, and only there.
    await svc(SITE_B).trigger(targetB, { source: 'manual' } as never);
    expect(usedTokens).toEqual([SECRET]);
  });
});
