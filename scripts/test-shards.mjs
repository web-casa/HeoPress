#!/usr/bin/env node
/**
 * Duration-balanced shards of the CMS database suites (CI wall clock: `db-suites` runs as parallel shards).
 *
 *   node scripts/test-shards.mjs plan <count>                          print the plan of every shard
 *   node scripts/test-shards.mjs update --log <gh run log>...          re-measure apps/cms/test-shard-timings.json
 *
 * Vitest's own `--shard` cuts the files into slices of equal *count*; the CMS files run one at a time against one
 * database and last from a few milliseconds to about 100 s, so equal counts give unequal shards. The CMS Vitest
 * config (apps/cms/vitest.shard-sequencer.ts) shards with `planShards` instead: the longest file first, each to the
 * least loaded shard, by the durations measured in CI (`test-shard-timings.json`; a file not listed there counts
 * `defaultSeconds`). The plan depends only on the file list and the timings, so every shard job computes the same
 * one: each file runs in exactly one shard. `quality.mjs --merge-shards` checks that the merged report holds every
 * test file all the same.
 *
 * `update` reads `gh run view <run id> --log` output of a CI run (the per-file wall clock: the time between two
 * finished files of the `db:cms` step, imports and set-up included) and rewrites the `files` of the timings file.
 * Stale timings only make the shards less even; they never leave a file out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TIMINGS_FILE = path.join(repoRoot, 'apps', 'cms', 'test-shard-timings.json');

/** `<index>/<count>` → { index, count } (1 ≤ index ≤ count, count ≥ 2). */
export function parseShard(value) {
  const m = /^(\d+)\/(\d+)$/.exec(String(value ?? ''));
  if (!m) throw new Error(`--shard needs <index>/<count>, got ${JSON.stringify(value ?? '')}`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (count < 2) throw new Error(`--shard ${value}: a run of one shard is the whole run (omit --shard)`);
  if (index < 1 || index > count) throw new Error(`--shard ${value}: the index must be between 1 and ${count}`);
  return { index, count };
}

/**
 * Split `files` (paths relative to the Vitest root) into `count` shards of about equal duration. Longest first,
 * ties by path; each file to the shard with the least time so far (ties: the lowest index). `timings.preload` gives
 * shards a head start in seconds (shard 1 also runs the database and runtime package suites). Returns `count`
 * lists, each in the order of `files`, with `seconds` the estimate of each shard.
 *
 * @param {string[]} files
 * @param {{ files?: Record<string, number>, defaultSeconds?: number, preload?: Record<string, number> } | undefined} timings
 * @param {number} count
 * @returns {{ shards: string[][], seconds: number[] }}
 */
export function planShards(files, timings, count) {
  if (!Number.isInteger(count) || count < 1) throw new Error(`invalid shard count ${count}`);
  const seconds = timings?.files ?? {};
  const fallback = timings?.defaultSeconds ?? 1;
  const unique = [...new Set(files)];
  const weight = (f) => (typeof seconds[f] === 'number' ? seconds[f] : fallback);
  const order = [...unique].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const load = Array.from({ length: count }, (_, i) => Number(timings?.preload?.[String(i + 1)] ?? 0));
  const assigned = new Map();
  for (const file of order) {
    let best = 0;
    for (let i = 1; i < count; i += 1) if (load[i] < load[best]) best = i;
    assigned.set(file, best);
    load[best] += weight(file);
  }
  /** @type {string[][]} */
  const shards = Array.from({ length: count }, () => []);
  for (const file of unique) shards[assigned.get(file)].push(file);
  return { shards, seconds: load };
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/\[[0-9;]*m/g, '');

/**
 * Per-file wall clock of the CMS suites from `gh run view --log` output (`job<TAB>step<TAB>timestamp line`): within
 * each job's `db:cms` step, the time from the Vitest start (or the previous finished file) to a file's ✓/× line.
 */
export function timingsFromLog(text) {
  const perJob = new Map();
  const out = {};
  for (const raw of text.split('\n')) {
    const tab = raw.split('\t');
    const job = tab.length >= 3 ? tab[0] : '';
    const rest = tab.length >= 3 ? tab.slice(2).join('\t') : raw;
    const m = /^\uFEFF?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$/.exec(rest);
    if (!m) continue;
    const t = Date.parse(m[1]);
    const body = stripAnsi(m[2]);
    const state = perJob.get(job) ?? { inCms: false, prev: null };
    perJob.set(job, state);
    if (/\[quality\] db:cms\b/.test(body)) {
      state.inCms = true;
      state.prev = null;
    } else if (state.inCms && /##\[endgroup\]|\[quality\] (FAILED|quality:)/.test(body)) {
      state.inCms = false;
    } else if (state.inCms && /^\s*RUN\s+v\d/.test(body)) {
      state.prev = t;
    } else if (state.inCms && state.prev !== null) {
      const f = /^\s*[✓✗×❯↓]\s+(src\/\S+\.(?:test|spec)\.ts)\s/.exec(body);
      if (f) {
        out[f[1]] = Math.round(((out[f[1]] ?? 0) + (t - state.prev) / 1000) * 10) / 10;
        state.prev = t;
      }
    }
  }
  return out;
}

function main(argv) {
  const [command, ...rest] = argv;
  const timings = JSON.parse(fs.readFileSync(TIMINGS_FILE, 'utf8'));
  if (command === 'plan') {
    const count = Number(rest[0]);
    const root = path.join(repoRoot, 'apps', 'cms');
    const files = Object.keys(timings.files).filter((f) => fs.existsSync(path.join(root, f)));
    const { shards, seconds } = planShards(files, timings, count);
    shards.forEach((s, i) => console.log(`shard ${i + 1}/${count}: ${s.length} files, ~${Math.round(seconds[i])} s`));
    return;
  }
  if (command === 'update') {
    const logs = rest.flatMap((arg, i) => (rest[i - 1] === '--log' ? [arg] : []));
    if (logs.length === 0) throw new Error('update needs --log <gh run view --log output>');
    const measured = {};
    for (const log of logs) Object.assign(measured, timingsFromLog(fs.readFileSync(log, 'utf8')));
    if (Object.keys(measured).length === 0) throw new Error('no CMS file durations in the log(s)');
    const sorted = Object.fromEntries(Object.entries(measured).sort(([a], [b]) => (a < b ? -1 : 1)));
    fs.writeFileSync(TIMINGS_FILE, `${JSON.stringify({ ...timings, files: sorted }, null, 2)}\n`);
    console.log(`[test-shards] ${Object.keys(sorted).length} file durations written to ${path.relative(repoRoot, TIMINGS_FILE)}`);
    return;
  }
  throw new Error('usage: test-shards.mjs plan <count> | update --log <file>...');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    console.error(`[test-shards] ${err.message}`);
    process.exit(2);
  }
}
