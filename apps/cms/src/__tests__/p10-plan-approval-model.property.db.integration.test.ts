import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { and, eq, sql } from 'drizzle-orm';
import { agentGrants, batchPlanItems, items, roles, userSites, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
// Importing the app registers it as the agent dispatch target.
import '../index';
import { dispatchAsAgent } from '../middleware/agent-dispatch';
import { setRuntimeFactory } from '../middleware/runtime';
import { AgentAccessService } from '../services/agent-access/agent-access-service';
import type { Dispatch } from '../services/agent-access/mcp-tool-runner';
import { PLAN_TTL_MS, PlanError, PlanService, type PlanDrafter } from '../services/agent-plans/plan-service';
import { ItemService } from '../services/item-service';
import { __resetPermissionProcessCacheForTests } from '../services/permission-service';
import { connectDbIntegration, hasDbIntegrationUrl } from './helpers/db-harness';
import { createCrossSiteFixture, SHARED, type CrossSiteFixture } from './helpers/cross-site-fixture';

/**
 * HeoPress P10 task 7.3 (ADR-0017): a fast-check model test of the batch-plan approval binding, against the real
 * database and the real executor.
 *
 * An approval binds the operator (drafter), the resolved site set, the operation, the argument digest, the content base
 * versions and the validity period. Commands interleave arbitrarily: approve (the drafter with a second factor),
 * approve by someone who is not an administrator of every site, revise the arguments (sometimes smuggling identity and
 * permission fields an agent's model might produce), revise the site set and base versions, someone edits a target
 * item, the authorization is narrowed to one site, the stored plan is tampered with, time passes beyond the validity
 * period, and execute.
 *
 * The reference model below is written from the spec (agents/batch-operations, agents/site-scope) and imports nothing
 * from the implementation. After every command it must agree with the service:
 * - execute runs only when the latest revision is approved, not expired and not tampered with — any substantive
 *   change in between voids the approval (the old one is never reused);
 * - exactly the approved sites run — a site the token or person could reach later is never added, and a site the
 *   authorization no longer covers is reported `forbidden`, never silently dropped;
 * - a site whose base version moved is a `conflict`; the rest succeed;
 * - fields in the arguments that name a person, a role or another site raise nothing: the call runs as the drafter, on
 *   the planned site only;
 * - an approval by a non-administrator never counts (trust in the agent does not override RBAC).
 *
 * Sample sizes: a pull request runs a few short sequences; HEOPRESS_MODEL_TEST_RUNS (nightly) runs long ones. A failure
 * prints fast-check's seed and path: add them to REGRESSIONS (never re-run with another seed until green).
 */

const LONG = Number(process.env.HEOPRESS_MODEL_TEST_RUNS ?? 0) > 0;
const RUNS = LONG ? Number(process.env.HEOPRESS_MODEL_TEST_RUNS) : 30;
const MAX_COMMANDS = LONG ? 30 : 12;

/** Failing seeds and paths found so far, replayed on every run (fast-check `seed` + `path`). */
const REGRESSIONS: Array<{ seed: number; path: string }> = [];

const JWT_SECRET = 'p10-model-secret';
const BASE = 'https://cms.example.com';
const MCP = `${BASE}/api/v1/agents/mcp`;
const CODE = '123456';
const HOUR = 3600_000;

type Site = 'a' | 'b';

/** The reference model: what the spec says the plan is. */
interface PlanModel {
  status: 'pending' | 'approved' | 'done';
  /** Bumped by every substantive change (revision). */
  rev: number;
  /** The revision the current approval was given for, if any. */
  approvedRev: number | null;
  sites: Site[];
  /** Sites whose item changed since the plan recorded its base version. */
  moved: Set<Site>;
  grantSites: Set<Site>;
  expired: boolean;
  tampered: boolean;
  title: string;
}

interface Real {
  planId: string;
}

describe.skipIf(!hasDbIntegrationUrl)('P10 plan approval binding — model test (fast-check, DB integration)', () => {
  let db: Database;
  let fx: CrossSiteFixture;
  let env: Record<string, unknown> = {};
  let clock = Date.now();
  let drafter: PlanDrafter;
  let executions = 0;

  beforeAll(async () => {
    db = await connectDbIntegration('p10-plan-approval-model');
    env = { ...process.env, JWT_SECRET, HEOPRESS_ENV: 'development', HEOPRESS_PUBLIC_URL: BASE, HEOPRESS_API_RATE_LIMIT: '1000000' };
    setRuntimeFactory(() => createRuntime(env));
  });
  afterAll(() => setRuntimeFactory(null));
  beforeEach(async () => {
    fx = await createCrossSiteFixture(db, { prefix: 'p10pm', jwtSecret: JWT_SECRET });
    __resetPermissionProcessCacheForTests();
    // adminA (the drafter) administers both sites.
    const [adminB] = await db.select({ id: roles.id }).from(roles).where(and(eq(roles.siteId, fx.sites.b), eq(roles.adminAccess, true))).limit(1);
    await db.insert(userSites).values({ userId: fx.users.adminA.id, siteId: fx.sites.b, roleId: adminB!.id });
    const t = await access().createPersonalToken(fx.users.adminA.id, { name: 'model', siteIds: [fx.sites.a, fx.sites.b], toolGroups: ['read', 'content'] }, MCP);
    drafter = { userId: fx.users.adminA.id, grantId: t.grant.id, via: 'pat' };
  });
  afterEach(async () => {
    await db.execute(sql`DELETE FROM lumibase_batch_plans WHERE drafted_by LIKE 'usr_p10pm_%'`);
    await db.execute(sql`DELETE FROM lumibase_agent_grants WHERE user_id LIKE 'usr_p10pm_%'`);
    if (fx) await fx.teardown();
  });

  // ── the system under test ───────────────────────────────────────────

  const access = () => new AgentAccessService({ db, jwtSecret: JWT_SECRET });
  const dispatchAs =
    (userId: string, grantId: string | null): Dispatch =>
    async (siteId, r) => {
      const headers: Record<string, string> = { 'x-heopress-site': siteId, ...(r.headers ?? {}) };
      if (r.json !== undefined) headers['content-type'] = 'application/json';
      const res = await dispatchAsAgent(new Request(`${BASE}${r.path}`, { method: r.method, headers, body: r.json !== undefined ? JSON.stringify(r.json) : undefined }), { userId, grantId }, env as never);
      const text = await res.text();
      return { status: res.status, body: text ? (JSON.parse(text) as unknown) : null };
    };
  const service = () =>
    new PlanService({ db, access: access(), dispatchAs, verifySecondFactor: async (_u, code) => code === CODE, approvalMode: async () => 'solo', now: () => new Date(clock) });

  const versionOf = async (k: Site) => (await db.select({ version: items.version }).from(items).where(eq(items.id, fx.items[k])))[0]!.version;
  const titleOf = async (k: Site) => (await db.select({ title: sql<string>`${items.data}->>'title'` }).from(items).where(eq(items.id, fx.items[k])))[0]!.title;
  async function perSite(sites: Site[]) {
    const out: Record<string, Record<string, unknown>> = {};
    for (const k of sites) out[fx.sites[k]] = { id: fx.items[k], expectedVersion: await versionOf(k) };
    return out;
  }
  const setGrant = (sites: Site[]) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.agent_access', 'on', true)`);
      await tx.update(agentGrants).set({ siteIds: sites.map((k) => fx.sites[k]) }).where(eq(agentGrants.id, drafter.grantId!));
    });

  /** Run `act`; it must succeed exactly when the model says so (a refusal is a PlanError, never anything else). */
  async function expectOutcome<T>(allowed: boolean, act: () => Promise<T>, label: string): Promise<T | null> {
    try {
      const out = await act();
      expect(allowed, `${label} succeeded although the model forbids it`).toBe(true);
      return out;
    } catch (err) {
      if (!(err instanceof PlanError)) throw err;
      expect(allowed, `${label} refused (${err.code}) although the model allows it`).toBe(false);
      return null;
    }
  }

  type Cmd = fc.AsyncCommand<PlanModel, Real>;
  const cmd = (label: string, run: (m: PlanModel, r: Real) => Promise<void>): Cmd => ({ check: () => true, run, toString: () => label });
  const open = (m: PlanModel) => m.status !== 'done' && !m.expired;

  const approve = cmd('approve(drafter+2FA)', async (m, r) => {
    const ok = open(m) && m.status === 'pending' && !m.tampered;
    const out = await expectOutcome(ok, () => service().approve(r.planId, drafter.userId, { secondFactor: CODE }), 'approve');
    if (out) {
      m.status = 'approved';
      m.approvedRev = m.rev;
    }
  });

  const approveByStranger = cmd('approve(not an admin of every site)', async (m, r) => {
    // onlyA is an editor of A only: never eligible, whatever the agent claims about trust.
    await expect(service().approve(r.planId, fx.users.onlyA.id)).rejects.toBeInstanceOf(PlanError);
    void m;
  });

  const reviseArgs = (variant: number, smuggle: boolean) =>
    cmd(`reviseArgs(${variant}${smuggle ? ', smuggled identity' : ''})`, async (m, r) => {
      const title = `Planned v${variant}`;
      const args: Record<string, unknown> = { collection: SHARED.collection, data: { title } };
      if (smuggle) Object.assign(args, { siteId: fx.sites.b, userId: fx.users.adminB.id, draftedBy: fx.users.adminB.id, role: 'admin', toolGroups: ['publish', 'site_settings'] });
      const ok = open(m) && !m.tampered;
      // An unchanged argument digest is still a new revision: the service re-hashes and voids the approval either way.
      const out = await expectOutcome(ok, () => service().revise(drafter, r.planId, { arguments: args }), 'reviseArgs');
      if (out) {
        expect(out.approvalsCurrent).toBe(0);
        m.rev++;
        m.status = 'pending';
        m.title = title;
      }
    });

  const reviseSites = (sites: Site[]) =>
    cmd(`reviseSites(${sites.join('+')})`, async (m, r) => {
      const ok = open(m) && !m.tampered;
      const out = await expectOutcome(ok, async () => service().revise(drafter, r.planId, { siteIds: sites.map((k) => fx.sites[k]), perSite: await perSite(sites) }), 'reviseSites');
      if (out) {
        expect(out.approvalsCurrent).toBe(0);
        m.rev++;
        m.status = 'pending';
        m.sites = [...sites];
        m.moved = new Set();
      }
    });

  const editItem = (k: Site) =>
    cmd(`editItem(${k})`, async (m) => {
      await new ItemService({ db, siteId: fx.sites[k] }).patch(SHARED.collection, fx.items[k], { data: { excerpt: `edited ${Math.random()}` }, expectedVersion: await versionOf(k) });
      m.moved.add(k);
    });

  const narrowGrant = (sites: Site[]) =>
    cmd(`narrowGrant(${sites.join('+')})`, async (m) => {
      await setGrant(sites);
      m.grantSites = new Set(sites);
    });

  // A finished plan is not tampered with (the command's precondition).
  const tamper: Cmd = { check: (m) => m.status !== 'done', run: async (m, r) => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.agent_access', 'on', true)`);
      await tx.update(batchPlanItems).set({ arguments: sql`${batchPlanItems.arguments} || '{"expectedVersion": 9999}'::jsonb` }).where(eq(batchPlanItems.planId, r.planId));
    });
    m.tampered = true;
  }, toString: () => 'tamper(stored arguments)' };

  let start = 0;
  const passTime = (hours: number) =>
    cmd(`passTime(${hours}h)`, async (m) => {
      clock += hours * HOUR;
      if (clock >= start + PLAN_TTL_MS) m.expired = true;
    });

  const execute = cmd('execute', async (m, r) => {
    const ok = open(m) && m.status === 'approved' && m.approvedRev === m.rev && !m.tampered;
    const titles = { a: await titleOf('a'), b: await titleOf('b') };
    const out = await expectOutcome(ok, () => service().execute(r.planId, drafter.userId), 'execute');
    if (!out) {
      // Nothing ran.
      expect({ a: await titleOf('a'), b: await titleOf('b') }).toEqual(titles);
      return;
    }
    executions++;
    m.status = 'done';
    // Exactly the approved sites, each with a reported result.
    expect(out.items.map((i) => i.siteId).sort()).toEqual(m.sites.map((k) => fx.sites[k]).sort());
    for (const k of ['a', 'b'] as const) {
      const item = out.items.find((i) => i.siteId === fx.sites[k]);
      if (!item) {
        expect(await titleOf(k), `site ${k} was not planned but changed`).toBe(titles[k]);
        continue;
      }
      const expected = !m.grantSites.has(k) ? 'forbidden' : m.moved.has(k) ? 'conflict' : 'succeeded';
      expect(item.status, `site ${k}: ${JSON.stringify(item.result)}`).toBe(expected);
      expect(await titleOf(k)).toBe(expected === 'succeeded' ? m.title : titles[k]);
    }
  });

  const commands = [
    fc.constant(approve),
    fc.constant(approve),
    fc.constant(approveByStranger),
    fc.tuple(fc.integer({ min: 1, max: 3 }), fc.boolean()).map(([v, s]) => reviseArgs(v, s)),
    fc.constantFrom<Site[]>(['a'], ['b'], ['a', 'b']).map((s) => reviseSites(s)),
    fc.constantFrom<Site>('a', 'b').map((k) => editItem(k)),
    fc.constantFrom<Site[]>(['a'], ['b']).map((s) => narrowGrant(s)),
    fc.constant(tamper),
    fc.constantFrom(1, 80).map((h) => passTime(h)),
    fc.constant(execute),
    fc.constant(execute),
  ];

  async function fresh(sites: Site[]): Promise<{ model: PlanModel; real: Real }> {
    await setGrant(['a', 'b']);
    clock = Date.now();
    start = clock;
    const view = await service().submit(
      drafter,
      { operation: 'content_update', arguments: { collection: SHARED.collection, data: { title: 'Planned v0' } }, perSite: await perSite(sites), siteIds: sites.map((k) => fx.sites[k]), scopeKind: 'siteIds' },
      'model test',
    );
    return {
      model: { status: 'pending', rev: 1, approvedRev: null, sites: [...sites], moved: new Set(), grantSites: new Set(['a', 'b']), expired: false, tampered: false, title: 'Planned v0' },
      real: { planId: view.plan.id },
    };
  }

  const property = () =>
    fc.asyncProperty(fc.constantFrom<Site[]>(['a'], ['b'], ['a', 'b']), fc.commands(commands, { maxCommands: MAX_COMMANDS }), async (sites, cmds) => {
      const { model, real } = await fresh(sites);
      await fc.asyncModelRun(() => ({ model, real }), cmds);
    });

  it('the model is not vacuous: approve → execute runs; approve → revise → execute is refused; the old approval is not reused', async () => {
    let { model, real } = await fresh(['a', 'b']);
    await fc.asyncModelRun(() => ({ model, real }), [approve, execute]);
    expect(model.status).toBe('done');
    ({ model, real } = await fresh(['a']));
    await fc.asyncModelRun(() => ({ model, real }), [approve, reviseArgs(2, true), execute]);
    expect(model.status).toBe('pending');
    const view = await service().view(real.planId);
    expect(view.approvals).toHaveLength(1);
    expect(view.approvals[0]!.current).toBe(false);
    // After approval, the authorization narrowed and an item moved: reported, not dropped.
    ({ model, real } = await fresh(['a', 'b']));
    await fc.asyncModelRun(() => ({ model, real }), [approve, narrowGrant(['a']), editItem('a'), execute]);
    expect(model.status).toBe('done');
  });

  it(
    'approval binding: no interleaving runs a plan whose approved revision, site set, arguments, base versions or validity changed',
    async () => {
      for (const r of REGRESSIONS) await fc.assert(property(), { seed: r.seed, path: r.path, endOnFailure: true });
      executions = 0;
      await fc.assert(property(), { numRuns: RUNS, endOnFailure: true });
      console.log(`P10_MODEL_APPROVAL runs=${RUNS} executions=${executions}`);
      if (LONG) expect(executions).toBeGreaterThan(0);
    },
    LONG ? 3_600_000 : 300_000,
  );
});
