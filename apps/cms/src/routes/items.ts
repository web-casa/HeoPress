// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../env';
import { createHash } from 'node:crypto';
import {
  ItemServiceError,
  VersionConflictError,
  type IdempotencyInput,
  parseDeepQueryParams,
  parseFilterQueryParams,
  bulkMaxItems,
} from '../services/item-service';
import { itemServiceForRequest, permissionServiceForRequest } from '../services/item-service-factory';
import { ContentVersionError, ContentVersionService } from '../services/content-version-service';
import { BranchPreviewService } from '../services/rendering/branch-preview-service';
import { PreviewServiceError } from '../services/rendering/preview-service';
import { DependentsError, DependentsService, type ResolveAction } from '../services/dependents-service';
import { formatSafeError } from '@heopress/contracts/utils';
import { requireSiteAdmin } from '../middleware/site-admin';
import { answerGroup, translationGroupServiceFor } from './translation-groups';

/**
 * /items/:collection — generic CRUD over the items store.
 *
 * Phase B implements the full surface (list, detail, create, patch, put,
 * delete, bulk). Permission filtering wraps these handlers in Phase C.
 */

const filterSchema: z.ZodType<unknown> = z.lazy(() =>
  z.record(z.string(), z.unknown()),
);

const listQuerySchema = z.object({
  fields: z.string().optional(),
  filter: z.string().optional(),
  sort: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.string().optional(),
  // Opt out of the `count(*)` total (high-load-cache-readiness Req 5).
  // Defaults to `total_count` to preserve the historical response shape.
  meta: z.enum(['total_count', 'none']).optional(),
});

const scheduleSchema = {
  publishAt: z.string().datetime().nullable().optional(),
  unpublishAt: z.string().datetime().nullable().optional(),
};

const createSchema = z.object({
  data: z.record(z.string(), z.unknown()),
  status: z.string().optional(),
  sort: z.number().int().optional(),
  ...scheduleSchema,
});

const expectedVersionSchema = {
  expectedVersion: z.number().int().min(1).optional(),
  /** Why (P05): required when a published item's sponsor marking changes. */
  reason: z.string().max(1000).optional(),
};

const patchSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  status: z.string().optional(),
  sort: z.number().int().optional(),
  ...scheduleSchema,
  ...expectedVersionSchema,
});

const replaceSchema = createSchema.extend(expectedVersionSchema);

/** A create may carry the item's original first publish time (P05, design R19): site administrators only. */
const createBodySchema = createSchema.extend({ publishedAt: z.string().datetime({ offset: true }).optional() });

const publishedAtSchema = z.object({
  /** The date to record; null confirms the item's current (estimated) date. */
  publishedAt: z.string().datetime({ offset: true }).nullable(),
  ...expectedVersionSchema,
});

/** The site-admin check of a single route, run inline (null: allowed; otherwise the refusal). */
async function siteAdminRefusal(c: Context<AppEnv>): Promise<Response | null> {
  let allowed = false;
  const res = await requireSiteAdmin()(c, async () => {
    allowed = true;
  });
  return allowed ? null : (res as Response);
}

class BadPrecondition extends Error {}

/**
 * The item version an update is based on (P04, spec content/write-concurrency):
 * `If-Match: "12"` (a weak `W/"12"` is accepted too) or `expectedVersion` in
 * the body. Both given and different is a client error. Undefined when
 * neither is present — the service then refuses with 428.
 */
function expectedVersionOf(c: Context<AppEnv>, bodyVersion?: number): number | undefined {
  const header = c.req.header('if-match')?.trim();
  let fromHeader: number | undefined;
  if (header) {
    const m = /^(?:W\/)?"?(\d{1,9})"?$/.exec(header);
    if (!m) throw new BadPrecondition('If-Match must be the item version, e.g. If-Match: "12".');
    fromHeader = Number(m[1]);
  }
  if (fromHeader !== undefined && bodyVersion !== undefined && fromHeader !== bodyVersion) {
    throw new BadPrecondition('If-Match and expectedVersion name different versions.');
  }
  return fromHeader ?? bodyVersion;
}

/**
 * `Idempotency-Key` for content writes (P04, task 9.2): the key is recorded
 * in the write's own transaction, so when a response is lost and the client
 * retries with the same key and body, it gets the item back (200,
 * `Idempotent-Replayed: true`) and nothing is written twice. The same key
 * with a different body is refused (422). Without the header nothing changes.
 */
async function idempotent(
  c: Context<AppEnv>,
  service: ReturnType<typeof buildService>,
  operation: string,
  body: unknown,
  run: (idempotency: IdempotencyInput | undefined) => Promise<unknown>,
): Promise<{ data: unknown; replayed: boolean }> {
  const key = c.req.header('idempotency-key')?.trim();
  if (!key) return { data: await run(undefined), replayed: false };
  if (!/^[\x21-\x7e]{1,255}$/.test(key)) throw new BadPrecondition('Idempotency-Key must be 1–255 visible ASCII characters.');
  const requestHash = createHash('sha256').update(`${operation}\n${c.req.path}\n${JSON.stringify(body)}`).digest('hex');
  const idempotency = { key, requestHash };
  const replay = async () => {
    const done = await service.findIdempotent(idempotency);
    return done ? { data: await service.detail(done.collection, done.itemId), replayed: true } : null;
  };
  const earlier = await replay();
  if (earlier) return earlier;
  try {
    return { data: await run(idempotency), replayed: false };
  } catch (err) {
    // A concurrent request with the same key committed first — whatever this
    // one ran into afterwards (the key, or the version it had moved; Codex
    // review P04-2 #13), the answer is that request's result.
    // A concurrent request that used the key for a different body is that
    // error, not this request's (Codex review P04-3 #10).
    const raced = await replay().catch((replayErr: unknown) => {
      if (replayErr instanceof ItemServiceError && replayErr.code === 'IDEMPOTENCY_KEY_REUSED') throw replayErr;
      return null;
    });
    if (raced) return raced;
    throw err;
  }
}

/** `ETag: "<version>"` for an item response, so clients can send it back as If-Match. */
function withEtag(c: Context<AppEnv>, item: unknown): void {
  const version = (item as { version?: unknown } | null)?.version;
  if (typeof version === 'number') c.header('ETag', `"${version}"`);
}

const bulkSchema = z.object({
  op: z.enum(['create', 'update', 'publish', 'delete']),
  items: z.array(z.record(z.string(), z.unknown())),
});

const buildService = (c: Context<AppEnv>) => itemServiceForRequest(c);

const toError = (err: unknown) => {
  if (err instanceof VersionConflictError) {
    return {
      status: err.status,
      body: {
        errors: [
          {
            code: err.code,
            message: err.message,
            meta: { currentVersion: err.currentVersion, changedFields: err.changedFields },
          },
        ],
      },
    };
  }
  if (err instanceof BadPrecondition) {
    return { status: 400, body: { errors: [{ code: 'BAD_PRECONDITION', message: err.message }] } };
  }
  if (err instanceof ContentVersionError) {
    return { status: err.status, body: { errors: [{ code: err.code, message: err.message, ...(err.details ? { meta: err.details } : {}) }] } };
  }
  if (err instanceof ItemServiceError) {
    return { status: err.status, body: { errors: [{ code: err.code, message: err.message }] } };
  }
  console.error('[items] unexpected error', formatSafeError(err));
  return {
    status: 500 as const,
    body: { errors: [{ code: 'INTERNAL', message: 'Unhandled item error.' }] },
  };
};

export const itemsRouter = new Hono<AppEnv>();

itemsRouter.get('/:collection', async (c) => {
  const searchParams = new URL(c.req.url).searchParams;
  const parsed = listQuerySchema.safeParse(Object.fromEntries(searchParams));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  let filter: never | undefined;
  try {
    // Accepts both `?filter={json}` and `?filter[field][_op]=value` forms.
    filter = parseFilterQueryParams(searchParams, parsed.data.filter) as never | undefined;
  } catch {
    return c.json({ errors: [{ code: 'VALIDATION', message: 'Invalid filter: expected JSON or filter[field][_op]=value syntax.' }] }, 400);
  }
  try {
    const fields = parsed.data.fields ? parsed.data.fields.split(',') : undefined;
    const deep = parseDeepQueryParams(searchParams);
    const sort = parsed.data.sort ? parsed.data.sort.split(',') : undefined;
    const result = await buildService(c).list(c.req.param('collection'), {
      fields,
      deep,
      filter,
      sort,
      limit: parsed.data.limit,
      offset: parsed.data.offset,
      status: parsed.data.status,
      withTotal: parsed.data.meta !== 'none',
    });
    return c.json(result);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.post('/:collection', async (c) => {
  const parsed = createBodySchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  if (parsed.data.publishedAt !== undefined) {
    const refusal = await siteAdminRefusal(c);
    if (refusal) return refusal;
  }
  try {
    const service = buildService(c);
    const { publishedAt, ...rest } = parsed.data;
    const payload = { ...rest, ...(publishedAt ? { publishedAt: new Date(publishedAt) } : {}) };
    const { data, replayed } = await idempotent(c, service, 'create', parsed.data, (idempotency) =>
      service.create(c.req.param('collection'), payload, { idempotency, actorEmail: c.get('auth')?.email ?? null }),
    );
    if (replayed) {
      c.header('Idempotent-Replayed', 'true');
      withEtag(c, data);
      return c.json({ data }, 200);
    }
    withEtag(c, data);
    return c.json({ data }, 201);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.post('/:collection/bulk', async (c) => {
  const parsed = bulkSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).bulk(
      c.req.param('collection'),
      parsed.data.op,
      parsed.data.items,
      { bulkMax: bulkMaxItems(c.env as unknown as Record<string, string | undefined>) },
    );
    // One result per entry (P04): 200 when every entry succeeded or needed
    // no change, 207 Multi-Status otherwise.
    const counts = { succeeded: 0, unchanged: 0, blocked: 0, conflict: 0, failed: 0 };
    for (const r of data) counts[r.status] += 1;
    const partial = counts.blocked + counts.conflict + counts.failed > 0;
    return c.json({ data, meta: counts }, partial ? 207 : 200);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.get('/:collection/:id', async (c) => {
  const searchParams = new URL(c.req.url).searchParams;
  const fields = c.req.query('fields')?.split(',');
  const deep = parseDeepQueryParams(searchParams);
  try {
    const data = await buildService(c).detail(c.req.param('collection'), c.req.param('id'), fields, deep);
    withEtag(c, data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

// The item's translation status per language of the site (HeoPress P05 task 5.6): computed, read only.
itemsRouter.get('/:collection/:id/translation-status', (c) =>
  answerGroup(c, () => translationGroupServiceFor(c).translationStatus(c.req.param('collection'), c.req.param('id'))),
);

// The item's language switch data (HeoPress P05, design D): its translation group's public members.
itemsRouter.get('/:collection/:id/alternates', (c) =>
  answerGroup(c, () => translationGroupServiceFor(c).alternates(c.req.param('collection'), c.req.param('id'))),
);

itemsRouter.patch('/:collection/:id', async (c) => {
  const parsed = patchSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const service = buildService(c);
    const expectedVersion = expectedVersionOf(c, parsed.data.expectedVersion);
    const { data, replayed } = await idempotent(c, service, 'patch', { ...parsed.data, expectedVersion }, (idempotency) =>
      service.patch(c.req.param('collection'), c.req.param('id'), { ...parsed.data, expectedVersion, idempotency }),
    );
    if (replayed) c.header('Idempotent-Replayed', 'true');
    withEtag(c, data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

// Set or confirm an item's first publish time (P05; spec "历史发布日期未知"): site administrators only.
itemsRouter.put('/:collection/:id/published-at', async (c) => {
  const refusal = await siteAdminRefusal(c);
  if (refusal) return refusal;
  const parsed = publishedAtSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).setPublishedAt(c.req.param('collection'), c.req.param('id'), {
      publishedAt: parsed.data.publishedAt === null ? null : new Date(parsed.data.publishedAt),
      expectedVersion: expectedVersionOf(c, parsed.data.expectedVersion),
      actorEmail: c.get('auth')?.email ?? null,
    });
    withEtag(c, data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.put('/:collection/:id', async (c) => {
  const parsed = replaceSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildService(c).replace(c.req.param('collection'), c.req.param('id'), {
      ...parsed.data,
      expectedVersion: expectedVersionOf(c, parsed.data.expectedVersion),
    });
    withEtag(c, data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

function buildDependents(c: Context<AppEnv>): DependentsService {
  const auth = c.get('auth');
  // Request path: DependentsService gets the caller's PermissionService (the
  // authority for its read/update/delete gates) and a permission-carrying
  // ItemService factory rebindable to the batch transaction, so delegated
  // deletes enforce the caller's per-item RBAC — never a system bypass.
  return new DependentsService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    userId: auth?.userId ?? null,
    permissions: permissionServiceForRequest(c),
    itemServiceFactory: (db) => itemServiceForRequest(c, { db }),
  });
}

// DependentsError carries a stable code + HTTP status (403 FORBIDDEN, etc.).
const dependentsError = (err: unknown) =>
  err instanceof DependentsError
    ? { status: err.status, body: { errors: [{ code: err.code, message: err.message }] } }
    : toError(err);

itemsRouter.delete('/:collection/:id', async (c) => {
  const collection = c.req.param('collection');
  const id = c.req.param('id');
  try {
    // Require delete on the target before revealing dependents, then block the
    // delete if a `restrict` relation still has dependents (Req 3).
    const report = await buildDependents(c).report(collection, id, { requireTarget: 'delete' });
    if (report.blocking) {
      return c.json({ errors: [{ code: 'DEPENDENT_RECORDS_EXIST', dependents: report.dependents }] }, 409);
    }
    await buildService(c).softDelete(collection, id);
    return c.body(null, 204);
  } catch (err) {
    const { status, body } = dependentsError(err);
    return c.json(body, status as 400);
  }
});

// Preflight: what references this item? (Req 2) — requires read on the target.
itemsRouter.get('/:collection/:id/dependents', async (c) => {
  try {
    const report = await buildDependents(c).report(c.req.param('collection'), c.req.param('id'), {
      requireTarget: 'read',
    });
    return c.json({ data: report });
  } catch (err) {
    const { status, body } = dependentsError(err);
    return c.json(body, status as 400);
  }
});

// Batch-resolve a relation's dependents before re-deleting. (Req 5-7)
const resolveSchema = z.object({
  action: z.enum(['set_null', 'delete', 'reassign']),
  relation: z.string().min(1),
  newTargetId: z.string().optional(),
  hard: z.boolean().optional(),
});
itemsRouter.post('/:collection/:id/resolve-dependents', async (c) => {
  const parsed = resolveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ errors: [{ code: 'VALIDATION_FAILED', message: parsed.error.issues[0]?.message ?? 'Invalid body.' }] }, 422);
  }
  try {
    const result = await buildDependents(c).applyResolution(
      c.req.param('collection'),
      c.req.param('id'),
      parsed.data.action as ResolveAction,
      parsed.data.relation,
      { newTargetId: parsed.data.newTargetId, hard: parsed.data.hard },
    );
    return c.json({ data: result });
  } catch (err) {
    if (err instanceof DependentsError) {
      return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status as 400);
    }
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.get('/:collection/:id/revisions', async (c) => {
  try {
    const data = await buildService(c).listRevisions(
      c.req.param('collection'),
      c.req.param('id'),
    );
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.post('/:collection/:id/revert/:revisionId', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { expectedVersion?: unknown; reason?: unknown };
    const data = await buildService(c).revertRevision(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('revisionId'),
      expectedVersionOf(c, typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined),
      typeof body.reason === 'string' ? body.reason : undefined,
    );
    withEtag(c, data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

// Hold (P04): a held item is never published, by any path. Setting it needs
// update permission; releasing it needs a person who may publish (403 for API
// keys and agents). Both are version-checked (If-Match or expectedVersion).
for (const [method, hold] of [['post', true], ['delete', false]] as const) {
  itemsRouter[method]('/:collection/:id/hold', async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as { expectedVersion?: unknown };
      const data = await buildService(c).setHold(
        c.req.param('collection'),
        c.req.param('id'),
        hold,
        expectedVersionOf(c, typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined),
      );
      withEtag(c, data);
      return c.json({ data });
    } catch (err) {
      const { status, body } = toError(err);
      return c.json(body, status as 400);
    }
  });
}

// One block by its stable ID (P04): `{ block, expectedVersion }` — one HTML
// element for a rich-text field, one row object for a repeater field.
itemsRouter.patch('/:collection/:id/blocks/:field/:blockId', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as { block?: unknown; expectedVersion?: unknown };
    const data = await buildService(c).patchBlock(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('field'),
      c.req.param('blockId'),
      body.block,
      expectedVersionOf(c, typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined),
    );
    withEtag(c, data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

// Law Zero pins — fields locked against agent writes by a human edit.
itemsRouter.get('/:collection/:id/pins', async (c) => {
  try {
    const data = await buildService(c).listPins(c.req.param('collection'), c.req.param('id'));
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.delete('/:collection/:id/pins/:field', async (c) => {
  try {
    const data = await buildService(c).releasePin(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('field'),
    );
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

// ── Content versions — named parallel draft branches of an item. ──────────────

const buildVersionService = (c: Context<AppEnv>) =>
  new ContentVersionService({
    db: c.get('db'),
    siteId: c.get('siteId'),
    userId: c.get('auth')?.userId ?? null,
    items: buildService(c),
  });

const versionCreateSchema = z.object({ key: z.string().min(1), name: z.string().min(1) });
const versionPatchSchema = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  /** P10: change some fields over the branch's data (the agent tool), instead of replacing it. */
  set: z.record(z.string(), z.unknown()).optional(),
  name: z.string().min(1).optional(),
  /** P10: the branch revision read; a stale one is refused (409 BRANCH_STALE). */
  expectedRevision: z.number().int().min(1).optional(),
});
const versionMergeSchema = z.object({
  expectedMainVersion: z.number().int().min(1),
  expectedRevision: z.number().int().min(1),
  resolutions: z.record(z.string(), z.enum(['main', 'branch'])).optional(),
});

/**
 * Changing a branch, merging it or previewing it needs update permission on the collection now (P10): a branch is
 * proposed content of the item, not something a reader may write.
 */
async function requireBranchWrite(c: Context<AppEnv>, collection: string): Promise<Response | null> {
  const allowed = await permissionServiceForRequest(c).canAccess(collection, 'update');
  return allowed ? null : c.json({ errors: [{ code: 'FORBIDDEN', message: 'You cannot change this collection.' }] }, 403);
}

itemsRouter.get('/:collection/:id/versions', async (c) => {
  try {
    const data = await buildVersionService(c).list(c.req.param('collection'), c.req.param('id'));
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.post('/:collection/:id/versions', async (c) => {
  const refused = await requireBranchWrite(c, c.req.param('collection'));
  if (refused) return refused;
  const parsed = versionCreateSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildVersionService(c).create(
      c.req.param('collection'),
      c.req.param('id'),
      parsed.data.key,
      parsed.data.name,
    );
    return c.json({ data }, 201);
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.get('/:collection/:id/versions/:key', async (c) => {
  try {
    const data = await buildVersionService(c).get(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('key'),
    );
    if (!data) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Version not found' }] }, 404);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.patch('/:collection/:id/versions/:key', async (c) => {
  const refused = await requireBranchWrite(c, c.req.param('collection'));
  if (refused) return refused;
  const parsed = versionPatchSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  }
  try {
    const data = await buildVersionService(c).update(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('key'),
      parsed.data,
    );
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.delete('/:collection/:id/versions/:key', async (c) => {
  const refused = await requireBranchWrite(c, c.req.param('collection'));
  if (refused) return refused;
  try {
    await buildVersionService(c).remove(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('key'),
    );
    return c.json({ data: null });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.get('/:collection/:id/versions/:key/compare', async (c) => {
  try {
    const data = await buildVersionService(c).compare(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('key'),
    );
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.get('/:collection/:id/versions/:key/diff', async (c) => {
  try {
    const data = await buildVersionService(c).diff(c.req.param('collection'), c.req.param('id'), c.req.param('key'));
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

itemsRouter.post('/:collection/:id/versions/:key/merge', async (c) => {
  const refused = await requireBranchWrite(c, c.req.param('collection'));
  if (refused) return refused;
  const parsed = versionMergeSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: `${i.path.join('.')}: ${i.message}` })) }, 400);
  }
  try {
    const data = await buildVersionService(c).merge(c.req.param('collection'), c.req.param('id'), c.req.param('key'), parsed.data);
    return c.json({ data });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});

/**
 * Branch preview on the public site (P10 task 4.2): a one-time link for the caller's browser. Needs the internal
 * secret the rendering service shares (otherwise previews are off: 503).
 */
const branchPreviews = (c: Context<AppEnv>): BranchPreviewService | null => {
  const env = (c.env ?? {}) as unknown as Record<string, string | undefined>;
  const secret = (env.HEOPRESS_INTERNAL_SECRET ?? process.env.HEOPRESS_INTERNAL_SECRET ?? '').trim();
  return secret.length >= 32 ? new BranchPreviewService({ db: c.get('db'), secret, cache: c.get('runtime')?.cache }) : null;
};

itemsRouter.post('/:collection/:id/versions/:key/preview', async (c) => {
  const refused = await requireBranchWrite(c, c.req.param('collection'));
  if (refused) return refused;
  const svc = branchPreviews(c);
  if (!svc) return c.json({ errors: [{ code: 'PREVIEW_DISABLED', message: 'HEOPRESS_INTERNAL_SECRET is not configured.' }] }, 503);
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { ttlSeconds?: unknown };
  try {
    const link = await svc.create({
      siteId: c.get('siteId'),
      userId: c.get('auth')?.userId ?? null,
      collection: c.req.param('collection'),
      itemId: c.req.param('id'),
      key: c.req.param('key'),
      ttlSeconds: body.ttlSeconds,
    });
    return c.json({ data: { id: link.id, url: link.url, expiresAt: link.expiresAt.toISOString() } }, 201);
  } catch (err) {
    if (err instanceof PreviewServiceError) return c.json({ errors: [{ code: err.code, message: err.message }] }, err.status);
    throw err;
  }
});

itemsRouter.delete('/:collection/:id/versions/:key/preview', async (c) => {
  const refused = await requireBranchWrite(c, c.req.param('collection'));
  if (refused) return refused;
  const svc = branchPreviews(c);
  if (!svc) return c.json({ errors: [{ code: 'PREVIEW_DISABLED', message: 'HEOPRESS_INTERNAL_SECRET is not configured.' }] }, 503);
  const admin = (await permissionServiceForRequest(c).bundle()).admin;
  const revoked = await svc.revoke(c.get('siteId'), c.req.param('collection'), c.req.param('id'), c.req.param('key'), { userId: c.get('auth')?.userId ?? null, admin });
  return c.json({ data: { revoked } });
});

itemsRouter.post('/:collection/:id/versions/:key/promote', async (c) => {
  const refused = await requireBranchWrite(c, c.req.param('collection'));
  if (refused) return refused;
  try {
    const body = (await c.req.json().catch(() => ({}))) as { expectedVersion?: unknown; reason?: unknown };
    const { item, mainDiverged } = await buildVersionService(c).promote(
      c.req.param('collection'),
      c.req.param('id'),
      c.req.param('key'),
      expectedVersionOf(c, typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined),
      typeof body.reason === 'string' ? body.reason : undefined,
    );
    withEtag(c, item);
    return c.json({ data: item, meta: { mainDiverged } });
  } catch (err) {
    const { status, body } = toError(err);
    return c.json(body, status as 400);
  }
});
