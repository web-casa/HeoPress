#!/usr/bin/env -S npx tsx
/**
 * `heopress import` — site import (HeoPress P12 tasks 6.1–6.4, 7.1–7.3; guide docs/zh-CN/migration/astro-import.md).
 *
 *   heopress import schema                                         print the bundle's JSON Schema
 *   heopress import astro <site-root> --mapping <file> --out <dir> convert an Astro content directory to a bundle
 *   heopress import validate <bundle-dir>                          check a bundle (schema, credentials, paths, limits, media)
 *   heopress import dry-run --site <id> --bundle <dir> --actor <userId>
 *   heopress import run --site <id> --bundle <dir> --batch <id> --report-hash <hash> --actor <userId>
 *   heopress import activate --site <id> --batch <id> --actor <userId>
 *   heopress import compare --urls <sitemap.xml|list.txt> --new-base <url> [--explanations <file.json>] [--out <file>]
 *
 * The database commands need DATABASE_URL. `activate` publishes with the actor's own permissions on the site.
 * `compare` requests the old URLs and the preview through the outbound guard (no private addresses), and exits 2
 * when the site is not switchable.
 */

export {};

import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema, type Database } from '@heopress/database';
import { importRecordJsonSchema } from '@heopress/contracts/schemas';
import { createRuntime } from '@heopress/runtime/node';
import { itemServiceForPrincipal } from '../src/services/item-service-factory';
import { guardedProbe } from '../src/services/ssrf-guard';
import { StorageProfileService } from '../src/services/storage/storage-profile-service';
import { convertAstroSite, writeBundle } from '../src/services/site-import/astro/convert';
import { BundleInvalidError, loadBundle } from '../src/services/site-import/bundle-reader';
import { SiteImportService, storageMediaStore } from '../src/services/site-import/import-service';
import { collectOldUrls, compareUrls, type PageFetcher } from '../src/services/site-import/url-compare';

const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const need = (name: string) => {
  const v = flag(name);
  if (!v) {
    console.error(`--${name} is required.`);
    process.exit(1);
  }
  return v;
};
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const fetcher: PageFetcher = async (url) => {
  const res = await guardedProbe(url, { timeoutMs: 15_000, maxResponseBytes: 5 * 1024 * 1024, headers: { 'user-agent': 'HeoPress-URL-compare' } });
  return { status: res.status, location: res.headers.get('location'), body: res.status >= 200 && res.status < 300 ? await res.text() : '' };
};

async function withDb<T>(fn: (db: Database, runtime: ReturnType<typeof createRuntime>) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }
  const client = postgres(url, { max: 2, onnotice: () => {} });
  const db = drizzle(client, { schema }) as unknown as Database;
  const runtime = createRuntime(process.env);
  try {
    return await fn(db, runtime);
  } finally {
    await runtime.queue.close?.().catch(() => undefined);
    await runtime.database.close().catch(() => undefined);
    await client.end({ timeout: 2 });
  }
}

try {
  switch (command) {
    case 'schema':
      print(importRecordJsonSchema());
      break;
    case 'astro': {
      const root = rest[0];
      if (!root) throw new Error('Give the Astro site root.');
      const conversion = await convertAstroSite(root, JSON.parse(await readFile(need('mapping'), 'utf8')));
      await writeBundle(need('out'), conversion);
      print(conversion.report);
      break;
    }
    case 'validate': {
      const b = await loadBundle(rest[0] ?? need('bundle'));
      print({ ok: true, namespace: b.namespace, items: b.items.length, media: b.media.length, redirects: b.redirects.length });
      break;
    }
    case 'dry-run':
    case 'run':
    case 'activate': {
      const site = need('site');
      const actor = need('actor');
      await withDb(async (db, runtime) => {
        const storage = new StorageProfileService({ db, siteId: site, keys: runtime.keys, defaultStorage: runtime.storage, storageDir: process.env.HEOPRESS_STORAGE_DIR?.trim() || undefined });
        const svc = new SiteImportService({ db, siteId: site, actor: { userId: actor }, media: storageMediaStore(storage as never) });
        if (command === 'dry-run') print(await svc.dryRun(await loadBundle(need('bundle'))));
        else if (command === 'run') print(await svc.import(need('batch'), await loadBundle(need('bundle')), need('report-hash')));
        else {
          const result = await svc.activate(need('batch'), (tx) =>
            itemServiceForPrincipal(
              { db: tx as unknown as Database, rootDb: db, siteId: site, userId: actor, cdcActor: { type: 'user', id: actor }, localeSetWrite: true },
              { userId: actor, siteId: site, roleId: null, user: { id: actor, email: null, roles: [] }, ip: null, headers: {}, apiKey: null, principal: 'user' },
            ),
          );
          print(result);
          if (!result.activated) process.exitCode = 2;
        }
      });
      break;
    }
    case 'compare': {
      const list = need('urls');
      const text = /^https?:\/\//.test(list) ? (await fetcher(list)).body : await readFile(list, 'utf8');
      const explanations = flag('explanations') ? (JSON.parse(await readFile(flag('explanations')!, 'utf8')) as Record<string, string>) : {};
      const report = await compareUrls({ oldUrls: await collectOldUrls(text, fetcher), newBase: need('new-base'), fetchOld: fetcher, fetchNew: fetcher, explanations });
      if (flag('out')) await writeFile(flag('out')!, `${JSON.stringify(report, null, 2)}\n`);
      print({ checked: report.checked, unexplained: report.unexplained, switchable: report.switchable, differences: report.differences });
      if (!report.switchable) process.exitCode = 2;
      break;
    }
    default:
      console.error('Usage: heopress import schema | astro | validate | dry-run | run | activate | compare (see docs/zh-CN/migration/astro-import.md)');
      process.exit(1);
  }
} catch (err) {
  if (err instanceof BundleInvalidError) print({ ok: false, problems: err.problems });
  else console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
