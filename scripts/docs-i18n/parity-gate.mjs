#!/usr/bin/env node
// Repo-wide zh-CN/en structural parity gate with a committed baseline.
//
// WHY THIS EXISTS
// ---------------
// `check-parity.mjs` answers "is this translation the same document?" and
// `verify-code-refs.mjs` answers "is what it says still true of the code?".
// Neither decides what a pull request may land. The only gate that did —
// `gate-changed-parity.mjs` — narrows the same comparison to the pairs a PR
// touched, which it learns from `git diff`. That works locally and in a repo
// with full history, and it is why the old gate was never wired into CI: the
// public mirror checks out a commit with no shared history with `main`
// (ADR-0018), so there is no base to diff against and the gate receives an
// empty list — which it reads, correctly, as "nothing to enforce".
//
// THIS FILE IS THE ENFORCING GATE.
// `gate-changed-parity.mjs` stays because it is the only thing that can see a
// deletion or rename of one side of a pair from the PR's own diff, and its unit
// test still runs. It is not wired into CI and cannot be: it needs history.
// The gate below needs none, so the same tree yields the same verdict in a
// shallow mirror clone, in a worktree, and on a laptop.
//
// HOW IT WORKS
// ------------
// Every path under `docs/zh-CN/` or `docs/en/` is either a pair (both locales
// present) or single-sided (one locale). Pairs are checked with
// `checkPair()` — imported, never reimplemented, so this gate cannot drift from
// the report the same tree produces. Single-sided docs are not errors by
// themselves; the repo carries a translation backlog.
//
// The debt is frozen in `docs/i18n-parity-baseline.json`, exactly like
// `knip-baseline.json`, `eslint-suppressions.json` and
// `.dependency-cruiser-known-violations.json`: the baseline lists the known
// single-sided paths and, for the known drifting pairs, the problem codes they
// are allowed to have. The gate passes only when the tree's debt EQUALS the
// baseline:
//
//   new single-sided doc, not in the baseline        -> FAIL (fix the docs)
//   new problem code on a pair, not allowed          -> FAIL (fix the docs)
//   baselined single-sided doc gained a counterpart  -> FAIL (stale: --update)
//   baselined single-sided doc removed from the tree -> FAIL (stale: --update)
//   baselined drift no longer reproduces             -> FAIL (stale: --update)
//   baselined drift allows a code that is now gone   -> FAIL (stale: --update)
//
// Failing on staleness is deliberate. A baseline that may silently lag stops
// being a record of current debt, and the next reader cannot tell "fixed but
// not recorded" from "never existed". The remedy is always the same one-line
// command, and its diff is the review artifact: shrinking is good, growth is
// the thing reviewers must reject.
//
// Usage:
//   node scripts/docs-i18n/parity-gate.mjs                        # check
//   node scripts/docs-i18n/parity-gate.mjs --update               # rewrite the baseline
//   node scripts/docs-i18n/parity-gate.mjs --baseline <path>      # use another baseline file
//   node scripts/docs-i18n/parity-gate.mjs --json                 # machine-readable report
//
// `DOCS_ROOT` overrides the docs tree (config.mjs); the default baseline is then
// `<DOCS_ROOT>/i18n-parity-baseline.json`, which keeps test fixtures inside the
// fixture tree.
//
// Exit code: 0 = tree and baseline agree, 1 = they do not, 2 = bad usage or an
// unreadable/invalid baseline.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCS_ROOT, LOCALES } from './config.mjs';
import { allRels, checkPair } from './check-parity.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

/** Where the frozen debt lives. */
export const BASELINE_FILE = 'i18n-parity-baseline.json';

/** Problem codes `check-parity.mjs` can report, in a stable display order. */
export const CHECK_CODES = [
  'language',
  'headings',
  'code-fences',
  'inline-code',
  'links',
  'tables',
  'front-matter',
  'bulk',
];

const COMMENT =
  'Frozen zh-CN/en docs debt for scripts/docs-i18n/parity-gate.mjs. ' +
  'Regenerate with `pnpm docs:i18n:gate:update` after paying debt down; ' +
  'growth here is what reviewers must reject.';

const sortStrings = (list) => [...list].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Sort object keys so `--update` output is byte-stable. */
function sortObject(obj) {
  return Object.fromEntries(Object.keys(obj).sort(compare).map((k) => [k, obj[k]]));
}

/** Display path that stays stable whether or not DOCS_ROOT is the repo's docs/. */
export function docsPath(locale, rel) {
  return `docs/${locale}/${rel}`;
}

/**
 * The debt in the current tree, in the baseline's shape (plus `pairs`, which is
 * not serialized but lets messages say why an entry went stale).
 *
 * @returns {{pairs: string[], singleSided: Record<string, string[]>, drifting: Record<string, string[]>}}
 */
export function currentState() {
  const pairs = [];
  const singleSided = Object.fromEntries(LOCALES.map((locale) => [locale, []]));
  const drifting = {};

  for (const rel of allRels()) {
    const present = LOCALES.filter((locale) =>
      fs.existsSync(path.join(DOCS_ROOT, locale, rel)),
    );
    if (present.length === LOCALES.length) {
      pairs.push(rel);
      // Reuse the real checker: the gate must never grow its own rules.
      const { problems } = checkPair(rel);
      if (problems.length > 0) {
        drifting[rel] = sortStrings([...new Set(problems.map((p) => p.check))]);
      }
    } else if (present.length > 0) {
      singleSided[present[0]].push(rel);
    }
  }

  for (const locale of LOCALES) singleSided[locale] = sortStrings(singleSided[locale]);
  return { pairs: sortStrings(pairs), singleSided, drifting: sortObject(drifting) };
}

/** The serialized form of a state: stable key order, stable arrays, trailing newline. */
export function serializeBaseline(state) {
  const payload = {
    $comment: COMMENT,
    version: 1,
    singleSided: Object.fromEntries(
      LOCALES.map((locale) => [locale, sortStrings(state.singleSided[locale] ?? [])]),
    ),
    drifting: sortObject(
      Object.fromEntries(
        Object.entries(state.drifting ?? {}).map(([rel, codes]) => [rel, sortStrings(codes)]),
      ),
    ),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * Parse and validate a baseline file.
 * @throws {Error} when the shape is not what this gate writes.
 */
export function parseBaseline(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`not valid JSON: ${err.message}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('the baseline must be a JSON object');
  }
  const singleSided = raw.singleSided;
  if (singleSided === null || typeof singleSided !== 'object' || Array.isArray(singleSided)) {
    throw new Error('missing `singleSided` object');
  }
  for (const locale of LOCALES) {
    const list = singleSided[locale];
    if (!Array.isArray(list) || list.some((rel) => typeof rel !== 'string')) {
      throw new Error(`\`singleSided.${locale}\` must be an array of rel paths`);
    }
  }
  const unknownLocale = Object.keys(singleSided).find((locale) => !LOCALES.includes(locale));
  if (unknownLocale) throw new Error(`unknown locale \`singleSided.${unknownLocale}\``);

  const drifting = raw.drifting;
  if (drifting === null || typeof drifting !== 'object' || Array.isArray(drifting)) {
    throw new Error('missing `drifting` object');
  }
  for (const [rel, codes] of Object.entries(drifting)) {
    if (!Array.isArray(codes) || codes.some((code) => typeof code !== 'string')) {
      throw new Error(`\`drifting.${rel}\` must be an array of check codes`);
    }
  }
  return {
    singleSided: Object.fromEntries(LOCALES.map((locale) => [locale, singleSided[locale]])),
    drifting,
  };
}

/**
 * Compare the tree's debt with the baseline.
 *
 * Pure: takes both sides as data so the decisions are testable without a docs
 * tree. `state.pairs` is optional; when absent, a stale single-sided entry is
 * reported without claiming why it went stale.
 *
 * @returns {{
 *   newSingleSided: Array<{locale: string, rel: string, counterpart: string}>,
 *   staleSingleSided: Array<{locale: string, rel: string, reason: 'gained-counterpart'|'removed'}>,
 *   newDrift: Array<{rel: string, codes: string[]}>,
 *   unallowedDrift: Array<{rel: string, codes: string[], allowed: string[]}>,
 *   staleDrift: Array<{rel: string, gone: string[]}>,
 *   ok: boolean
 * }}
 */
export function diffBaseline(state, baseline) {
  const pairSet = new Set(state.pairs ?? []);
  const newSingleSided = [];
  const staleSingleSided = [];

  for (const locale of LOCALES) {
    const known = new Set(baseline.singleSided[locale] ?? []);
    const present = new Set(state.singleSided[locale] ?? []);
    for (const rel of present) {
      if (known.has(rel)) continue;
      const counterpart = LOCALES.find((other) => other !== locale);
      newSingleSided.push({ locale, rel, counterpart });
    }
    for (const rel of known) {
      if (present.has(rel)) continue;
      staleSingleSided.push({
        locale,
        rel,
        reason: pairSet.has(rel) ? 'gained-counterpart' : 'removed',
      });
    }
  }

  const newDrift = [];
  const unallowedDrift = [];
  const staleDrift = [];

  for (const [rel, codes] of Object.entries(state.drifting ?? {})) {
    const allowed = baseline.drifting[rel];
    if (!Array.isArray(allowed)) {
      newDrift.push({ rel, codes: sortStrings(codes) });
      continue;
    }
    const allowedSet = new Set(allowed);
    const codesSet = new Set(codes);
    const unallowed = sortStrings(codes.filter((code) => !allowedSet.has(code)));
    if (unallowed.length > 0) {
      unallowedDrift.push({ rel, codes: unallowed, allowed: sortStrings(allowed) });
    }
    const gone = sortStrings(allowed.filter((code) => !codesSet.has(code)));
    if (gone.length > 0) staleDrift.push({ rel, gone });
  }
  for (const rel of Object.keys(baseline.drifting)) {
    if (rel in (state.drifting ?? {})) continue;
    staleDrift.push({ rel, gone: sortStrings(baseline.drifting[rel]) });
  }

  const ok =
    newSingleSided.length === 0 &&
    staleSingleSided.length === 0 &&
    newDrift.length === 0 &&
    unallowedDrift.length === 0 &&
    staleDrift.length === 0;

  return { newSingleSided, staleSingleSided, newDrift, unallowedDrift, staleDrift, ok };
}

/** Total problems in a diff, so callers can report one number. */
export function problemCount(diff) {
  return (
    diff.newSingleSided.length +
    diff.staleSingleSided.length +
    diff.newDrift.length +
    diff.unallowedDrift.length +
    diff.staleDrift.length
  );
}

/** Human-readable failure report; every line says what to do next. */
export function formatProblems(diff, baselineLabel) {
  const lines = [];
  if (diff.newSingleSided.length > 0) {
    lines.push('New single-sided doc(s) — add the other locale, or record the debt with --update:');
    for (const { locale, rel, counterpart } of diff.newSingleSided) {
      lines.push(`  ${docsPath(locale, rel)}  (no ${docsPath(counterpart, rel)})`);
    }
    lines.push('');
  }
  if (diff.staleSingleSided.length > 0) {
    lines.push(`Stale single-sided entr(ies) in ${baselineLabel} — run \`pnpm docs:i18n:gate:update\`:`);
    for (const { locale, rel, reason } of diff.staleSingleSided) {
      const why =
        reason === 'gained-counterpart'
          ? 'a counterpart now exists, so this is no longer single-sided'
          : 'neither locale has this doc any more';
      lines.push(`  ${docsPath(locale, rel)}  (${why})`);
    }
    lines.push('');
  }
  if (diff.newDrift.length > 0) {
    lines.push('Pairs that drift, with no baseline entry at all — fix the docs, do not freeze a new pair:');
    for (const { rel, codes } of diff.newDrift) {
      lines.push(`  ${rel}  [${codes.join(', ')}]`);
    }
    lines.push('');
  }
  if (diff.unallowedDrift.length > 0) {
    lines.push(`Drift not allowed by ${baselineLabel} — fix the docs, do not widen the entry:`);
    for (const { rel, codes, allowed } of diff.unallowedDrift) {
      lines.push(`  ${rel}  new: [${codes.join(', ')}]  allowed: [${allowed.join(', ')}]`);
    }
    lines.push('');
  }
  if (diff.staleDrift.length > 0) {
    lines.push(`Stale drift allowance(s) in ${baselineLabel} — run \`pnpm docs:i18n:gate:update\`:`);
    for (const { rel, gone } of diff.staleDrift) {
      lines.push(`  ${rel}  no longer reproduces: [${gone.join(', ')}]`);
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function main() {
  const argv = process.argv.slice(2);
  const wantUpdate = argv.includes('--update');
  const asJson = argv.includes('--json');
  const baselineArgIndex = argv.indexOf('--baseline');
  const unknown = argv.filter(
    (arg, index) => !['--update', '--json', '--baseline'].includes(arg) && index !== baselineArgIndex + 1,
  );
  if (unknown.length > 0) {
    console.error(`parity-gate: unknown argument(s): ${unknown.join(' ')}`);
    console.error('usage: parity-gate.mjs [--update] [--baseline <path>] [--json]');
    process.exit(2);
  }
  const baselinePath = baselineArgIndex === -1
    ? path.join(DOCS_ROOT, BASELINE_FILE)
    : path.resolve(argv[baselineArgIndex + 1] ?? '');
  if (baselineArgIndex !== -1 && !argv[baselineArgIndex + 1]) {
    console.error('parity-gate: --baseline needs a path');
    process.exit(2);
  }

  const baselineLabel = path.relative(REPO_ROOT, baselinePath).startsWith('..')
    ? baselinePath
    : path.relative(REPO_ROOT, baselinePath).split(path.sep).join('/');

  const state = currentState();

  if (wantUpdate) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, serializeBaseline(state), 'utf8');
    const singles = LOCALES.reduce((n, locale) => n + state.singleSided[locale].length, 0);
    console.log(
      `[parity-gate] baseline written: ${baselineLabel} — ${state.pairs.length} pair(s), ` +
        `${singles} single-sided doc(s), ${Object.keys(state.drifting).length} drifting pair(s)`,
    );
    return;
  }

  let baseline;
  try {
    baseline = parseBaseline(fs.readFileSync(baselinePath, 'utf8'));
  } catch (err) {
    console.error(`parity-gate: cannot read ${baselineLabel}: ${err.message}`);
    console.error('parity-gate: generate it with `pnpm docs:i18n:gate:update`.');
    process.exit(2);
  }

  const diff = diffBaseline(state, baseline);
  const singles = LOCALES.reduce((n, locale) => n + state.singleSided[locale].length, 0);

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          ok: diff.ok,
          pairs: state.pairs.length,
          singleSided: state.singleSided,
          drifting: state.drifting,
          baseline: baselineLabel,
          problems: problemCount(diff),
          diff,
        },
        null,
        2,
      ),
    );
  }

  if (!diff.ok) {
    const count = problemCount(diff);
    if (!asJson) {
      console.error(`[parity-gate] FAIL — ${count} problem(s) between the tree and ${baselineLabel}`);
      console.error('');
      console.error(formatProblems(diff, baselineLabel));
      console.error('');
      console.error(
        'Both locales are versioned together (AGENTS.md §7): a doc change carries its translation\n' +
          'in the same commit. Inherited debt is frozen in the baseline; only paying it down may\n' +
          'rewrite that file (`pnpm docs:i18n:gate:update`), and only the shrinking diff is welcome.',
      );
    }
    process.exit(1);
  }

  if (!asJson) {
    console.log(
      `[parity-gate] ok: ${state.pairs.length} pair(s) checked, ${singles} single-sided doc(s) ` +
        `frozen, ${Object.keys(state.drifting).length} drifting pair(s) within ${baselineLabel}`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
