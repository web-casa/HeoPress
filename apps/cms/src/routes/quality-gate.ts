import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { requireSiteEditor } from '../middleware/site-editor';
import { gatewayFor } from '../services/llm/bindings';
import { ContentPipeline } from '../services/pipeline/content-pipeline';
import { QualityGate, QualityGateError, redactEvidence, type GateState, type StoredCheck } from '../services/quality-gate/quality-gate';
import { canReadOtherSite } from './ingest-documents';

/**
 * /quality-gate — the AI content quality gate (HeoPress P09 tasks 2.1–2.7; spec ai/quality-gate). What the Studio
 * review screen (task 2.3) reads and does:
 *
 *   GET  /settings                    check levels, thresholds, mandatory checks (editors)
 *   PUT  /settings/levels             {check, level: block|warn|off, reason}: change one level (site administrators;
 *                                     mandatory checks cannot be turned off or downgraded; audited; re-judges results)
 *   GET  /productions/:id             the production's gate results (score, per-check evidence and suggestions) and
 *                                     whether the latest still applies (editors)
 *   POST /productions/:id/run         run the gate on the production's draft (editors)
 *   GET  /items/:itemId               the item's gate state: missing, stale (why), passed, blocked, needs review,
 *                                     approved or rejected (editors)
 *   POST /results/:id/review          {decision: approve|reject, reason, itemVersion}: a person's decision on a result
 *                                     that needs review, for that version only (signed-in editors; not API keys)
 *
 * Another site's near-duplicate match is named only to a caller with rights on that site now; others see
 * `duplicateElsewhere`.
 */
export const qualityGateRouter = new Hono<AppEnv>();

const gateOf = (c: Context<AppEnv>) => new QualityGate({ db: c.get('db'), siteId: c.get('siteId') });

async function run(c: Context<AppEnv>, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof QualityGateError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
    throw err;
  }
}

async function present(c: Context<AppEnv>, checks: unknown): Promise<StoredCheck[]> {
  return redactEvidence((checks ?? []) as StoredCheck[], c.get('siteId'), (other) => canReadOtherSite(c, other));
}

async function presentState(c: Context<AppEnv>, s: GateState) {
  return {
    state: s.state,
    publishable: s.publishable,
    staleReasons: s.staleReasons,
    review: s.review,
    result: s.result ? { ...s.result, checks: await present(c, s.result.checks) } : null,
  };
}

const LevelSchema = z.object({ check: z.string().min(1).max(64), level: z.enum(['block', 'warn', 'off']), reason: z.string().trim().min(1).max(1000) });
const ReviewSchema = z.object({ decision: z.enum(['approve', 'reject']), reason: z.string().trim().min(1).max(2000), itemVersion: z.number().int().positive() });

async function body<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<{ data: T } | { error: Response }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return { error: c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message, path: i.path })) }, 400) };
  return { data: parsed.data };
}

qualityGateRouter.get('/settings', requireSiteEditor(), (c) => run(c, async () => c.json({ data: await gateOf(c).settings() })));

qualityGateRouter.put('/settings/levels', requireSiteAdmin(), (c) =>
  run(c, async () => {
    const input = await body(c, LevelSchema);
    if ('error' in input) return input.error;
    return c.json({ data: await gateOf(c).setLevel({ ...input.data, userId: c.get('auth')?.userId ?? null }) });
  }),
);

qualityGateRouter.get('/productions/:id', requireSiteEditor(), (c) =>
  run(c, async () => {
    const gate = gateOf(c);
    const results = await gate.resultsOf(c.req.param('id'));
    const latest = results[0];
    const state = latest ? await gate.current(latest.itemId) : null;
    return c.json({
      data: {
        current: state ? await presentState(c, state) : null,
        results: await Promise.all(results.map(async (r) => ({ ...r, checks: await present(c, r.checks) }))),
      },
    });
  }),
);

qualityGateRouter.post('/productions/:id/run', requireSiteEditor(), (c) =>
  run(c, async () => {
    const db = c.get('db');
    const gateway = gatewayFor({ db, keys: c.get('runtime').keys, env: (c.env ?? {}) as unknown as Record<string, string | undefined> });
    const outcome = await new ContentPipeline({ db, siteId: c.get('siteId'), gateway }).runGate(c.req.param('id'));
    return c.json({ data: { ...outcome, checks: await present(c, outcome.checks) } });
  }),
);

qualityGateRouter.get('/items/:itemId', requireSiteEditor(), (c) => run(c, async () => c.json({ data: await presentState(c, await gateOf(c).current(c.req.param('itemId'))) })));

qualityGateRouter.post('/results/:id/review', requireSiteEditor(), (c) =>
  run(c, async () => {
    const auth = c.get('auth');
    // A person decides: not an API key, not an agent.
    if (!auth?.userId || auth.apiKeyId) return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Only a signed-in person can review a gate result.' }] }, 403);
    const input = await body(c, ReviewSchema);
    if ('error' in input) return input.error;
    const state = await gateOf(c).review({ resultId: c.req.param('id'), ...input.data, reviewerId: auth.userId });
    return c.json({ data: await presentState(c, state) });
  }),
);
