import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireSiteEditor } from '../middleware/site-editor';
import { gatewayFor } from '../services/llm/bindings';
import { LlmGatewayError } from '../services/llm/gateway';
import { PromptWorkbench, WorkbenchError } from '../services/pipeline/prompt-workbench';

/**
 * /prompt-workbench — trial runs of an unsaved prompt and editorial policy (HeoPress P09 task 4.1; spec
 * ai/prompt-workbench).
 *
 *   POST /trial   {sourceDocumentId, mode, targetLocale, prompt, editorialPolicy} → a server-sent event stream:
 *                 `stage`, `output` (one per paragraph), `usage` (tokens and cost, billed to the site as
 *                 `workbench_trial`), `diagnostics` (the gate's rules, paragraphs located in the source), `done` or
 *                 `error`. Nothing but the ledger is written: no production, draft, item or gate result.
 *
 * Signed-in editors only (not API keys): the workbench is a person's tool.
 */
export const promptWorkbenchRouter = new Hono<AppEnv>();

const TrialSchema = z.object({
  sourceDocumentId: z.string().min(1).max(64),
  mode: z.enum(['translate', 'rewrite', 'write']),
  targetLocale: z.string().min(2).max(35),
  prompt: z.string().trim().min(1).max(20_000),
  editorialPolicy: z.record(z.string(), z.unknown()).default({}),
});

promptWorkbenchRouter.post('/trial', requireSiteEditor(), async (c) => {
  const auth = c.get('auth');
  if (!auth?.userId || auth.apiKeyId) return c.json({ errors: [{ code: 'FORBIDDEN', message: 'The prompt workbench is used by a signed-in person.' }] }, 403);
  const parsed = TrialSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message, path: i.path })) }, 400);
  const db = c.get('db');
  const workbench = new PromptWorkbench({
    db,
    siteId: c.get('siteId'),
    gateway: gatewayFor({ db, keys: c.get('runtime').keys, env: (c.env ?? {}) as unknown as Record<string, string | undefined> }),
  });
  return streamSSE(c, async (stream) => {
    const abort = new AbortController();
    stream.onAbort(() => abort.abort());
    try {
      await workbench.trial(parsed.data, (e) => stream.writeSSE({ event: e.type, data: JSON.stringify(e) }), abort.signal);
    } catch (err) {
      const code = err instanceof WorkbenchError || err instanceof LlmGatewayError ? err.code : 'INTERNAL';
      const message = err instanceof WorkbenchError || err instanceof LlmGatewayError ? err.message : 'The trial failed.';
      await stream.writeSSE({ event: 'error', data: JSON.stringify({ type: 'error', code, message }) });
    }
  });
});
