import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { ingestSnapshots, ingestSourceDocuments } from '@heopress/database';
import type { AppEnv } from '../env';
import { requireSiteAdmin } from '../middleware/site-admin';
import { readSnapshot } from '../services/ingest/snapshot-store';

/**
 * /ingest/documents — source documents (HeoPress P08 tasks 2.5, 2.7).
 *
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
