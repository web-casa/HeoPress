#!/usr/bin/env node
// The CLA check (HeoPress v1.2): a pull request is mergeable only from a contributor whose acceptance of
// `CLA.md` is recorded in `.github/cla-signatures.json`.
//
// WHY A RECORDED SIGNATURE AND NOT A COMMENT
// ------------------------------------------
// The CLA is a legal instrument: it is how the project can ship HeoPress under AGPL-3.0 *and* a commercial licence
// while the contributor keeps their copyright. A comment on a pull request is a statement of intent, not a durable
// record — comments are edited, deleted and lost with the branch. The signature therefore lives in a reviewed file in
// the repository, and this check refuses a pull request until the author appears in it.
//
// The maintainer's step is one commit: add `{ "login", "name", "date", "claVersion" }` to the signatures file on the
// pull request's branch (or on `main` beforehand) after the contributor says they accept the CLA.md that is in the
// tree. The check then passes on the next run. `--print` shows the entry to add.
//
// Exempt: GitHub's own accounts and dependabot, which contribute machine-generated changes and sign nothing.
import fs from 'node:fs';
import path from 'node:path';

/** Accounts that never sign: they are GitHub's, not people. */
export const EXEMPT_LOGINS = new Set([
  'dependabot[bot]',
  'dependabot',
  'github-actions[bot]',
  'renovate[bot]',
]);

/** The signatures file, relative to the repository root. */
export const SIGNATURES_FILE = '.github/cla-signatures.json';

/** The CLA version a signature must name; `CLA.md` says which one it is. */
export const CLA_VERSION = '1.0';

/**
 * Read and validate the signatures file. Returns `{ ok, problems, signatures }` — a malformed file is a failure, never
 * an empty list that would silently admit everyone.
 */
export function readSignatures(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, problems: [`${SIGNATURES_FILE} is missing`], signatures: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, problems: [`${SIGNATURES_FILE} is not JSON: ${err.message}`], signatures: [] };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.signatures)) {
    return { ok: false, problems: [`${SIGNATURES_FILE} must be an object with a "signatures" array`], signatures: [] };
  }
  const problems = [];
  const signatures = [];
  for (const [index, entry] of parsed.signatures.entries()) {
    if (!entry || typeof entry !== 'object') {
      problems.push(`signatures[${index}] is not an object`);
      continue;
    }
    const login = typeof entry.login === 'string' ? entry.login.trim() : '';
    if (!login) {
      problems.push(`signatures[${index}] has no login`);
      continue;
    }
    if (login !== login.toLowerCase()) problems.push(`signatures[${index}].login "${login}" must be lowercase`);
    if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
      problems.push(`signatures[${index}].date must be YYYY-MM-DD`);
    }
    if (entry.claVersion !== CLA_VERSION) {
      problems.push(`signatures[${index}].claVersion must be "${CLA_VERSION}" (found ${JSON.stringify(entry.claVersion)})`);
    }
    signatures.push({ login: login.toLowerCase(), date: entry.date, claVersion: entry.claVersion });
  }
  return { ok: problems.length === 0, problems, signatures };
}

/** The decision for one pull request author: `skip` (a bot), `signed`, or `unsigned`. */
export function decide(author, signatures, { exempt = EXEMPT_LOGINS } = {}) {
  const login = String(author ?? '').trim().toLowerCase();
  if (!login) return { outcome: 'unsigned', login, reason: 'the pull request has no author' };
  if (exempt.has(login)) return { outcome: 'skip', login, reason: 'bot account' };
  const found = signatures.find((entry) => entry.login === login);
  if (found) return { outcome: 'signed', login, reason: `signed ${found.date}` };
  return { outcome: 'unsigned', login, reason: 'no recorded acceptance of CLA.md' };
}

/** The message a failure prints: what to do, in the order a contributor does it. */
export function guidance(login) {
  return [
    `The CLA check could not find a recorded acceptance of CLA.md for @${login}.`,
    '',
    '1. Read CLA.md (the Contributor License Agreement).',
    '2. Comment on this pull request exactly:',
    '',
    '   I have read and agree to the HeoPress CLA.',
    '',
    '3. A maintainer records the acceptance in .github/cla-signatures.json on this branch and pushes;',
    '   the check runs again and passes.',
    '',
    'The agreement is what lets HeoPress ship under AGPL-3.0 and a commercial licence while you keep the copyright in',
    'your contribution. It is signed once, not per pull request.',
  ].join('\n');
}

/** The entry to add, ready to paste (for the maintainer). */
export function entryFor(login, name, date) {
  return JSON.stringify({ login: String(login).toLowerCase(), name: name ?? '', date, claVersion: CLA_VERSION }, null, 2);
}

function main(argv) {
  const args = argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const signaturesPath = flag('--signatures') ?? path.join(process.cwd(), SIGNATURES_FILE);
  const author = flag('--author') ?? process.env.PR_AUTHOR;

  if (args.includes('--print')) {
    const date = flag('--date') ?? new Date().toISOString().slice(0, 10);
    console.log(entryFor(author ?? '<github-login>', flag('--name') ?? '', date));
    return 0;
  }

  const read = readSignatures(signaturesPath);
  if (!read.ok) {
    console.error(`CLA check cannot run: ${read.problems.join('; ')}`);
    return 1;
  }
  const decision = decide(author, read.signatures);
  if (decision.outcome === 'skip') {
    console.log(`CLA check: skipped for @${decision.login} (${decision.reason}).`);
    return 0;
  }
  if (decision.outcome === 'signed') {
    console.log(`CLA check: @${decision.login} is recorded (${decision.reason}).`);
    return 0;
  }
  console.error(guidance(decision.login));
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exit(main(process.argv));
