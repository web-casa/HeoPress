#!/usr/bin/env -S npx tsx
/**
 * `heopress projection` — the public projection the rendering service reads (HeoPress P06 task 1.2;
 * design R18, R26).
 *
 *   heopress projection build      build every site that was never built (first deployment, after the migration)
 *   heopress projection rebuild    process the pending rebuild marks (what the worker does continuously)
 *   heopress projection rebuild --site <id>   rebuild one site
 *
 * Each site in its own transaction, its settings row held first. Run with DATABASE_URL (the table
 * owner or the application role) before routing public traffic to the rendering service.
 */

export {};

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema, type Database } from '@heopress/database';
import { buildAllProjections, processProjectionRebuilds, rebuildSiteProjection } from '../src/services/site-network/public-projection';

const [command, ...rest] = process.argv.slice(2);
const siteFlag = rest.indexOf('--site');
const site = siteFlag >= 0 ? rest[siteFlag + 1] : undefined;
if (command !== 'build' && command !== 'rebuild') {
  console.error('Usage: heopress projection build | rebuild [--site <siteId>]');
  process.exit(1);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
const client = postgres(url, { max: 2, onnotice: () => {} });
const db = drizzle(client, { schema }) as unknown as Database;
try {
  if (command === 'build') {
    console.log(`[projection] built ${await buildAllProjections(db)} site(s)`);
  } else if (site) {
    await rebuildSiteProjection(db, site);
    console.log(`[projection] rebuilt ${site}`);
  } else {
    // Until no mark is left except for sites that failed in this run (each is tried once per run).
    let total = 0;
    const failed = new Set<string>();
    for (;;) {
      const { rebuilt, failed: now } = await processProjectionRebuilds(db, { exclude: failed });
      total += rebuilt.length;
      for (const s of now) failed.add(s);
      if (rebuilt.length === 0 && now.length === 0) break;
    }
    console.log(`[projection] rebuilt ${total} site(s)`);
    if (failed.size) {
      console.error(`[projection] ${failed.size} site(s) failed and stay marked: ${[...failed].sort().join(', ')}`);
      process.exitCode = 1;
    }
  }
} finally {
  await client.end({ timeout: 5 });
}
