import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { TRANSLATION_LIMITS } from '@heopress/contracts/extensions';
import { LocaleTagSchema, sameLocale } from '@heopress/contracts/schemas';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { requireSiteMember } from '../middleware/site-member';
import { TranslationJobService } from '../services/translation-job-service';
import {
  TranslationJobNotFoundError,
  TranslationJobStateError,
  translationJobResource,
  type TranslationJobActor,
} from '../services/translation-job-service';

/**
 * A site's durable translation jobs (HeoPress v1.4, spec `ai/translation-jobs`).
 *
 *   POST   /api/v1/translation/jobs            create a job and enqueue it
 *   GET    /api/v1/translation/jobs            list (`?status=&locale=&limit=&offset=`)
 *   GET    /api/v1/translation/jobs/:id        one job with every segment's state
 *   POST   /api/v1/translation/jobs/:id/retry  retry a failed or cancelled job (fresh call-key epoch)
 *   POST   /api/v1/translation/jobs/:id/cancel cancel a queued or running job
 *
 * The site is always the request's (`c.get('siteId')`), never the body; reads are for the site's members and every
 * change for its administrators (the same split as the glossary). The worker owns execution; this router only creates
 * work, shows it and asks for a retry or a cancellation, and records each change in the site's audit trail.
 */

export const translationJobsRouter = new Hono<AppEnv>();
translationJobsRouter.use('*', async (c, next) =>
  c.req.method === 'GET' ? requireSiteMember()(c, next) : requireSiteAdmin()(c, next),
);

const SegmentSchema = z.object({
  id: z.string().trim().min(1).max(64),
  text: z.string().min(1).max(TRANSLATION_LIMITS.segmentTextChars),
});

const CreateJobSchema = z
  .object({
    sourceLocale: LocaleTagSchema,
    targetLocale: LocaleTagSchema,
    segments: z.array(SegmentSchema).min(1).max(TRANSLATION_LIMITS.segments.max),
  })
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    for (const [index, segment] of value.segments.entries()) {
      if (ids.has(segment.id)) {
        ctx.addIssue({ code: 'custom', message: `Duplicate segment id "${segment.id}".`, path: ['segments', index, 'id'] });
      }
      ids.add(segment.id);
    }
    if (sameLocale(value.sourceLocale, value.targetLocale)) {
      ctx.addIssue({ code: 'custom', message: 'The source and target locales are the same.', path: ['targetLocale'] });
    }
  });

const ListQuerySchema = z.object({
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']).optional(),
  locale: LocaleTagSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function validation(c: Context<AppEnv>, issues: ReadonlyArray<{ message: string; path: PropertyKey[] }>): Response {
  return c.json(
    { errors: issues.map((issue) => ({ code: 'VALIDATION', message: issue.message, path: issue.path.map(String) })) },
    400,
  );
}

function notFound(c: Context<AppEnv>): Response {
  return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Translation job not found' }] }, 404);
}

/** The audit actor of the request: who, from where, and under which request id — never a secret. */
function actorOf(c: Context<AppEnv>): TranslationJobActor {
  const auth = c.get('auth');
  return {
    email: auth?.email ?? null,
    userId: auth?.userId ?? null,
    ip: c.get('ip') ?? null,
    userAgent: c.get('userAgent') ?? null,
    requestId: c.get('requestId') ?? null,
  };
}

function service(c: Context<AppEnv>): TranslationJobService {
  return new TranslationJobService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    queue: c.get('runtime')?.queue,
  });
}

// ── POST /translation/jobs ──────────────────────────────────────────────────

translationJobsRouter.post('/', async (c) => {
  const parsed = CreateJobSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return validation(c, parsed.error.issues);
  const job = await service(c).create(
    { sourceLocale: parsed.data.sourceLocale, targetLocale: parsed.data.targetLocale, segments: parsed.data.segments },
    actorOf(c),
  );
  return c.json({ data: translationJobResource(job) }, 201);
});

// ── GET /translation/jobs ───────────────────────────────────────────────────

translationJobsRouter.get('/', async (c) => {
  const parsed = ListQuerySchema.safeParse(c.req.query());
  if (!parsed.success) return validation(c, parsed.error.issues);
  const { rows, total } = await service(c).list(parsed.data);
  return c.json({
    data: rows.map((row) => translationJobResource(row)),
    meta: { total, limit: parsed.data.limit, offset: parsed.data.offset },
  });
});

// ── GET /translation/jobs/:id ───────────────────────────────────────────────

translationJobsRouter.get('/:id', async (c) => {
  const job = await service(c).get(c.req.param('id'));
  return job ? c.json({ data: translationJobResource(job) }) : notFound(c);
});

// ── POST /translation/jobs/:id/retry ────────────────────────────────────────

translationJobsRouter.post('/:id/retry', async (c) => {
  try {
    const job = await service(c).retry(c.req.param('id'), actorOf(c));
    return c.json({ data: translationJobResource(job) });
  } catch (err) {
    if (err instanceof TranslationJobNotFoundError) return notFound(c);
    if (err instanceof TranslationJobStateError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, 409);
    }
    throw err;
  }
});

// ── POST /translation/jobs/:id/cancel ───────────────────────────────────────

translationJobsRouter.post('/:id/cancel', async (c) => {
  try {
    const job = await service(c).cancel(c.req.param('id'), actorOf(c));
    return c.json({ data: translationJobResource(job) });
  } catch (err) {
    if (err instanceof TranslationJobNotFoundError) return notFound(c);
    if (err instanceof TranslationJobStateError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, 409);
    }
    throw err;
  }
});
