#!/usr/bin/env node
/**
 * Fail when the Drizzle schema has changes that no generated migration covers
 * (HeoPress P02 task 8.3; AGENTS.md "只用生成的迁移").
 *
 *   node scripts/check-migration-drift.mjs [--schema ./src/schema.ts]
 *
 * Runs `drizzle-kit check` (snapshot consistency) and `drizzle-kit generate`
 * against a scratch copy of `drizzle/`, so the real migrations folder is never
 * written. Any file `generate` adds to the copy means `src/schema/` was changed
 * without `pnpm db:generate`. A journal entry without its snapshot means a
 * migration was written by hand. Needs no database. `--schema` exists for the
 * test that proves the check can fail.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const schemaIdx = args.indexOf('--schema');
const schema = schemaIdx === -1 ? './src/schema.ts' : args[schemaIdx + 1];

// drizzle-kit resolves --out against the working directory and rejects
// absolute paths, so the scratch copy lives inside the package (ignored).
const scratch = path.join('node_modules', '.cache', `migration-drift-${process.pid}`);
const scratchAbs = path.join(pkg, scratch);

function list(dir) {
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

function kit(...kitArgs) {
  execFileSync('pnpm', ['exec', 'drizzle-kit', ...kitArgs, '--dialect', 'postgresql', '--out', scratch], {
    cwd: pkg,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: '' },
  });
}

const journal = JSON.parse(fs.readFileSync(path.join(pkg, 'drizzle/meta/_journal.json'), 'utf8'));
const unsnapshotted = journal.entries.filter(
  (e) => !fs.existsSync(path.join(pkg, 'drizzle/meta', `${String(e.idx).padStart(4, '0')}_snapshot.json`)),
);
if (unsnapshotted.length > 0) {
  console.error('[migration-drift] migrations without a drizzle-kit snapshot (written by hand?):');
  for (const e of unsnapshotted) console.error(`  drizzle/${e.tag}.sql`);
  process.exit(1);
}

fs.rmSync(scratchAbs, { recursive: true, force: true });
fs.mkdirSync(path.dirname(scratchAbs), { recursive: true });
fs.cpSync(path.join(pkg, 'drizzle'), scratchAbs, { recursive: true });
try {
  const before = list(scratchAbs);
  try {
    kit('check');
    kit('generate', '--schema', schema, '--name', 'drift_probe');
  } catch (err) {
    console.error('[migration-drift] drizzle-kit failed:');
    console.error(String(err.stderr || err.stdout || err.message));
    process.exit(1);
  }
  const added = list(scratchAbs).filter((f) => !before.includes(f));
  if (added.length > 0) {
    console.error('[migration-drift] the schema has changes no migration covers; drizzle-kit generate would add:');
    for (const f of added) console.error(`  drizzle/${f}`);
    console.error('[migration-drift] run `pnpm db:generate` and commit the generated migration.');
    process.exitCode = 1;
  } else {
    console.log('[migration-drift] ok: migrations match the schema');
  }
} finally {
  fs.rmSync(scratchAbs, { recursive: true, force: true });
}
