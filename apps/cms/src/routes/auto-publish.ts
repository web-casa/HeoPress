import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { requireSiteEditor } from '../middleware/site-editor';
import { AutoPublishError, AutoPublisher } from '../services/auto-publish/auto-publish';
import { LocaleSetService } from '../services/auto-publish/locale-set-service';
import { ItemServiceError } from '../services/item-service-error';
import { itemServiceForRequest } from '../services/item-service-factory';
import { patchSchema } from '../utils/patch-schema';

/**
 * /auto-publish — auto-publish, the review queue and the veto window (HeoPress P09 tasks 3.1–3.7; spec ai/auto-publish).
 * What the Studio review screen reads and does:
 *
 *   GET  /settings                          agent role, veto window, cadence, source age, required languages (editors)
 *   PUT  /settings                          change them (site administrators; audited; pending candidates decided under
 *                                           the old settings go back to review at their final check)
 *   GET  /candidates?status=review          the review queue (`review`), veto windows (`veto_window`), the queue
 *                                           (`queued`), history (`published`, `superseded`, `dismissed`) (editors)
 *   GET  /candidates/:id                    one candidate, with every unmet condition (editors)
 *   POST /candidates/:id/veto               {reason?}: one-click veto of a pending publish (signed-in editors)
 *   POST /candidates/:id/dismiss            {reason}: close a review entry (signed-in editors)
 *   POST /run-due                           publish what is due now (site administrators; the scheduler does it each minute)
 *   POST /locale-sets/:itemId/publish       publish the item's required language set on this site, all or none
 *   POST /locale-sets/:itemId/unpublish     unpublish the set together
 *   POST /locale-sets/:itemId/single        {action: publish|unpublish, reason}: the single-language exception (needs
 *                                           publish permission on the item; never bypasses gate, Hold, licence, kill switch)
 */
export const autoPublishRouter = new Hono<AppEnv>();

const publisherOf = (c: Context<AppEnv>) => new AutoPublisher({ db: c.get('db'), siteId: c.get('siteId') });

async function run(c: Context<AppEnv>, fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AutoPublishError) {
      const problems = (err as AutoPublishError & { problems?: unknown }).problems;
      return c.json({ errors: [{ code: err.code, message: err.message, ...(problems ? { problems } : {}) }] }, err.status);
    }
    if (err instanceof ItemServiceError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    throw err;
  }
}

/** A person, signed in, not through an API key. */
function person(c: Context<AppEnv>): string | null {
  const auth = c.get('auth');
  return auth?.userId && !auth.apiKeyId ? auth.userId : null;
}
const notPerson = (c: Context<AppEnv>) => c.json({ errors: [{ code: 'FORBIDDEN', message: 'Only a signed-in person can do this.' }] }, 403);

async function body<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<{ data: T } | { error: Response }> {
  const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return { error: c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message, path: i.path })) }, 400) };
  return { data: parsed.data };
}

const SettingsSchema = patchSchema(
  z.object({
    agentRole: z.string().trim().min(1).max(100),
    vetoWindowMinutes: z.number().int(),
    dailyLimit: z.number().int().nullable(),
    minIntervalMinutes: z.number().int(),
    sourceMaxAgeDays: z.number().int(),
    freshnessExemptCollections: z.array(z.string().min(1).max(100)).max(100),
    requiredLocales: z.array(z.string().min(2).max(35)).max(50),
  }),
);
const ReasonSchema = z.object({ reason: z.string().trim().min(1).max(2000) });
const VetoSchema = z.object({ reason: z.string().trim().max(2000).optional() });
const SingleSchema = z.object({ action: z.enum(['publish', 'unpublish']), reason: z.string().trim().min(1).max(2000) });

autoPublishRouter.get('/settings', requireSiteEditor(), (c) => run(c, async () => c.json({ data: await publisherOf(c).settings() })));

autoPublishRouter.put('/settings', requireSiteAdmin(), (c) =>
  run(c, async () => {
    const input = await body(c, SettingsSchema);
    if ('error' in input) return input.error;
    return c.json({ data: await publisherOf(c).updateSettings(input.data, c.get('auth')?.userId ?? null) });
  }),
);

autoPublishRouter.get('/candidates', requireSiteEditor(), (c) =>
  run(c, async () => c.json({ data: await publisherOf(c).list({ status: c.req.query('status') || undefined, limit: Number(c.req.query('limit')) || undefined }) })),
);

autoPublishRouter.get('/candidates/:id', requireSiteEditor(), (c) => run(c, async () => c.json({ data: await publisherOf(c).get(c.req.param('id')) })));

autoPublishRouter.post('/candidates/:id/veto', requireSiteEditor(), (c) =>
  run(c, async () => {
    const userId = person(c);
    if (!userId) return notPerson(c);
    const input = await body(c, VetoSchema);
    if ('error' in input) return input.error;
    return c.json({ data: await publisherOf(c).veto(c.req.param('id'), userId, input.data.reason) });
  }),
);

autoPublishRouter.post('/candidates/:id/dismiss', requireSiteEditor(), (c) =>
  run(c, async () => {
    const userId = person(c);
    if (!userId) return notPerson(c);
    const input = await body(c, ReasonSchema);
    if ('error' in input) return input.error;
    return c.json({ data: await publisherOf(c).dismiss(c.req.param('id'), userId, input.data.reason) });
  }),
);

autoPublishRouter.post('/run-due', requireSiteAdmin(), (c) => run(c, async () => c.json({ data: await publisherOf(c).processDue() })));

const localeSets = (c: Context<AppEnv>, userId: string) =>
  new LocaleSetService({ db: c.get('db'), siteId: c.get('siteId'), userId, itemsOn: (tx) => itemServiceForRequest(c, { db: tx as never, localeSetWrite: true }) });

autoPublishRouter.post('/locale-sets/:itemId/publish', requireSiteEditor(), (c) =>
  run(c, async () => {
    const userId = person(c);
    if (!userId) return notPerson(c);
    return c.json({ data: await localeSets(c, userId).publishSet(c.req.param('itemId')) });
  }),
);

autoPublishRouter.post('/locale-sets/:itemId/unpublish', requireSiteEditor(), (c) =>
  run(c, async () => {
    const userId = person(c);
    if (!userId) return notPerson(c);
    return c.json({ data: await localeSets(c, userId).unpublishSet(c.req.param('itemId')) });
  }),
);

autoPublishRouter.post('/locale-sets/:itemId/single', requireSiteEditor(), (c) =>
  run(c, async () => {
    const userId = person(c);
    if (!userId) return notPerson(c);
    const input = await body(c, SingleSchema);
    if ('error' in input) return input.error;
    return c.json({ data: await localeSets(c, userId).single(c.req.param('itemId'), input.data.action, input.data.reason) });
  }),
);
