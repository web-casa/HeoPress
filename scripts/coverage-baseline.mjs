#!/usr/bin/env node
/**
 * Coverage baselines of the CMS (HeoPress P13 task 6.3, ADR-0017 §2): critical modules by file, and all CMS code.
 *
 *   node scripts/coverage-baseline.mjs [--summary <coverage-summary.json>]...            measured vs baseline
 *   node scripts/coverage-baseline.mjs --summary <run 1> --summary <run 2>... --update   raise the baselines
 *
 * `apps/cms/coverage-thresholds.json` is the source; `apps/cms/vitest.config.ts` turns it into Vitest thresholds,
 * which fail the coverage run (`pnpm quality:pr`, group `db`) below a baseline. This script reads the summaries of
 * full runs with a database (default `apps/cms/coverage/coverage-summary.json`; CI keeps each run's as the
 * `cms-coverage` artifact) and compares each module's aggregate with its baseline. With several summaries it takes
 * the lowest value of each metric: one full run differs from the next by a few branches (timing-dependent paths,
 * e.g. `state-reconciliation.ts`), so a baseline from a single lucky run would fail at random. `--update` raises a
 * baseline to that lowest measurement rounded down to a whole percentage point and never lowers one; it needs at
 * least two summaries. Lowering is a deliberate edit of the JSON with a reason in the commit message.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cmsRoot = path.join(repoRoot, 'apps', 'cms');
export const THRESHOLDS_FILE = path.join(cmsRoot, 'coverage-thresholds.json');
export const METRICS = ['lines', 'branches', 'functions', 'statements'];

/** Aggregate percentages of the given files (paths relative to apps/cms) in a json-summary report. */
/**
 * A report key relative to apps/cms. Reports name files by absolute path on the machine that ran them (a CI runner
 * has another checkout path), so the part after the last `/apps/cms/` counts.
 */
export function cmsRelative(key) {
  const normalized = key.replaceAll('\\', '/');
  const at = normalized.lastIndexOf('/apps/cms/');
  if (at >= 0) return normalized.slice(at + '/apps/cms/'.length);
  return path.isAbsolute(key) ? path.relative(cmsRoot, key) : normalized;
}

export function aggregate(summary, files) {
  const totals = Object.fromEntries(METRICS.map((m) => [m, { total: 0, covered: 0 }]));
  const byRelative = new Map(
    Object.entries(summary)
      .filter(([key]) => key !== 'total')
      .map(([key, value]) => [cmsRelative(key), value]),
  );
  const missing = [];
  for (const file of files) {
    const entry = byRelative.get(file);
    if (!entry) {
      missing.push(file);
      continue;
    }
    for (const m of METRICS) {
      totals[m].total += entry[m].total;
      totals[m].covered += entry[m].covered;
    }
  }
  const pct = Object.fromEntries(
    METRICS.map((m) => [m, totals[m].total === 0 ? 100 : (totals[m].covered / totals[m].total) * 100]),
  );
  return { pct, missing };
}

/**
 * Every module of the thresholds file plus `other`: every file of the report, the critical ones included — Vitest
 * checks its global thresholds against all covered files.
 */
export function measure(config, summary) {
  const allFiles = Object.keys(summary)
    .filter((key) => key !== 'total')
    .map(cmsRelative);
  const result = {};
  for (const [name, mod] of Object.entries(config.modules)) result[name] = aggregate(summary, mod.files);
  result.other = aggregate(summary, allFiles);
  return result;
}

// Whole percentage points: one run differs from the next by a few branches (timing-dependent paths of the database
// suites), so a baseline at the measured decimals would fail at random.
const floorPct = (n) => Math.floor(n);

/** Raised baselines (never lower than the current ones). */
export function raised(config, measured) {
  const next = structuredClone(config);
  const raise = (baseline, pct) => {
    for (const m of METRICS) baseline[m] = Math.max(baseline[m] ?? 0, floorPct(pct[m]));
  };
  for (const name of Object.keys(next.modules)) raise(next.modules[name].baseline, measured[name].pct);
  raise(next.other.baseline, measured.other.pct);
  return next;
}

/** The lowest value of each metric over several measurements. */
export function lowest(measurements) {
  const result = structuredClone(measurements[0]);
  for (const measured of measurements.slice(1)) {
    for (const [name, { pct, missing }] of Object.entries(measured)) {
      for (const m of METRICS) result[name].pct[m] = Math.min(result[name].pct[m], pct[m]);
      result[name].missing = [...new Set([...result[name].missing, ...missing])];
    }
  }
  return result;
}

function main() {
  const argv = process.argv.slice(2);
  const files = argv.flatMap((arg, i) => (argv[i - 1] === '--summary' ? [path.resolve(arg)] : []));
  if (files.length === 0) files.push(path.join(cmsRoot, 'coverage', 'coverage-summary.json'));
  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.error(`[coverage] no ${path.relative(repoRoot, file)}: run the CMS suites with a database and --coverage first`);
      process.exit(2);
    }
  }
  if (argv.includes('--update') && files.length < 2) {
    console.error('[coverage] --update needs the summaries of at least two full runs (--summary a --summary b)');
    process.exit(2);
  }
  const config = JSON.parse(fs.readFileSync(THRESHOLDS_FILE, 'utf8'));
  const measured = lowest(files.map((file) => measure(config, JSON.parse(fs.readFileSync(file, 'utf8')))));
  let below = 0;
  let missingFiles = 0;
  const rows = [...Object.keys(config.modules), 'other'];
  for (const name of rows) {
    const baseline = name === 'other' ? config.other.baseline : config.modules[name].baseline;
    const { pct, missing } = measured[name];
    const cells = METRICS.map((m) => {
      const low = pct[m] < baseline[m];
      if (low) below += 1;
      return `${m} ${pct[m].toFixed(2)}${low ? ' < ' : ' ≥ '}${baseline[m]}`;
    });
    console.log(`${name.padEnd(14)} ${cells.join('  ')}`);
    for (const file of missing) console.log(`  not in the report: ${file}`);
    missingFiles += missing.length;
  }
  if (missingFiles > 0) {
    // A module file the report does not name was renamed or left coverage.include: fix the module list first.
    console.log(`[coverage] ${missingFiles} module file(s) not in the report`);
    process.exit(1);
  }
  if (argv.includes('--update')) {
    fs.writeFileSync(THRESHOLDS_FILE, `${JSON.stringify(raised(config, measured), null, 2)}\n`);
    console.log(`[coverage] baselines raised where the measurement is higher: ${path.relative(repoRoot, THRESHOLDS_FILE)}`);
  } else if (below > 0) {
    console.log(`[coverage] ${below} value(s) below the baseline`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
