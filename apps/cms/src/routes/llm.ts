/**
 * Model providers of the current site (HeoPress P04 tasks 7.1–7.6):
 *
 *   GET    /llm/providers              list (keys masked)
 *   POST   /llm/providers              create
 *   GET    /llm/providers/:id          read
 *   PATCH  /llm/providers/:id          update (apiKey: omit keeps it, null clears it)
 *   DELETE /llm/providers/:id          delete (soft: the ledger keeps naming it)
 *   POST   /llm/providers/:id/probe    probe tool calls and JSON output (two ledger calls of type `probe`)
 *   GET    /llm/routes                 the failover list of every task type
 *   PUT    /llm/routes                 {taskType, providerIds}: set one list (empty removes it)
 *   GET    /llm/settings               currency and monthly budget
 *   PUT    /llm/settings               change them (currency locked once there is usage)
 *   GET    /llm/usage?period=YYYY-MM   usage by provider and model, unknown liabilities, carried-over debt
 *   GET    /llm/attempts               the ledger (?pending=1, billing, period, providerId, before, limit)
 *   POST   /llm/attempts/:id/reconcile a person's conclusion on an unknown cost (T9)
 *   POST   /llm/attempts/reconcile     batch: confirm one provider's pending attempts in a range as not billed
 *
 * A control-plane path: site administrators only.
 */
import { Hono, type Context } from 'hono';
import {
  LlmProviderCreateSchema,
  LlmProviderUpdateSchema,
  LlmReconcileBatchSchema,
  LlmReconcileSchema,
  LlmRouteSetSchema,
  LlmSettingsSchema,
  LLM_PERIOD_PATTERN,
} from '@heopress/contracts/schemas';
import type { AppEnv } from '../env';
import { LlmConfigError, LlmProviderService } from '../services/llm/provider-service';
import { LlmUsageService } from '../services/llm/usage-service';
import { gatewayFor } from '../services/llm/bindings';
import { LlmGatewayError } from '../services/llm/gateway';

export const llmRouter = new Hono<AppEnv>();

/** The instance currency: the default for sites without settings. */
function instanceCurrency(env: Record<string, string | undefined> | undefined): string {
  const raw = (env?.LLM_PRICE_CURRENCY ?? process.env.LLM_PRICE_CURRENCY ?? 'USD').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(raw) ? raw : 'USD';
}

function llmProviderServiceFor(c: Context<AppEnv>): LlmProviderService {
  return new LlmProviderService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    keys: c.get('runtime').keys,
    instanceCurrency: instanceCurrency(c.env as unknown as Record<string, string | undefined>),
  });
}

function llmUsageServiceFor(c: Context<AppEnv>): LlmUsageService {
  return new LlmUsageService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    instanceCurrency: instanceCurrency(c.env as unknown as Record<string, string | undefined>),
  });
}

const operatorOf = (c: Context<AppEnv>) => c.get('auth')?.userId ?? null;

function periodParam(c: Context<AppEnv>, name: string): string | undefined | Response {
  const value = c.req.query(name);
  if (value === undefined || value === '') return undefined;
  if (!LLM_PERIOD_PATTERN.test(value)) return c.json({ errors: [{ code: 'VALIDATION', message: `${name} is a month: YYYY-MM.` }] }, 400);
  return value;
}

async function run(c: Context<AppEnv>, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof LlmConfigError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
    throw err;
  }
}

async function body<T>(c: Context<AppEnv>, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ message: string; path: PropertyKey[] }> } } }) {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return { error: c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message, path: i.path })) }, 400) };
  }
  return { data: parsed.data };
}

llmRouter.get('/providers', (c) => run(c, async () => c.json({ data: await llmProviderServiceFor(c).list() })));

llmRouter.post('/providers', (c) =>
  run(c, async () => {
    const input = await body(c, LlmProviderCreateSchema);
    if ('error' in input) return input.error!;
    return c.json({ data: await llmProviderServiceFor(c).create(input.data) }, 201);
  }),
);

llmRouter.get('/providers/:id', (c) => run(c, async () => c.json({ data: await llmProviderServiceFor(c).get(c.req.param('id')) })));

llmRouter.patch('/providers/:id', (c) =>
  run(c, async () => {
    const input = await body(c, LlmProviderUpdateSchema);
    if ('error' in input) return input.error!;
    return c.json({ data: await llmProviderServiceFor(c).update(c.req.param('id'), input.data) });
  }),
);

llmRouter.delete('/providers/:id', (c) =>
  run(c, async () => {
    await llmProviderServiceFor(c).remove(c.req.param('id'));
    return c.body(null, 204);
  }),
);

llmRouter.post('/providers/:id/probe', (c) =>
  run(c, async () => {
    const id = c.req.param('id');
    const svc = llmProviderServiceFor(c);
    const basis = await svc.probeBasis(id);
    const env = (c.env ?? {}) as unknown as Record<string, string | undefined>;
    const gateway = gatewayFor({ db: c.get('db'), keys: c.get('runtime').keys, env });
    try {
      const verdicts = await gateway.probe(c.get('siteId'), id, { kind: 'probe', id });
      const { provider, recorded } = await svc.recordProbe(id, basis, verdicts);
      return c.json({ data: provider, meta: { probe: verdicts, recorded } });
    } catch (err) {
      if (err instanceof LlmGatewayError && err.code === 'NOT_FOUND') return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Model provider not found.' }] }, 404);
      if (err instanceof LlmGatewayError && err.code === 'PROVIDER_DISABLED') return c.json({ errors: [{ code: err.code, message: err.message }] }, 409);
      throw err;
    }
  }),
);

llmRouter.get('/routes', (c) => run(c, async () => c.json({ data: await llmProviderServiceFor(c).routes() })));

llmRouter.put('/routes', (c) =>
  run(c, async () => {
    const input = await body(c, LlmRouteSetSchema);
    if ('error' in input) return input.error!;
    const svc = llmProviderServiceFor(c);
    await svc.setRoute(input.data.taskType, input.data.providerIds);
    return c.json({ data: await svc.routes() });
  }),
);

llmRouter.get('/settings', (c) => run(c, async () => c.json({ data: await llmProviderServiceFor(c).settings() })));

llmRouter.put('/settings', (c) =>
  run(c, async () => {
    const input = await body(c, LlmSettingsSchema);
    if ('error' in input) return input.error!;
    return c.json({ data: await llmProviderServiceFor(c).updateSettings(input.data) });
  }),
);

llmRouter.get('/usage', (c) =>
  run(c, async () => {
    const period = periodParam(c, 'period');
    if (period instanceof Response) return period;
    return c.json({ data: await llmUsageServiceFor(c).usage(period) });
  }),
);

llmRouter.get('/attempts', (c) =>
  run(c, async () => {
    const period = periodParam(c, 'period');
    if (period instanceof Response) return period;
    const limit = Number(c.req.query('limit') ?? 50);
    const page = await llmUsageServiceFor(c).attempts({
      pending: c.req.query('pending') === '1' || c.req.query('pending') === 'true',
      billing: c.req.query('billing') || undefined,
      period,
      providerId: c.req.query('providerId') || undefined,
      before: c.req.query('before') || undefined,
      limit: Number.isFinite(limit) ? limit : 50,
    });
    return c.json({ data: page.items, meta: { next: page.next } });
  }),
);

// Registered before `/attempts/:id/reconcile`: "reconcile" is not an attempt id.
llmRouter.post('/attempts/reconcile', (c) =>
  run(c, async () => {
    const input = await body(c, LlmReconcileBatchSchema);
    if ('error' in input) return input.error!;
    return c.json({ data: await llmUsageServiceFor(c).reconcileBatch(input.data, operatorOf(c)) });
  }),
);

llmRouter.post('/attempts/:id/reconcile', (c) =>
  run(c, async () => {
    const input = await body(c, LlmReconcileSchema);
    if ('error' in input) return input.error!;
    return c.json({ data: await llmUsageServiceFor(c).reconcile(c.req.param('id'), input.data, operatorOf(c)) });
  }),
);
