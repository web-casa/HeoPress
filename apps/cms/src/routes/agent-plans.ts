import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { dispatchAsAgent } from '../middleware/agent-dispatch';
import { verifyUserTotpCode } from '../modules/mfa/totp-service';
import type { Dispatch } from '../services/agent-access/mcp-tool-runner';
import { PlanError, PlanService, type PlanView } from '../services/agent-plans/plan-service';
import { agentAccessService } from './agent-access';

/**
 * Batch operation plans in Studio (HeoPress P10 tasks 3.2–3.4; spec agents/batch-operations; ADR-0012).
 *
 *   GET  /api/v1/agent-plans?status=…        the plans the person may see
 *   GET  /api/v1/agent-plans/:id             one plan: items, approvals, what this person may do
 *   GET  /api/v1/agent-plans/:id/preview     per-site diff: the current resource (read as this person) and the change
 *   POST /api/v1/agent-plans/:id/approve     {secondFactor?, planHash}
 *   POST /api/v1/agent-plans/:id/reject      {reason}
 *   POST /api/v1/agent-plans/:id/cancel      {reason?}
 *   POST /api/v1/agent-plans/:id/execute     run the next phase (canary first)
 *   POST /api/v1/agent-plans/:id/canary/confirm
 *   POST /api/v1/agent-plans/:id/retry       re-run the sites that failed
 *
 * Only a person signed in to Studio: an API key, an agent token or the MCP endpoint's internal requests get 403 —
 * there is no agent path to any decision here.
 */
export const agentPlansRouter = new Hono<AppEnv>();

function personOf(c: Context<AppEnv>): string | null {
  const auth = c.get('auth');
  if (!auth?.userId || auth.type === 'api_key' || auth.type === 'anonymous' || auth.apiKeyId || auth.isFrontendUser) return null;
  if (auth.method !== 'session' && auth.method !== 'cf_access' && auth.method !== 'external') return null;
  return auth.userId;
}

/** The REST API as a person, in a site's scope (same in-process path as the MCP endpoint's tool calls). */
function dispatcherFor(c: Context<AppEnv>, userId: string, grantId: string | null): Dispatch {
  const origin = new URL(c.req.url).origin;
  return async (siteId, request) => {
    const headers = new Headers({ 'x-heopress-site': siteId, ...(request.headers ?? {}) });
    const ip = c.get('ip');
    if (ip) headers.set('x-forwarded-for', ip);
    let body: BodyInit | undefined;
    if (request.json !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(request.json);
    }
    const res = await dispatchAsAgent(new Request(`${origin}${request.path}`, { method: request.method, headers, body }), { userId, grantId }, c.env);
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  };
}

const serviceOf = (c: Context<AppEnv>) =>
  new PlanService({
    db: c.get('db'),
    access: agentAccessService(c),
    dispatchAs: (userId, grantId) => dispatcherFor(c, userId, grantId),
    verifySecondFactor: (userId, code) => verifyUserTotpCode(c.get('db'), c.get('runtime').keys, userId, code).catch(() => false),
  });

async function run(c: Context<AppEnv>, fn: (userId: string, service: PlanService) => Promise<Response>): Promise<Response> {
  const userId = personOf(c);
  if (!userId) return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Batch plans are decided by a person signed in to Studio, never through an agent channel.' }] }, 403);
  try {
    return await fn(userId, serviceOf(c));
  } catch (err) {
    if (err instanceof PlanError) return c.json({ errors: [{ code: err.code, message: err.message, ...(err.details ?? {}) }] }, err.status);
    throw err;
  }
}

async function visible(service: PlanService, userId: string, id: string): Promise<PlanView> {
  const view = await service.view(id);
  if (!(await service.canView(userId, view))) throw new PlanError('PLAN_NOT_FOUND', 'No such plan.', 404);
  return view;
}

async function shape(service: PlanService, userId: string, view: PlanView) {
  const p = view.plan;
  const eligible = await service.isEligibleApprover(userId, view.items.map((i) => i.siteId));
  const isDrafter = p.draftedBy === userId;
  const alreadyApproved = view.approvals.some((a) => a.current && a.approverId === userId);
  const now = Date.now();
  return {
    ...p,
    drafterEmail: view.drafterEmail,
    items: view.items,
    approvals: view.approvals,
    approvalsCurrent: view.approvalsCurrent,
    viewer: {
      isDrafter,
      eligible,
      canApprove: p.status === 'pending_approval' && eligible && !alreadyApproved && !(isDrafter && p.approvalMode === 'team'),
      needsSecondFactor: isDrafter && p.approvalMode === 'solo',
      canReject: ['pending_approval', 'cooling_off'].includes(p.status) && (eligible || isDrafter),
      canCancel: !['completed', 'cancelled', 'rejected', 'expired'].includes(p.status) && (eligible || isDrafter),
      canExecute: (eligible || isDrafter) && (p.status === 'approved' || (p.status === 'cooling_off' && !!p.coolingOffUntil && p.coolingOffUntil.getTime() <= now)),
      canConfirmCanary: p.status === 'canary_review' && eligible && view.items.filter((i) => i.canary).every((i) => i.status === 'succeeded'),
      canRetry: ['completed', 'canary_review'].includes(p.status) && (eligible || isDrafter) && view.items.some((i) => i.status === 'failed'),
    },
  };
}

agentPlansRouter.get('/', (c) =>
  run(c, async (userId, service) => {
    const rows = await service.list(userId, c.req.query('status') || undefined);
    return c.json({ data: rows });
  }),
);

agentPlansRouter.get('/:id', (c) =>
  run(c, async (userId, service) => c.json({ data: await shape(service, userId, await visible(service, userId, c.req.param('id'))) })),
);

const PREVIEW_LIMIT = 100;

agentPlansRouter.get('/:id/preview', (c) =>
  run(c, async (userId, service) => {
    const view = await visible(service, userId, c.req.param('id'));
    const p = view.plan;
    const read = dispatcherFor(c, userId, null);
    const rows = [];
    for (const item of view.items.slice(0, PREVIEW_LIMIT)) {
      const args = { ...p.arguments, ...item.arguments } as Record<string, unknown>;
      const proposed = (p.operation === 'site_update_seo_settings' ? args.settings : args.data) as Record<string, unknown> | undefined;
      const row: Record<string, unknown> = { siteId: item.siteId, canary: item.canary, arguments: args, expectedVersion: args.expectedVersion ?? args.expectedActiveVersionId ?? null };
      if (['content_update', 'content_publish', 'content_delete'].includes(p.operation) && typeof args.collection === 'string' && typeof args.id === 'string') {
        const res = await read(item.siteId, { method: 'GET', path: `/api/v1/items/${encodeURIComponent(args.collection)}/${encodeURIComponent(args.id)}` });
        if (res.status === 200) {
          const current = ((res.body as { data?: Record<string, unknown> } | null)?.data ?? {}) as Record<string, unknown>;
          row.currentVersion = current.version ?? null;
          row.stale = current.version !== args.expectedVersion;
          const fields = p.operation === 'content_update' ? Object.keys(proposed ?? {}) : ['status'];
          row.changes = fields.map((f) => ({
            field: f,
            current: current[f] ?? null,
            proposed: p.operation === 'content_update' ? proposed?.[f] : p.operation === 'content_publish' ? 'published' : '(deleted)',
          }));
        } else {
          row.readError = res.status === 403 || res.status === 401 ? 'FORBIDDEN' : res.status === 404 ? 'NOT_FOUND' : `HTTP_${res.status}`;
        }
      } else if (proposed) {
        row.changes = Object.keys(proposed).map((f) => ({ field: f, current: null, proposed: proposed[f] }));
      }
      rows.push(row);
    }
    return c.json({ data: { items: rows, truncated: view.items.length > PREVIEW_LIMIT } });
  }),
);

const ApproveSchema = z.object({ secondFactor: z.string().trim().max(32).optional(), planHash: z.string().trim().max(128).optional() });
const ReasonSchema = z.object({ reason: z.string().trim().max(2000).optional() });

async function body<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new PlanError('VALIDATION', parsed.error.issues[0]?.message ?? 'Invalid body.', 400);
  return parsed.data;
}

const action = (fn: (service: PlanService, id: string, userId: string, c: Context<AppEnv>) => Promise<PlanView>) => (c: Context<AppEnv>) =>
  run(c, async (userId, service) => {
    const id = c.req.param('id')!;
    await visible(service, userId, id);
    const view = await fn(service, id, userId, c);
    return c.json({ data: await shape(service, userId, view) });
  });

agentPlansRouter.post(
  '/:id/approve',
  action(async (s, id, u, c) => s.approve(id, u, await body(c, ApproveSchema))),
);
agentPlansRouter.post(
  '/:id/reject',
  action(async (s, id, u, c) => {
    const reason = (await body(c, ReasonSchema)).reason ?? '';
    if (!reason) throw new PlanError('VALIDATION', 'A reason is required.', 400);
    return s.reject(id, u, reason);
  }),
);
agentPlansRouter.post(
  '/:id/cancel',
  action(async (s, id, u, c) => s.cancel(id, u, (await body(c, ReasonSchema)).reason ?? '')),
);
agentPlansRouter.post('/:id/execute', action((s, id, u) => s.execute(id, u)));
agentPlansRouter.post('/:id/canary/confirm', action((s, id, u) => s.confirmCanary(id, u)));
agentPlansRouter.post('/:id/retry', action((s, id, u) => s.retry(id, u)));
