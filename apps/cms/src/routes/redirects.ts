import { and, asc, count, eq, inArray } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { redirects } from '@heopress/database';
import type { AppEnv } from '../env';
import { resolveMaxJsonBody } from '../middleware/body-limit';
import { requireSiteAdmin } from '../middleware/site-admin';
import { appendItemEvent } from '../modules/cdc/change-feed/outbox-writer';
import { runSiteTransaction } from '../services/rls-transaction';
import { dryRunRedirectImport, importRedirects, MAX_IMPORT_BYTES, RedirectImportError } from '../services/site-network/redirect-import';
import { loadSpace, lockAddressSpace, rejectedRuleIds, RedirectConflictError } from '../services/site-network/site-rules';

/**
 * /redirects — the site's stored redirect rules (HeoPress P05; design B,
 * R34–R36). Site administrators only.
 *
 * - `GET /` lists them (`scope`, `limit` ≤ 500, `offset`); `?check=1` adds
 *   the rules the termination check does not accept, with the reason — for
 *   the WHOLE site, whatever the page (it checks every rule: ask once per
 *   review, not per page).
 * - `POST /delete` removes rules by id, all in one transaction under the
 *   settings lock. Removing rules never closes a loop (it only removes
 *   dependencies), so a deletion is never refused: it is how a site with
 *   rules that cannot take effect — which block settings changes — is
 *   repaired, several independent loops at once. The answer lists what is
 *   still not accepted.
 *
 * - `POST /import?dryRun=1` reads an export file (`{ content, format?,
 *   importConflicting? }`; CSV, Redirection JSON/CSV, Yoast, Rank Math) and
 *   answers the report; `POST /import` with the report's `reportHash`
 *   imports it, or answers 409 when the site changed since (tasks 1.7, 1.8;
 *   services/site-network/redirect-import.ts).
 */

export const redirectsRouter = new Hono<AppEnv>();
redirectsRouter.use('*', requireSiteAdmin());

const listQuery = z.object({
  scope: z.enum(['url', 'content']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  check: z.enum(['0', '1']).optional(),
});

const deleteBody = z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(1000) });

const rejectedList = (rejected: Map<string, string>) => [...rejected].map(([id, reason]) => ({ id, reason }));

redirectsRouter.get('/', async (c) => {
  const parsed = listQuery.safeParse(c.req.query());
  if (!parsed.success) return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  const { scope, limit, offset, check } = parsed.data;
  const siteId = c.get('siteId');
  const result = await runSiteTransaction(c.get('db'), siteId, async (tx) => {
    const where = and(eq(redirects.siteId, siteId), scope ? eq(redirects.scope, scope) : undefined);
    const rows = await tx.select().from(redirects).where(where).orderBy(asc(redirects.scope), asc(redirects.locale), asc(redirects.fromPath), asc(redirects.match), asc(redirects.id)).limit(limit).offset(offset);
    const [total] = await tx.select({ n: count() }).from(redirects).where(where);
    const rejected = check === '1' ? rejectedList(await rejectedRuleIds(tx, siteId, await loadSpace(tx, siteId))) : undefined;
    return { rows, total: total?.n ?? 0, rejected };
  });
  return c.json({
    data: result.rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      locale: r.locale,
      fromPath: r.fromPath,
      match: r.match,
      toPath: r.toPath,
      toLocale: r.toLocale,
      status: r.status,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    })),
    meta: { total: result.total, limit, offset, ...(result.rejected ? { rejected: result.rejected } : {}) },
  });
});

redirectsRouter.post('/delete', async (c) => {
  const parsed = deleteBody.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  const siteId = c.get('siteId');
  const result = await runSiteTransaction(c.get('db'), siteId, async (tx) => {
    await lockAddressSpace(tx, siteId);
    const gone = await tx
      .delete(redirects)
      .where(and(eq(redirects.siteId, siteId), inArray(redirects.id, parsed.data.ids)))
      .returning({ id: redirects.id });
    if (gone.length > 0) {
      await appendItemEvent(tx, {
        siteId,
        resource: 'redirect',
        collection: '$redirects',
        itemId: gone[0]!.id,
        itemVersion: null,
        changedFields: ['redirects'],
        operation: 'delete',
        source: 'api',
        payload: { ids: gone.map((g) => g.id) },
      });
    }
    const rejected = await rejectedRuleIds(tx, siteId, await loadSpace(tx, siteId));
    return { deleted: gone.map((g) => g.id), rejected: rejectedList(rejected) };
  });
  return c.json({ data: result });
});

const importBody = z.object({
  content: z.string().min(1).max(MAX_IMPORT_BYTES),
  format: z.enum(['csv', 'redirection', 'yoast', 'rank_math']).optional(),
  importConflicting: z.boolean().optional(),
  reportHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

/**
 * The request body, read up to the app's JSON body limit (HEOPRESS_MAX_JSON_BODY, 1 MiB by default) by the bytes
 * actually received — a request without Content-Length cannot slip past the global guard. Null when larger.
 */
async function readLimited(c: Context<AppEnv>): Promise<string | null> {
  const limit = resolveMaxJsonBody((c.env as Partial<AppEnv['Bindings']> | undefined)?.HEOPRESS_MAX_JSON_BODY ?? process.env.HEOPRESS_MAX_JSON_BODY);
  const reader = c.req.raw.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

redirectsRouter.post('/import', async (c) => {
  const raw = await readLimited(c);
  if (raw === null) {
    return c.json({ errors: [{ code: 'PAYLOAD_TOO_LARGE', message: 'The import is larger than the request limit (HEOPRESS_MAX_JSON_BODY); split the file.' }] }, 413);
  }
  let json: unknown = {};
  try {
    json = JSON.parse(raw);
  } catch {
    json = {};
  }
  const parsed = importBody.safeParse(json);
  if (!parsed.success) return c.json({ errors: parsed.error.issues.map((i) => ({ code: 'VALIDATION', message: i.message })) }, 400);
  const { content, format, importConflicting, reportHash } = parsed.data;
  const siteId = c.get('siteId');
  const dryRun = c.req.query('dryRun') === '1';
  try {
    if (dryRun) return c.json({ data: await dryRunRedirectImport(c.get('db'), siteId, content, { format, importConflicting }) });
    if (!reportHash) {
      return c.json({ errors: [{ code: 'REPORT_REQUIRED', message: "Run the dry run first (?dryRun=1) and send its reportHash." }] }, 428);
    }
    const auth = c.get('auth');
    const result = await importRedirects(c.get('db'), siteId, content, {
      format,
      importConflicting,
      reportHash,
      actor: { userId: auth?.userId ?? null, email: auth?.email ?? null },
    });
    return c.json({ data: result }, 201);
  } catch (err) {
    if (err instanceof RedirectImportError) {
      return c.json({ errors: [{ code: err.code, message: err.message }], ...(err.report ? { data: err.report } : {}) }, err.status);
    }
    if (err instanceof RedirectConflictError) return c.json({ errors: [{ code: err.code, message: err.message, rules: err.rules }] }, 409);
    throw err;
  }
});
