// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Editorial workflow routes (regulated-content-readiness task 8.3; Req 9).
 *
 *   POST /api/v1/editorial/:collection/:id/submit-review  body `{ assignedTo? }`
 *   POST /api/v1/editorial/:collection/:id/approve        body `{ reason? }`
 *   POST /api/v1/editorial/:collection/:id/reject         body `{ reason? }`
 *
 * Mounted under `withAuth`. Human editorial sign-off only — independent of the
 * AI veto-window (Req 9.5). HeoPress P07a: approving and rejecting need the
 * `review` permission on the collection and a person (never an API key); the
 * queue lists only reviews of collections the caller may review. Errors map EditorialError → `{ errors:[{code}] }`.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { EditorialService, EditorialError } from '../services/editorial-service';
import { permissionServiceForRequest } from '../services/item-service-factory';
import { collections, scopeSite } from '@heopress/database';
import type { AuthPrincipal } from '../env';

export const editorialRouter = new Hono<AppEnv>();

/** `expectedVersion`: the item version the action is based on (P04); `If-Match` works too. */
const submitSchema = z.object({
  assignedTo: z.string().min(1).max(128).nullable().optional(),
  expectedVersion: z.number().int().min(1).optional(),
});
const decideSchema = z.object({
  reason: z.string().max(2000).optional(),
  expectedVersion: z.number().int().min(1).optional(),
});

const buildService = (c: Context<AppEnv>) => {
  const auth = c.get('auth');
  return new EditorialService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    userId: auth?.userId ?? null,
    actorEmail: typeof auth?.email === 'string' ? auth.email : null,
  });
};

const toError = (err: unknown) => {
  if (err instanceof EditorialError) {
    return { status: err.status, body: { errors: [{ code: err.code, message: err.message }] } };
  }
  return { status: 500, body: { errors: [{ code: 'INTERNAL', message: 'Unhandled editorial error.' }] } };
};

/**
 * Approving and rejecting are a person's decision in Studio (HeoPress P07a, design §14): an API key — and so an
 * agent or MCP client, which act through one — is refused before any permission is looked at, whatever its scope.
 */
function isMachinePrincipal(auth: AuthPrincipal | undefined): boolean {
  return auth?.type === 'api_key' || auth?.method === 'api_key' || !!auth?.apiKeyId;
}

const HUMAN_REVIEW_REQUIRED = {
  errors: [{ code: 'HUMAN_REVIEW_REQUIRED', message: 'Approving or rejecting needs a person in Studio; API keys, agents and MCP clients cannot decide reviews.' }],
};

/** The site's collections the caller may review (`review` permission). */
async function reviewableCollections(c: Context<AppEnv>): Promise<string[]> {
  const perms = permissionServiceForRequest(c);
  const names = (
    await c.get('db').select({ name: collections.name }).from(collections).where(scopeSite(collections.siteId, c.get('siteId')))
  ).map((r) => r.name);
  const out: string[] = [];
  for (const name of names) if (await perms.canAccess(name, 'review')) out.push(name);
  return out;
}

/** Refusal for a decision the caller may not take, or `null` when it may. */
async function decisionRefusal(c: Context<AppEnv>, collection: string) {
  if (isMachinePrincipal(c.get('auth'))) return { status: 403 as const, body: HUMAN_REVIEW_REQUIRED };
  if (!(await permissionServiceForRequest(c).canAccess(collection, 'review'))) {
    return { status: 403 as const, body: { errors: [{ code: 'FORBIDDEN', message: `Reviewing items of "${collection}" needs the review permission.` }] } };
  }
  return null;
}

const queueSchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  assignedTo: z.string().max(128).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

editorialRouter.get('/reviews', async (c) => {
  const parsed = queueSchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).listReviews({ ...parsed.data, collections: await reviewableCollections(c) });
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

/** `If-Match: "12"` (or `W/"12"`) as a version, else undefined. */
function ifMatchVersion(header: string | undefined): number | undefined {
  const m = header ? /^(?:W\/)?"?(\d{1,9})"?$/.exec(header.trim()) : null;
  return m ? Number(m[1]) : undefined;
}

editorialRouter.post('/:collection/:id/submit-review', async (c) => {
  const parsed = submitSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).submitReview(c.req.param('collection'), c.req.param('id'), {
      ...parsed.data,
      expectedVersion: parsed.data.expectedVersion ?? ifMatchVersion(c.req.header('if-match')),
    });
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

editorialRouter.post('/:collection/:id/approve', async (c) => {
  const refused = await decisionRefusal(c, c.req.param('collection'));
  if (refused) return c.json(refused.body, refused.status);
  const parsed = decideSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).approve(c.req.param('collection'), c.req.param('id'), {
      ...parsed.data,
      expectedVersion: parsed.data.expectedVersion ?? ifMatchVersion(c.req.header('if-match')),
    });
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

editorialRouter.post('/:collection/:id/reject', async (c) => {
  const refused = await decisionRefusal(c, c.req.param('collection'));
  if (refused) return c.json(refused.body, refused.status);
  const parsed = decideSchema.safeParse(await c.req.json().catch(() => ({})));
  // Sending back needs a reason the author can act on (HeoPress P07a task 5.5).
  if (parsed.success && !parsed.data.reason?.trim()) {
    return c.json({ errors: [{ code: 'REASON_REQUIRED', message: 'Say why the item is sent back.' }] }, 400);
  }
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).reject(c.req.param('collection'), c.req.param('id'), {
      ...parsed.data,
      expectedVersion: parsed.data.expectedVersion ?? ifMatchVersion(c.req.header('if-match')),
    });
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});
