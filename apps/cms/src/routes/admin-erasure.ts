// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Admin Erasure routes (regulated-content-readiness task 9.4; Req 11).
 *
 *   POST /api/v1/admin/erasure              body `{ scope:{collection,filter} | {ingestSnapshots:[id…]}, reason? }`
 *   POST /api/v1/admin/erasure/:id/confirm
 *   POST /api/v1/admin/erasure/:id/execute  body `{ action?: 'hard_delete'|'crypto_shred' }`
 *
 * Mounted under `withAuth`; admin-role gated. Lifecycle is
 * pending → confirmed → executing → completed|failed with optional
 * dual-control on confirm.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { ErasureService, ErasureError } from '../services/erasure-service';
import { deletionLedgerSinkFromEnv } from '../services/retention/deletion-ledger';

export const adminErasureRouter = new Hono<AppEnv>();

const createSchema = z.object({
  scope: z.union([
    z.object({
      collection: z.string().min(1).max(128),
      filter: z.record(z.string(), z.unknown()),
    }),
    // HeoPress P13 task 5.1: raw fetch snapshots holding the subject's personal data.
    z.object({ ingestSnapshots: z.array(z.string().min(1).max(64)).min(1).max(500) }).strict(),
  ]),
  reason: z.string().max(2000).optional(),
});

const executeSchema = z.object({
  action: z.enum(['hard_delete', 'crypto_shred']).optional(),
});

function requireAdmin(c: Context<AppEnv>) {
  const auth = c.get('auth');
  const roles = Array.isArray(auth?.roles) ? (auth.roles as string[]) : [];
  if (!roles.includes('admin')) {
    return c.json({ errors: [{ code: 'FORBIDDEN', message: 'Admin role required.' }] }, 403);
  }
  return null;
}

const buildService = (c: Context<AppEnv>) => {
  const auth = c.get('auth');
  const storage = c.get('runtime').storage;
  return new ErasureService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    userId: auth?.userId ?? null,
    actorEmail: typeof auth?.email === 'string' ? auth.email : null,
    storage,
    // The external deletion ledger (HeoPress P13 task 5.2).
    ledger: deletionLedgerSinkFromEnv({ ...process.env, ...(c.env as unknown as Record<string, string | undefined>) }, storage),
  });
};

const toError = (err: unknown) => {
  if (err instanceof ErasureError) {
    return { status: err.status, body: { errors: [{ code: err.code, message: err.message }] } };
  }
  return { status: 500, body: { errors: [{ code: 'INTERNAL', message: 'Unhandled erasure error.' }] } };
};

adminErasureRouter.post('/', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;
  const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).create(parsed.data.scope, parsed.data.reason);
    return c.json({ data }, 201);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

adminErasureRouter.post('/:id/confirm', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;
  try {
    const data = await buildService(c).confirm(c.req.param('id'));
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

adminErasureRouter.post('/:id/execute', async (c) => {
  const forbidden = requireAdmin(c);
  if (forbidden) return forbidden;
  const parsed = executeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).execute(c.req.param('id'), parsed.data.action);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});
