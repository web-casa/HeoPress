#!/usr/bin/env -S npx tsx
/**
 * `heopress vectors` — vector space maintenance (HeoPress P03 tasks 5.3–5.4).
 *
 *   heopress vectors convert             JSONB embeddings → per-model vector spaces (repeatable)
 *   heopress vectors status --site <id>  active / previous / building model of a site
 *   heopress vectors activate --site <id>
 *   heopress vectors rollback --site <id>
 *   heopress vectors drop-previous --site <id>
 *
 * A model switch is started by the code that re-embeds content
 * (`PgVectorStore.beginModelSwitch`), then activated here once complete.
 * Needs DATABASE_URL and the vector extension (HEOPRESS_VECTOR_SEARCH=true,
 * HeoPress database image).
 */

export {};

import postgres from 'postgres';
import { PgVectorStore, convertJsonbEmbeddings } from '@heopress/runtime/node';

const [command, ...rest] = process.argv.slice(2);
const siteFlag = rest.indexOf('--site');
const site = siteFlag >= 0 ? rest[siteFlag + 1] : undefined;

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}
const sql = postgres(url, { max: 2, onnotice: () => {} });
const store = new PgVectorStore(sql);

function needSite(): string {
  if (!site) {
    console.error(`heopress vectors ${command} needs --site <siteId>`);
    process.exit(1);
  }
  return site;
}

try {
  switch (command) {
    case 'convert': {
      const report = await convertJsonbEmbeddings(sql, store);
      console.log(JSON.stringify(report, null, 2));
      break;
    }
    case 'status': {
      const m = await store.siteModel(needSite());
      const show = (s: typeof m.active) => (s ? `${s.model} (${s.dimension})` : '—');
      console.log(`active: ${show(m.active)}\nprevious: ${show(m.previous)}\nbuilding: ${show(m.building)}`);
      break;
    }
    case 'activate':
      await store.activateModel(needSite());
      console.log('activated');
      break;
    case 'rollback':
      await store.rollbackModel(needSite());
      console.log('rolled back');
      break;
    case 'drop-previous':
      await store.dropPreviousModel(needSite());
      console.log('previous model entries dropped');
      break;
    default:
      console.error('Usage: heopress vectors <convert|status|activate|rollback|drop-previous> [--site <id>]');
      process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
}
