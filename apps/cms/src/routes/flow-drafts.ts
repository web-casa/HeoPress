import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { requireSiteEditor } from '../middleware/site-editor';
import { verifyUserTotpCode } from '../modules/mfa/totp-service';
import { FlowDraftError, FlowDraftService, readApprovalMode, setApprovalMode } from '../services/flow-drafts/flow-draft-service';

/**
 * /flow-drafts — flow definitions drafted by an agent (HeoPress P09 task 5.1; spec ai/flow-authoring; ADR-0012).
 *
 *   GET  /approval-mode      the instance approval mode (`solo` | `team`) (editors)
 *   PUT  /approval-mode      {mode}: change it (instance administrators; audited; later drafts only)
 *   GET  /?status=pending    drafts of this site (editors)
 *   POST /                   submit a draft (editors and agents; the agent tool `draftFlow` does the same)
 *   GET  /:id                one draft (editors)
 *   POST /:id/approve        {secondFactor?, reason?}: a person approves; the flow is created and enabled
 *   POST /:id/reject         {reason}: a person rejects
 *
 * An API key (agent channel) can never approve or reject: 403.
 */
export const flowDraftsRouter = new Hono<AppEnv>();

const serviceOf = (c: Context<AppEnv>) =>
  new FlowDraftService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    verifySecondFactor: (userId, code) => verifyUserTotpCode(c.get('db'), c.get('runtime').keys, userId, code).catch(() => false),
  });
const actorOf = (c: Context<AppEnv>) => ({ userId: c.get('auth')?.userId ?? null, apiKeyId: c.get('auth')?.apiKeyId ?? null });

async function run(c: Context<AppEnv>, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof FlowDraftError) {
      return c.json({ errors: [{ code: err.code, message: err.message }, ...err.errors] }, err.status);
    }
    throw err;
  }
}

const ModeSchema = z.object({ mode: z.enum(['solo', 'team']) });
const ApproveSchema = z.object({ secondFactor: z.string().trim().max(32).optional(), reason: z.string().trim().max(2000).optional() });
const RejectSchema = z.object({ reason: z.string().trim().min(1).max(2000) });

async function body<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<{ data: T } | { error: Response }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return { error: c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message, path: i.path })) }, 400) };
  return { data: parsed.data };
}

flowDraftsRouter.get('/approval-mode', requireSiteEditor(), async (c) => c.json({ data: { mode: await readApprovalMode(c.get('db')) } }));

flowDraftsRouter.put('/approval-mode', requireSiteAdmin(), async (c) => {
  const auth = c.get('auth');
  if (!auth?.userId || auth.apiKeyId || !(auth.roles ?? []).includes('admin')) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Only an instance administrator, signed in, can change the approval mode.' }] }, 403);
  }
  const userId = auth.userId;
  const input = await body(c, ModeSchema);
  if ('error' in input) return input.error;
  return run(c, async () => c.json({ data: { mode: await setApprovalMode(c.get('db'), c.get('siteId'), input.data.mode, userId) } }));
});

flowDraftsRouter.get('/', requireSiteEditor(), (c) => run(c, async () => c.json({ data: await serviceOf(c).list(c.req.query('status') || undefined) })));

flowDraftsRouter.post('/', requireSiteEditor(), (c) =>
  run(c, async () => c.json({ data: await serviceOf(c).submit(await c.req.json().catch(() => ({})), actorOf(c)) }, 201)),
);

flowDraftsRouter.get('/:id', requireSiteEditor(), (c) => run(c, async () => c.json({ data: await serviceOf(c).get(c.req.param('id')) })));

flowDraftsRouter.post('/:id/approve', requireSiteAdmin(), (c) =>
  run(c, async () => {
    const input = await body(c, ApproveSchema);
    if ('error' in input) return input.error;
    return c.json({ data: await serviceOf(c).approve(c.req.param('id'), actorOf(c), input.data) });
  }),
);

flowDraftsRouter.post('/:id/reject', requireSiteAdmin(), (c) =>
  run(c, async () => {
    const input = await body(c, RejectSchema);
    if ('error' in input) return input.error;
    return c.json({ data: await serviceOf(c).reject(c.req.param('id'), actorOf(c), input.data.reason) });
  }),
);
