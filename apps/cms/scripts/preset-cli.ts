#!/usr/bin/env -S npx tsx
/**
 * `heopress preset` — the site network preset (HeoPress P05 task 1.4).
 *
 *   heopress preset upgrade --site <id>   add the preset's missing collections and fields to one site
 *   heopress preset upgrade --all         … to every site
 *
 * Only adds: a collection or field that exists — the preset's own, changed
 * by the site, or one the site added — is left as it is. Prints the report
 * (added / skipped with the reason, and the items whose first publish date
 * is estimated or unknown). Repeatable; each site in its own transaction and
 * RLS scope, the shared schema caches dropped after commit. Needs DATABASE_URL (the
 * table owner or the application role).
 */

export {};

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema, sites, type Database } from '@heopress/database';
import { createRuntime } from '@heopress/runtime/node';
import { upgradeSitePreset } from '../src/services/site-network/preset-installer';

const [command, ...rest] = process.argv.slice(2);
const siteFlag = rest.indexOf('--site');
const site = siteFlag >= 0 ? rest[siteFlag + 1] : undefined;
const all = rest.includes('--all');

if (command !== 'upgrade' || (!site && !all)) {
  console.error('Usage: heopress preset upgrade --site <siteId> | --all');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const client = postgres(url, { max: 2, onnotice: () => {} });
const db = drizzle(client, { schema }) as unknown as Database;
// The instance's cache: a running CMS drops its cached schemas once the upgrade committed.
const runtime = createRuntime(process.env);
try {
  const ids = site ? [site] : (await db.select({ id: sites.id }).from(sites)).map((s) => s.id);
  for (const id of ids) {
    const report = await upgradeSitePreset(db, id, runtime.cache);
    console.log(JSON.stringify({ site: id, ...report }));
  }
} finally {
  // Close everything the runtime opened (the cache's LISTEN connection included), or the process stays alive.
  await runtime.queue.close?.().catch(() => undefined);
  await runtime.database.close().catch(() => undefined);
  await client.end({ timeout: 2 });
}
