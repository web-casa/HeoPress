import { readFileSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { schema, type Database } from '@heopress/database';
import { createSiteClassic } from './app';

/**
 * `site-classic` entry (HeoPress P06 task 1.1): connect as the rendering role and serve every public
 * site on one port. Configuration:
 *
 *   DATABASE_URL               the rendering role (`pnpm --filter @heopress/database app-role --render`)
 *   PORT                       default 2027
 *   HEOPRESS_TRUSTED_PROXIES   peers whose X-Forwarded-Host counts (addresses / CIDR, comma-separated)
 *   HEOPRESS_PREVIEW_ORIGIN    the preview origin (previews are off without it), with
 *   HEOPRESS_CMS_INTERNAL_URL  the CMS as this service reaches it, and HEOPRESS_INTERNAL_SECRET (the same as the CMS's);
 *   HEOPRESS_PREVIEW_MEDIA_ORIGINS  origins preview pages may load images from (comma-separated);
 *   HEOPRESS_PUBLIC_URL        the administration origin (the preview origin must differ)
 *
 * DATABASE_URL and HEOPRESS_INTERNAL_SECRET may come from files instead (`DATABASE_URL_FILE`, …).
 */
/** `NAME`, or the contents of the file `NAME_FILE` names (Docker secrets). */
function env(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (!process.env[name] && file) return readFileSync(file, 'utf8').trim();
  return process.env[name];
}

const url = env('DATABASE_URL');
if (!url) {
  console.error('[site-classic] DATABASE_URL (the rendering role) is required.');
  process.exit(1);
}
const client = postgres(url, { max: Number(process.env.HEOPRESS_RENDER_DB_POOL ?? 10), onnotice: () => {} });
const db = drizzle(client, { schema }) as unknown as Database;
// AI traffic is written on a pool of its own (P07 task 6.4): its writes never take a connection a page needs.
const trafficClient = postgres(url, { max: 2, onnotice: () => {} });
const trafficDb = drizzle(trafficClient, { schema }) as unknown as Database;
const previewOrigin = process.env.HEOPRESS_PREVIEW_ORIGIN?.trim();
const { app, close } = createSiteClassic({
  db,
  trafficDb,
  trustedProxies: process.env.HEOPRESS_TRUSTED_PROXIES,
  preview: previewOrigin
    ? {
        origin: previewOrigin,
        cmsUrl: process.env.HEOPRESS_CMS_INTERNAL_URL?.trim() || 'http://cms:1989',
        secret: env('HEOPRESS_INTERNAL_SECRET')?.trim() ?? '',
        media: (process.env.HEOPRESS_PREVIEW_MEDIA_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        adminOrigin: process.env.HEOPRESS_PUBLIC_URL?.trim() || undefined,
      }
    : undefined,
});
const port = Number(process.env.PORT ?? 2027);
const server = serve({ fetch: app.fetch, port }, () => console.log(`[site-classic] listening on :${port}`));

const shutdown = () => {
  server.close();
  void close()
    .then(() => Promise.all([client.end({ timeout: 5 }), trafficClient.end({ timeout: 5 })]))
    .finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
