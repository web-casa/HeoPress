/**
 * /review-queue — the items that need a human (HeoPress v1.1; spec content/stale-content-queue).
 *
 *   GET /?collection=&limit=   manual marks, automatic marks and items awaiting review, with per-group counts
 *
 * Site-scoped: the request's site is the only one read, and each collection is read with the caller's own row rule
 * (the review workspace's shape), so the queue cannot leak an item the caller could not open. The page is capped
 * (`limit`, default 50, max 200) and `truncated` says whether more matched; the counts cover the rows on the page.
 */

import { Hono, type Context } from 'hono';
import type { AppEnv } from '../env';
import { ItemServiceError } from '../services/item-service-error';
import { permissionServiceForRequest } from '../services/item-service-factory';
import { reviewQueue, REVIEW_QUEUE_MAX_LIMIT } from '../services/staleness/queue';

export const reviewQueueRouter = new Hono<AppEnv>();

const bad = (c: Context<AppEnv>, message: string) => c.json({ errors: [{ code: 'VALIDATION', message }] }, 400);

reviewQueueRouter.get('/', async (c) => {
  const raw = c.req.query('limit');
  let limit: number | undefined;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) return bad(c, `limit must be an integer between 1 and ${REVIEW_QUEUE_MAX_LIMIT}.`);
    // Over the maximum is clamped, not refused: the caller asked for "the most you will give me", not an error.
    limit = parsed;
  }
  try {
    const data = await reviewQueue(c.get('db'), c.get('siteId'), permissionServiceForRequest(c), {
      collection: c.req.query('collection') || undefined,
      limit,
    });
    return c.json({ data });
  } catch (err) {
    if (err instanceof ItemServiceError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    throw err;
  }
});
