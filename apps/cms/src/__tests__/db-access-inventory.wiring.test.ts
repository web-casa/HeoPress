import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DB_ACCESS_ENTRIES,
  DB_ACCESS_EXEMPTIONS,
  REGISTERED_DB_ACCESS_IDS,
  SCOPE_SOURCES,
} from './helpers/db-access-inventory';

/**
 * The access-path inventory stays true (HeoPress P14 task 1.6, design D1.5): every construct that opens a connection or
 * starts background work is registered with the source of its row-level scope, and no registered entry has disappeared.
 * A new `cron.schedule`, worker registration, route mount, CLI script or direct connection fails here until it is added.
 */
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const SRC = 'apps/cms/src';
const SCRIPTS = 'apps/cms/scripts';

const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

/** Every non-test TypeScript file under `dir`. */
function sources(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const name of readdirSync(join(ROOT, rel))) {
      const path = `${rel}/${name}`;
      if (statSync(join(ROOT, path)).isDirectory()) {
        if (name === '__tests__' || name === 'node_modules') continue;
        walk(path);
      } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.spec.ts')) {
        out.push(path);
      }
    }
  };
  walk(dir);
  return out;
}

const CONNECTION = /createDb\(|(?<![A-Za-z_$])postgres\(|getConnection\(\)/;

function discover(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of sources(SRC)) {
    const text = read(file);
    if (CONNECTION.test(text)) found.set(`connection:${file}`, `connection opened in ${file}`);
    for (const m of text.matchAll(/scheduledJob\(\s*'([^']+)'/g)) found.set(`cron:${m[1]}`, `cron pass ${m[1]} in ${file}`);
  }
  // Worker registrations: the `register…(` calls in the process entry point.
  const serve = read(`${SRC}/serve.ts`);
  for (const m of serve.matchAll(/(?<![A-Za-z0-9_$])register([A-Za-z0-9]+)\(/g)) {
    found.set(`worker:register${m[1]}`, `worker registration register${m[1]} in serve.ts`);
  }
  // Route mounts in the application itself.
  const index = read(`${SRC}/index.ts`);
  for (const m of index.matchAll(/app\.route\(\s*'([^']+)'\s*,\s*([A-Za-z0-9_]+)/g)) {
    found.set(`route:${m[1]}:${m[2]}`, `route ${m[1]} → ${m[2]} in index.ts`);
  }
  // Command-line entry points.
  for (const name of readdirSync(join(ROOT, SCRIPTS))) {
    if (name.endsWith('-cli.ts')) found.set(`cli:${SCRIPTS}/${name}`, `CLI ${name}`);
  }
  return found;
}

describe('database access-path inventory (P14 task 1.6)', () => {
  const found = discover();

  it('every connection, cron pass, worker, route and CLI is registered with its scope source', () => {
    const unregistered = [...found].filter(([id]) => !REGISTERED_DB_ACCESS_IDS.has(id) && !(id in DB_ACCESS_EXEMPTIONS)).map(([id, why]) => `${id} (${why})`);
    expect(unregistered).toEqual([]);
  });

  it('every registered entry still exists (no stale claims)', () => {
    const stale = DB_ACCESS_ENTRIES.filter((e) => !found.has(e.id)).map((e) => e.id);
    expect(stale).toEqual([]);
  });

  it('every entry names a scope source from the inventory’s vocabulary', () => {
    const bad = DB_ACCESS_ENTRIES.filter((e) => !(SCOPE_SOURCES as readonly string[]).includes(e.scope)).map((e) => `${e.id}: ${e.scope}`);
    expect(bad).toEqual([]);
    const duplicated = DB_ACCESS_ENTRIES.map((e) => e.id).filter((id, i, all) => all.indexOf(id) !== i);
    expect(duplicated).toEqual([]);
  });

  it('the exemptions are real constructs (they are found, and their reason is recorded)', () => {
    for (const [id, reason] of Object.entries(DB_ACCESS_EXEMPTIONS)) {
      expect(found.has(id), `${id} is exempt but no longer exists`).toBe(true);
      expect(reason.length).toBeGreaterThan(10);
      expect(REGISTERED_DB_ACCESS_IDS.has(id), `${id} is both exempt and registered`).toBe(false);
    }
  });
});
