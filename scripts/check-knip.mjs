#!/usr/bin/env node
/**
 * Knip with a frozen baseline (HeoPress P02 task 8.2, ADR-0017 §2).
 *
 *   node scripts/check-knip.mjs            fail on any Knip finding not in the baseline
 *   node scripts/check-knip.mjs --update   rewrite knip-baseline.json from the current findings
 *
 * Knip has no built-in baseline. Upstream leftovers (unused files, exports,
 * types, duplicate exports) are frozen in `knip-baseline.json` as
 * `<kind> <file> <name>` lines; the check fails only on new ones. Fix a frozen
 * finding, then run --update to shrink the baseline; never run it to let a new
 * finding through.
 *
 * Entries Knip cannot see statically are registered in knip.json, never
 * frozen here: the CMS entry points and scripts, k6 load scripts, and the
 * drift-check schema fixture, the runtime test fixtures spawned with
 * `node --import tsx`. Plugins and themes have no in-repo entry yet:
 * extensions load at runtime from bundle URLs, or in development from the
 * `extensions/` folder through `virtual:heopress-extensions`. Reference
 * plugins and themes added later (P06, P09) must be registered as entries.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BASELINE = 'knip-baseline.json';

/** Flatten Knip's JSON report into stable `<kind> <file> <name>` keys (no line numbers). */
export function findingKeys(report) {
  const keys = new Set();
  for (const issue of report.issues ?? []) {
    for (const [kind, value] of Object.entries(issue)) {
      if (kind === 'file' || kind === 'owners') continue;
      if (Array.isArray(value)) {
        for (const item of value) {
          // `duplicates` entries are groups of names exported twice.
          const name = Array.isArray(item) ? item.map((d) => d.name).sort().join('|') : item.name;
          keys.add(`${kind} ${issue.file} ${name}`);
        }
      } else if (value && typeof value === 'object') {
        for (const name of Object.keys(value)) keys.add(`${kind} ${issue.file} ${name}`);
      }
    }
  }
  return [...keys].sort();
}

/** New findings (not frozen) and frozen findings that are gone (fixed). */
export function compareToBaseline(current, baseline) {
  const known = new Set(baseline);
  const now = new Set(current);
  return {
    added: current.filter((k) => !known.has(k)),
    fixed: baseline.filter((k) => !now.has(k)),
  };
}

function runKnip() {
  try {
    return execFileSync('pnpm', ['exec', 'knip', '--reporter', 'json', '--no-exit-code'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    console.error('[knip] Knip failed to run:');
    console.error(String(err.stderr || err.message));
    process.exit(2);
  }
}

function main() {
  const current = findingKeys(JSON.parse(runKnip()));
  const baselinePath = path.join(root, BASELINE);
  if (process.argv.includes('--update')) {
    fs.writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`[knip] baseline written: ${current.length} finding(s)`);
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const { added, fixed } = compareToBaseline(current, baseline);
  if (fixed.length > 0) {
    console.log(`[knip] ${fixed.length} frozen finding(s) are fixed; run \`pnpm knip:baseline\` to shrink the baseline.`);
  }
  if (added.length > 0) {
    console.error(`[knip] ${added.length} new finding(s) not in ${BASELINE}:`);
    for (const k of added) console.error(`  ${k}`);
    console.error('[knip] Remove the unused code or dependency, or register a dynamic entry in knip.json.');
    process.exitCode = 1;
    return;
  }
  console.log(`[knip] ok: no new findings (${baseline.length} frozen)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
