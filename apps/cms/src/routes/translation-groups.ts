import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { LocaleTagSchema } from '@heopress/contracts/schemas';
import type { AppEnv } from '../env';
import { ItemServiceError } from '../services/item-service-error';
import { itemServiceForPersonOnSite, itemServiceForRequest, itemServiceForTrigger } from '../services/item-service-factory';
import { TranslationGroupService } from '../services/site-network/translation-group-service';

/**
 * /translation-groups — translation groups (HeoPress P05 tasks 4.1–4.5;
 * spec i18n/translation-groups; design D). The request's site is the one the
 * group is seen from: a group is reachable from every site with a member.
 *
 * - `GET /?item=<id>` the group of an item of this site (`null`: none).
 * - `GET /:id` the group: members the caller may read in full, the others
 *   as the public sees them (`public`), or nothing.
 * - `POST /` `{ itemId }` a new group with this item as its source.
 * - `POST /:id/members` `{ itemId, siteId?, expectedVersion }` add an item
 *   (another site's only for a person, with both sites' switch on).
 * - `DELETE /:id/members/:itemId?expectedVersion=` take one out.
 * - `PUT /:id/source` `{ itemId, expectedVersion }` make a member the source.
 * - `PUT /:id/members/:itemId/internal-only` `{ internalOnly, expectedVersion }`.
 * - `POST /:id/members/:itemId/apply-shared` apply the member's blocked shared
 *   field sync as the caller (P05 task 4.6).
 * - `POST /:id/block-map` `{ targetItemId, pairs: [{ sourceKey, targetKey }] }`
 *   write block maps from the source to a translation (P05 task 5.1).
 * - `POST /:id/block-map/accept` `{ targetItemId, expectedTargetVersion, keys? }`
 *   a person accepts the translation as up to date.
 * - `POST /:id/drafts` `{ locale }` a new translation draft on this site, with
 *   the source's SEO fields copied (never its canonical URL) (P05 task 5.5).
 *
 * Every change needs update permission on every item of the group (and the
 * one joining), checked on each item's own site; ItemService errors keep
 * their status (403, 404, 409).
 */

export const translationGroupsRouter = new Hono<AppEnv>();

export const translationGroupServiceFor = (c: Context<AppEnv>) =>
  new TranslationGroupService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    userId: c.get('auth')?.userId ?? null,
    actor: c.get('auth')?.apiKeyId
      ? { type: 'api_key', id: c.get('auth').apiKeyId! }
      : c.get('auth')?.userId
        ? { type: 'user', id: c.get('auth').userId! }
        : undefined,
    itemsOn: (siteId, tx) =>
      siteId === c.get('siteId') ? itemServiceForRequest(c, { db: tx as never, rootDb: c.get('db') }) : itemServiceForPersonOnSite(c, siteId, tx as never),
    personOn: (userId, siteId, tx) =>
      itemServiceForTrigger({ rootDb: c.get('db'), cache: c.get('runtime').cache, queue: c.get('runtime').queue }, { type: 'user', id: userId }, siteId, tx as never),
  });

export const answerGroup = async (c: Context<AppEnv>, run: () => Promise<unknown>, status: 200 | 201 = 200) => {
  try {
    return c.json({ data: await run() }, status);
  } catch (err) {
    if (err instanceof ItemServiceError) {
      const details = (err as ItemServiceError & { details?: unknown }).details;
      return c.json({ errors: [{ code: err.code, message: err.message, ...(details ? { details } : {}) }] }, err.status as 409);
    }
    throw err;
  }
};

const versionSchema = z.number().int().positive();
const bad = (c: Context<AppEnv>, message: string) => c.json({ errors: [{ code: 'VALIDATION', message }] }, 400);

translationGroupsRouter.get('/', (c) => {
  const item = c.req.query('item');
  if (!item) return bad(c, 'Give ?item=<item id>.');
  return answerGroup(c, () => translationGroupServiceFor(c).forItem(item));
});

translationGroupsRouter.get('/:id', (c) => answerGroup(c, () => translationGroupServiceFor(c).get(c.req.param('id'))));

translationGroupsRouter.post('/', async (c) => {
  const body = z.object({ itemId: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return bad(c, 'Give { itemId }.');
  return answerGroup(c, () => translationGroupServiceFor(c).create(body.data.itemId), 201);
});

translationGroupsRouter.post('/:id/members', async (c) => {
  const body = z
    .object({ itemId: z.string().min(1), siteId: z.string().min(1).optional(), expectedVersion: versionSchema })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return bad(c, 'Give { itemId, siteId?, expectedVersion }.');
  return answerGroup(c, () => translationGroupServiceFor(c).addMember(c.req.param('id'), body.data));
});

translationGroupsRouter.delete('/:id/members/:itemId', (c) => {
  const v = versionSchema.safeParse(Number(c.req.query('expectedVersion')));
  if (!v.success) return bad(c, 'Give ?expectedVersion=<group version>.');
  return answerGroup(c, () => translationGroupServiceFor(c).removeMember(c.req.param('id'), c.req.param('itemId'), v.data));
});

translationGroupsRouter.put('/:id/source', async (c) => {
  const body = z.object({ itemId: z.string().min(1), expectedVersion: versionSchema }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return bad(c, 'Give { itemId, expectedVersion }.');
  return answerGroup(c, () => translationGroupServiceFor(c).setSource(c.req.param('id'), body.data.itemId, body.data.expectedVersion));
});

// The group's x-default member (P07 task 2.2): { itemId: null } clears it.
translationGroupsRouter.put('/:id/x-default', async (c) => {
  const body = z.object({ itemId: z.string().min(1).nullable(), expectedVersion: versionSchema }).strict().safeParse(await c.req.json().catch(() => null));
  if (!body.success) return bad(c, 'Give { itemId (null to clear), expectedVersion }.');
  return answerGroup(c, () => translationGroupServiceFor(c).setXDefault(c.req.param('id'), body.data.itemId, body.data.expectedVersion));
});

translationGroupsRouter.put('/:id/members/:itemId/internal-only', async (c) => {
  const body = z.object({ internalOnly: z.boolean(), expectedVersion: versionSchema }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return bad(c, 'Give { internalOnly, expectedVersion }.');
  return answerGroup(c, () =>
    translationGroupServiceFor(c).setInternalOnly(c.req.param('id'), c.req.param('itemId'), body.data.internalOnly, body.data.expectedVersion),
  );
});

translationGroupsRouter.post('/:id/members/:itemId/apply-shared', (c) =>
  answerGroup(c, () => translationGroupServiceFor(c).applyShared(c.req.param('id'), c.req.param('itemId'))),
);

const mapSchema = z.object({
  targetItemId: z.string().min(1),
  pairs: z.array(z.object({ sourceKey: z.string().min(1), targetKey: z.string().min(1) })).max(2000),
});
translationGroupsRouter.post('/:id/block-map', async (c) => {
  const body = mapSchema.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return bad(c, 'Give { targetItemId, pairs: [{ sourceKey, targetKey }] }.');
  return answerGroup(c, () => translationGroupServiceFor(c).writeMaps(c.req.param('id'), body.data));
});

translationGroupsRouter.post('/:id/block-map/accept', async (c) => {
  const body = z
    .object({ targetItemId: z.string().min(1), expectedTargetVersion: versionSchema, keys: z.array(z.string().min(1)).optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!body.success) return bad(c, 'Give { targetItemId, expectedTargetVersion, keys? }.');
  return answerGroup(c, () => translationGroupServiceFor(c).acceptMaps(c.req.param('id'), body.data));
});

translationGroupsRouter.post('/:id/drafts', async (c) => {
  const body = z.object({ locale: LocaleTagSchema }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) return bad(c, 'Give { locale } (a BCP 47 language tag).');
  return answerGroup(c, () => translationGroupServiceFor(c).createDraft(c.req.param('id'), body.data), 201);
});
