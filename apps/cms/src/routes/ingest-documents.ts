import { and, desc, eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { ingestSnapshots, ingestSourceDocuments } from '@heopress/database';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { requireSiteEditor } from '../middleware/site-editor';
import { duplicateEvidence } from '../services/ingest/duplicate-evidence';
import { readSnapshot } from '../services/ingest/snapshot-store';
import { PermissionService } from '../services/permission-service';
import { runSiteTransaction } from '../services/rls-transaction';

/**
 * /ingest/documents — source documents (HeoPress P08 tasks 2.5, 2.7).
 *
 *   GET /               the latest source documents (editors), with duplicate and event-cluster flags (task 4.x).
 *   GET /:id/duplicate  the near-duplicate evidence (editors); another site's document only for a caller who has
 *                       rights there now (live check), otherwise an anonymous flag (task 4.3).
 *   GET /:id/snapshot   the raw HTML snapshot, administrators only, as a download.
 *
 * A snapshot is untrusted HTML from another site: it is never rendered by the CMS, the Studio or a public media
 * domain. This route sends it as an attachment of type `application/octet-stream` with `nosniff` and a sandboxing
 * Content-Security-Policy, so a browser that opens it anyway runs nothing.
 */
export const ingestDocumentsRouter = new Hono<AppEnv>();

ingestDocumentsRouter.get('/:id/snapshot', requireSiteAdmin(), async (c) => {
  const siteId = c.get('siteId');
  const [row] = await c
    .get('db')
    .select({ key: ingestSnapshots.storageKey, sha256: ingestSnapshots.sha256 })
    .from(ingestSourceDocuments)
    .innerJoin(ingestSnapshots, and(eq(ingestSnapshots.siteId, ingestSourceDocuments.siteId), eq(ingestSnapshots.id, ingestSourceDocuments.snapshotId)))
    .where(and(eq(ingestSourceDocuments.siteId, siteId), eq(ingestSourceDocuments.id, c.req.param('id'))));
  if (!row) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Source document not found.' }] }, 404);
  const bytes = await readSnapshot(c.get('runtime').storage, row.key);
  if (!bytes) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'The snapshot is no longer stored.' }] }, 404);
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="snapshot-${row.sha256.slice(0, 16)}.html"`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
    },
  });
});

ingestDocumentsRouter.get('/', requireSiteEditor(), async (c) => {
  const siteId = c.get('siteId');
  const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 50) || 50, 1), 200);
  const rows = await runSiteTransaction(c.get('db'), siteId, (tx) =>
    tx
      .select({
        id: ingestSourceDocuments.id,
        sourceId: ingestSourceDocuments.sourceId,
        title: ingestSourceDocuments.title,
        url: ingestSourceDocuments.url,
        createdAt: ingestSourceDocuments.createdAt,
        nearDuplicateCheck: ingestSourceDocuments.nearDuplicateCheck,
        duplicateScope: ingestSourceDocuments.duplicateScope,
        eventClusterId: ingestSourceDocuments.eventClusterId,
        clusterRole: ingestSourceDocuments.clusterRole,
      })
      .from(ingestSourceDocuments)
      .where(and(eq(ingestSourceDocuments.siteId, siteId), ...(c.req.query('sourceId') ? [eq(ingestSourceDocuments.sourceId, c.req.query('sourceId')!)] : [])))
      .orderBy(desc(ingestSourceDocuments.createdAt))
      .limit(limit),
  );
  return c.json({ data: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })) });
});

/** Whether the caller may read another site's source documents: an editor or administrator there, checked live. */
export async function canReadOtherSite(c: Context<AppEnv>, otherSiteId: string): Promise<boolean> {
  const auth = c.get('auth');
  if (!auth || auth.type === 'anonymous' || (!auth.userId && !auth.apiKeyId)) return false;
  const bundle = await new PermissionService({
    db: c.get('db'),
    // No cache: membership and roles as they are now.
    ctx: {
      userId: auth.userId ?? null,
      siteId: otherSiteId,
      roleId: null,
      user: auth.userId ? { id: auth.userId, email: auth.email ?? null, roles: [] } : undefined,
      ip: c.get('ip') ?? null,
      headers: {},
      apiKey: auth.apiKey ?? null,
    },
  }).bundle();
  return bundle.admin || Object.values(bundle.byKey).some((p) => p.action === 'create' || p.action === 'update');
}

ingestDocumentsRouter.get('/:id/duplicate', requireSiteEditor(), async (c) => {
  const evidence = await duplicateEvidence(c.get('db'), c.get('siteId'), c.req.param('id'), (other) => canReadOtherSite(c, other));
  if (!evidence) return c.json({ errors: [{ code: 'NOT_FOUND', message: 'Source document not found.' }] }, 404);
  return c.json({ data: evidence });
});
