#!/usr/bin/env node
/**
 * The public export of a private commit (ADR-0010, ADR-0018).
 *
 *   node scripts/public-export.mjs --out <empty dir> [--commit <rev>] [--root <repo>] [--require-licenses]
 *
 * 1. Takes the files of the commit (never the working tree: what is exported
 *    is exactly a commit), keeps what `release/public-manifest.yaml`
 *    includes and drops, without exception, every path its `never` list or
 *    the built-in never-public categories (`NEVER_PUBLIC`) name and every
 *    environment file (a name starting `.env`, except `.env.example`). A
 *    manifest whose `include` names a never-public path is an error, not a
 *    silent drop. Submodules, unsafe path names (`..`, `.git`, …) and scanner
 *    configuration files are refused; a symbolic link must resolve, through
 *    any chain of links, inside the export.
 * 2. Scans the result before anything can leave:
 *    - the private word list `release/private-terms.txt` (operator domains,
 *      server addresses, …; never exported), in file contents read as UTF-8,
 *      Latin-1 and UTF-16 (LE/BE), in path names and in link targets;
 *    - gitleaks (secrets) with its default rules (a configuration file in the
 *      tree is never used), its inline `gitleaks:allow` ignored. A finding
 *      reviewed as not a secret is listed in `release/gitleaks-reviewed` by
 *      the SHA-256 of its path, rule and the exact line: any change to the
 *      line makes it a new finding;
 *    - anything but plain UTF-8 text (images, PDF, archives, any binary) is
 *      refused unless its exact content (SHA-256) is listed in
 *      `release/opaque-reviewed`.
 *    Findings name the file and line only, never the matched text. Any
 *    finding, or a scanner that cannot run (the scan is then not completed),
 *    stops the export.
 * 3. The Apache-2.0 §4(b) list of modified upstream files is cut down to the
 *    files exported (it names what is distributed).
 * 4. For a release (`requireLicenses`), every licence file the public
 *    repository must carry (ADR-0008, ADR-0010 §7) must be exported and final.
 *
 * Used by the public CI mirror (scripts/ci-mirror.mjs) and by the release
 * pipeline (scripts/public-release.mjs).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { gitleaksScan, isScannerConfigName } from './security-scanners.mjs';

const MANIFEST = 'release/public-manifest.yaml';
const TERMS = 'release/private-terms.txt';
const GITLEAKS_REVIEWED = 'release/gitleaks-reviewed';
const OPAQUE_REVIEWED = 'release/opaque-reviewed';
const MODIFIED_LIST = 'LICENSES/HEOPRESS-MODIFIED-FILES.txt';

/**
 * Never public, whatever the manifest says (ADR-0010 §2, AGENTS.md §1.1): built in, so that editing the manifest
 * alone can never export them. Environment files are a category of their own (`isEnvFile`).
 */
export const NEVER_PUBLIC = [
  'docs/handoffs/**',
  'docs/research/**',
  'docs/reviews/**',
  'docs/review-agent/**',
  'docs/decisions/**',
  'docs/backlog/**',
  'docs/benchmarks/**',
  'openspec/changes/**',
  '.claude/**',
  '.agents/**',
  'release/private-terms.txt',
  'release/gitleaks-reviewed',
  'release/opaque-reviewed',
  'release/private-releases.jsonl',
  // Any other private release record, present or future (`release/private-notes.json`, `release/private/…`).
  'release/private*',
  'release/private*/**',
  // … at any depth (`release/archive/private-releases.jsonl`).
  'release/**/private*',
  'release/**/private*/**',
  // Legal drafts: a licence text reaches the public tree only as its final, reviewed file at the root
  // (`LICENSE-EXCEPTION.md` is the reviewed text of legal/PLUGIN-AND-THEME-EXCEPTION.md).
  'legal/**',
];

/**
 * The licence files a public release must carry (ADR-0008, ADR-0010 §7). Each must be final: a file marked as a
 * draft counts as missing.
 */
export const LICENSE_FILES = ['LICENSE', 'LICENSE-EXCEPTION.md', 'COMMERCIAL-LICENSE.md', 'CLA.md', 'LICENSES/Apache-2.0.txt', 'NOTICE'];

/**
 * A path as a case-insensitive file system (macOS, Windows) or a Windows checkout would see it: Unicode NFKC, lower
 * case, and each segment without trailing dots and spaces. Names equal under this folding are the same name: every
 * never-public, environment-file and scanner-configuration check compares folded names.
 */
export function foldPath(p) {
  return p
    .normalize('NFKC')
    .toLowerCase()
    .split('/')
    .map((s) => s.replace(/[. ]+$/, ''))
    .join('/');
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** The manifest's two lists (a small YAML subset: `key:` lines and `- item` lines). `never` has no exceptions. */
export function parseManifest(text) {
  const out = { include: [], never: [] };
  let section = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\s+#.*$/, '').replace(/^#.*$/, '').trimEnd();
    if (!line.trim()) continue;
    const key = /^([a-z]+):\s*$/.exec(line);
    if (key) {
      if (!(key[1] in out)) throw new Error(`${MANIFEST}: unknown key "${key[1]}"`);
      section = key[1];
      continue;
    }
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (!item || !section) throw new Error(`${MANIFEST}: cannot read "${rawLine.trim()}"`);
    const pattern = item[1].trim().replace(/^"(.*)"$/, '$1');
    if (pattern.startsWith('!')) throw new Error(`${MANIFEST}: "${pattern}": exceptions are not allowed (never means never)`);
    out[section].push(pattern);
  }
  if (out.include.length === 0) throw new Error(`${MANIFEST}: nothing to include`);
  return out;
}

/** A path pattern as a regular expression: `**` any number of segments, `*` within one segment. */
export function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      const slashAfter = pattern[i + 2] === '/';
      re += slashAfter ? '(?:.*/)?' : '.*';
      i += slashAfter ? 2 : 1;
    } else if (ch === '*') re += '[^/]*';
    else re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * An environment file (`.env`, `.env.local`, `.envrc`, `.environment`, `.ENV.production`, `.env.` …): a name that
 * folds (`foldPath`) to one starting `.env`. Never exported, except a file named exactly `.env.example`.
 */
export function isEnvFile(file) {
  const base = file.split('/').pop();
  return foldPath(base).startsWith('.env') && base !== '.env.example';
}

/** The never-public patterns: the built-in categories and the manifest's own `never` list. */
const neverPatterns = (manifest) => [...new Set([...NEVER_PUBLIC, ...manifest.never])];

/** Each never-public pattern, matched against folded paths (case variants of a never path are never paths). */
const neverMatchers = (manifest) => neverPatterns(manifest).map((p) => ({ p, raw: globToRegExp(p), re: globToRegExp(foldPath(p)) }));

/**
 * Names that are a case, Unicode or trailing-dot variant of a never-public path, an environment file or a scanner
 * configuration file (`release/PRIVATE-RELEASES.JSONL`, `apps/.ENV.production`, `apps/.GITLEAKS.TOML`): an error,
 * never a quiet drop — such a name exists only to slip past a check, and it is one name on another file system.
 */
export function nameVariants(files, manifest) {
  const never = neverMatchers(manifest);
  const out = [];
  for (const f of files) {
    const base = f.split('/').pop();
    if (isEnvFile(f) && foldPath(base) !== base) out.push(`${f} (a variant of an environment file name)`);
    if (isScannerConfigName(base) && foldPath(base) !== base) out.push(`${f} (a variant of a scanner configuration file name)`);
    const folded = foldPath(f);
    const category = never.find(({ raw, re }) => re.test(folded) && !raw.test(f));
    if (category) out.push(`${f} (a case or spelling variant of the never-public ${category.p})`);
  }
  return out;
}

/** `<dir>/**` (or `**`): everything below a literal directory — the only include form allowed to span a never path. */
const isBroad = (pattern) => pattern === '**' || /^[^*]+\/\*\*$/.test(pattern);

/**
 * An `include` that names never-public content is a manifest error, not something to drop quietly (spec
 * public-release "清单误含交接目录"): an include pattern lying inside a never-public category or naming an environment
 * file, or a narrower-than-a-directory include (a file name, a `*` pattern) that matches a never-public file of the
 * commit. A broad `<dir>/**` may span never paths (`release/**` and the private word list): those are dropped.
 */
export function neverPublicIncludes(manifest, files = []) {
  const never = neverMatchers(manifest);
  const out = [];
  for (const inc of manifest.include) {
    const category = never.find(({ re }) => re.test(foldPath(inc)));
    if (category) out.push(`include "${inc}" is in the never-public category ${category.p}`);
    else if (isEnvFile(inc)) out.push(`include "${inc}" names environment files (never public, but .env.example)`);
  }
  const narrow = manifest.include.filter((p) => !isBroad(p)).map((p) => ({ p, re: globToRegExp(p) }));
  for (const f of files) {
    const category = isEnvFile(f) ? 'environment files' : never.find(({ re }) => re.test(foldPath(f)))?.p;
    if (!category) continue;
    for (const { p, re } of narrow) if (re.test(f)) out.push(`include "${p}" matches ${f}, in the never-public category ${category}`);
  }
  return [...new Set(out)];
}

/**
 * Path names that must not leave: absolute, empty, `.` or `..` segments (path traversal), a `.git` segment in any
 * case (a nested repository), a backslash (a separator elsewhere) or a control character.
 */
export function unsafePaths(files) {
  return files.filter(
    // eslint-disable-next-line no-control-regex -- control characters are exactly what this refuses
    (f) => f.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(f) || f.split('/').some((s) => s === '' || s === '.' || s === '..' || foldPath(s) === '.git'),
  );
}

/** Which of `files` the manifest exports: the whitelist, minus the never-public paths and environment files, absolutely. */
export function selectPaths(files, manifest) {
  const include = manifest.include.map(globToRegExp);
  const never = neverMatchers(manifest);
  const exported = [];
  const dropped = [];
  for (const f of files) {
    const folded = foldPath(f);
    const ok = include.some((r) => r.test(f)) && !never.some(({ re }) => re.test(folded)) && !isEnvFile(f);
    (ok ? exported : dropped).push(f);
  }
  return { exported, dropped };
}

/** The private word list: one term per line, `#` comments; matched case-insensitively. */
export function parseTerms(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

/**
 * A buffer read every way a term could be stored in it: UTF-8, Latin-1 (any binary), and UTF-16 LE and BE from
 * either byte offset (an odd length or a stray byte must not hide UTF-16 text).
 */
function readings(buf) {
  const out = [buf.toString('utf8'), buf.toString('latin1')];
  for (const offset of [0, 1]) {
    const part = buf.subarray(offset, offset + Math.floor((buf.length - offset) / 2) * 2);
    out.push(part.toString('utf16le'), Buffer.from(part).swap16().toString('utf16le'));
  }
  return out.map((s) => s.toLowerCase());
}

/** Every place a private term occurs in `text`: line numbers (the term is not repeated in the report). */
function termLines(text, lowered) {
  const hits = [];
  text.split(/\r\n|\r|\n|\u0000/).forEach((line, i) => {
    lowered.forEach((t, k) => {
      if (line.includes(t)) hits.push({ line: i + 1, term: k + 1 });
    });
  });
  return hits;
}

/**
 * A repository URL fit to print: credentials removed — the userinfo of `scheme://user:secret@host/…` or of a bare
 * `user:secret@host/…`, and the value of any query or fragment parameter whose name looks like a credential (token,
 * key, secret, password, auth, signature) — so an error or log line never carries one.
 */
export function redactUrl(url) {
  return String(url ?? '')
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/i, '$1***@')
    .replace(/^[^/:@\s]+:[^/@\s]*@/, '***@')
    .replace(/([?&#;][^=&#;\s]*(?:token|key|secret|passw(?:or)?d|auth|sig)[^=&#;\s]*=)[^&#;\s]*/gi, '$1***');
}

/**
 * The `owner/name` (lower case) of a GitHub repository URL — https (credentials ignored), ssh or scp-like, with or
 * without `.git` — or null for anything else.
 */
export function githubRepositoryOf(url) {
  const bare = (url ?? '').trim().replace(/^(https:\/\/)[^/?#\s]*@/i, '$1');
  const m = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(bare);
  return m ? m[1].toLowerCase() : null;
}

/**
 * `text` with every occurrence of a private term (any case) replaced by `[term #n]`: reports name places, and a
 * place (a path, a link target) may itself hold a term.
 */
export function redactTerms(text, terms) {
  let out = String(text);
  terms.forEach((t, k) => {
    if (t) out = out.replace(new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), `[term #${k + 1}]`);
  });
  return out;
}

/** Private terms in the exported files (contents, path names, link targets): `place (term #n)`, the place redacted. */
export function findTerms(dir, files, terms) {
  const found = new Set();
  if (terms.length === 0) return [];
  const lowered = terms.map((t) => t.toLowerCase());
  for (const f of files) {
    const shown = redactTerms(f, terms);
    lowered.forEach((t, k) => {
      if (f.normalize('NFKC').toLowerCase().includes(t)) found.add(`${shown} (path, term #${k + 1})`);
    });
    const abs = path.join(dir, f);
    const content = fs.lstatSync(abs).isSymbolicLink() ? Buffer.from(fs.readlinkSync(abs)) : fs.readFileSync(abs);
    for (const text of readings(content)) {
      for (const h of termLines(text, lowered)) found.add(`${shown}:${h.line} (term #${h.term})`);
    }
  }
  return [...found];
}

/** The private word list of the repository at `root` (an error when the file is missing: the scan must run knowingly). */
function readTerms(root) {
  const termsPath = path.join(root, TERMS);
  if (!fs.existsSync(termsPath)) {
    throw new Error(`${TERMS} is missing: create it (it may hold only comments) so the private word scan runs knowingly`);
  }
  return parseTerms(fs.readFileSync(termsPath, 'utf8'));
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Plain UTF-8 text (no NUL): the only content the scans read with certainty. */
function isPlainText(buf) {
  if (buf.includes(0)) return false;
  try {
    UTF8.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Files the scans cannot read with certainty — anything but plain UTF-8 text (images, PDF, archives, compressed or
 * unknown binaries): refused unless their exact content (SHA-256) was reviewed. An allow-list of what is
 * scannable, not a list of formats to refuse.
 */
export function findOpaque(dir, files, reviewed) {
  const out = [];
  for (const f of files) {
    const abs = path.join(dir, f);
    if (fs.lstatSync(abs).isSymbolicLink()) continue;
    const buf = fs.readFileSync(abs);
    if (!isPlainText(buf) && !reviewed.has(sha256(buf))) out.push(`${f} (not plain UTF-8 text, sha256 ${sha256(buf)})`);
  }
  return out;
}

/** The first column (a SHA-256) of each non-comment line of a reviewed-list file. */
export function parseReviewed(text) {
  return new Set(
    text
      .split('\n')
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter(Boolean)
      .map((l) => l.split(/\s+/)[0]),
  );
}

/** The identity of a gitleaks finding: its path, rule and the exact text of its line. */
export function findingHash(file, rule, lineText) {
  return sha256(`${file}\u0000${rule}\u0000${lineText}`);
}

/**
 * Symbolic links must be relative and resolve — through any chain of links — to a file or directory inside the
 * export; a dangling link is refused too.
 */
export function badLinks(dir, files) {
  const out = [];
  // The native realpath resolves as the kernel does (links first, then `..`); the JavaScript one normalises `..`
  // before following links and would place `d/up/../..` inside the export when it is not.
  const root = fs.realpathSync.native(dir);
  for (const f of files) {
    const abs = path.join(dir, f);
    if (!fs.lstatSync(abs).isSymbolicLink()) continue;
    const target = fs.readlinkSync(abs);
    let real = null;
    try {
      real = fs.realpathSync.native(abs);
    } catch {
      out.push(`${f} -> ${target} (dangling)`);
      continue;
    }
    if (path.isAbsolute(target) || (real !== root && !real.startsWith(`${root}${path.sep}`))) out.push(`${f} -> ${target}`);
  }
  return out;
}

/**
 * Regular files with more than one link: an export checks out fresh files, so a hard link means the tree was changed
 * afterwards and the file may be shared with something outside it.
 */
export function hardLinks(dir, files) {
  return files.filter((f) => {
    const st = fs.lstatSync(path.join(dir, f));
    return st.isFile() && st.nlink > 1;
  });
}

/** The modified-files list keeping its comments and only the entries that are exported. */
export function filterModifiedList(text, exported) {
  return text
    .split('\n')
    .filter((line) => line === '' || line.startsWith('#') || exported.has(line))
    .join('\n');
}

function git(root, args, opts = {}) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 1024 * 1024 * 1024, ...opts });
}

/**
 * gitleaks over a tree; findings not reviewed (by path, rule and exact line) are returned as `file:line rule` — never
 * the matched text. It runs through the trusted runner of scripts/security-scanners.mjs (default rules from a
 * configuration outside the tree, no `GITLEAKS_*` variables; scanned trees may not hold scanner configuration at
 * all). A scanner that cannot run, fails, or reports no scanned bytes is an error: the scan is then not completed,
 * never passed.
 */
function gitleaksFindings(out, reviewed) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-gitleaks-'));
  const report = path.join(work, 'report.json');
  try {
    try {
      gitleaksScan({ dir: out, report });
    } catch (err) {
      throw new Error(`${err.message.split('\n')[0].replace(/:$/, '')}: the secret scan is NOT completed — nothing leaves unscanned (install a working gitleaks)`);
    }
    const findings = JSON.parse(fs.readFileSync(report, 'utf8') || '[]');
    const open = [];
    for (const f of findings) {
      const file = String(f.File).replace(/^\.\//, '');
      const lineText = fs.readFileSync(path.join(out, file), 'utf8').split('\n')[f.StartLine - 1] ?? '';
      const id = findingHash(file, f.RuleID, lineText);
      if (!reviewed.has(id)) open.push(`${file}:${f.StartLine} ${f.RuleID} (review id ${id})`);
    }
    return open;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

const readOptional = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

/**
 * The draft markers a final licence text must not carry, anywhere (whole words; "… between" means up to 80
 * characters on the same line): the marker comment `<!-- release: draft -->`; the word "draft" in any case (title,
 * `Status: draft`, "unsigned draft", …); "pending / awaiting / under / for … review" ("pending outside counsel
 * review", "for external counsel review"); "subject to … review / approval"; "to be reviewed"; "pending signature";
 * "not final", "not (yet) finalized / finalised"; 草案, 未定稿, and 待 / 未经 / 正在 … 审阅 / 审核 with up to 40 characters
 * between on the same line.
 */
const DRAFT_MARKERS = [
  /<!--\s*release:\s*draft\s*-->/i,
  /\bdrafts?\b/i,
  /\b(?:pending|awaiting|under|for)\b[^\n]{0,80}?\breview\b/i,
  /\bsubject\s+to\b[^\n]{0,80}?\b(?:review|approval)\b/i,
  /\bto\s+be\s+reviewed\b/i,
  /\bpending\s+signatures?\b/i,
  /\bnot\s+(?:yet\s+)?final(?:i[sz]ed)?\b/i,
  /草案|未定稿|(?:待|未经|正在)[^\n]{0,40}?(?:审阅|审核)/,
];

/**
 * A licence text still marked as a draft. The rule: a final licence text carries no draft marker (`DRAFT_MARKERS`)
 * anywhere. Finalising a text means removing every such marker, not only the first line.
 */
export function isDraftText(text) {
  return DRAFT_MARKERS.some((re) => re.test(text));
}

/** The licence files a release lacks in `dir`: missing, not a regular file, empty or still a draft. */
export function missingLicenseFiles(dir) {
  const out = [];
  for (const f of LICENSE_FILES) {
    const abs = path.join(dir, f);
    if (!fs.existsSync(abs) && !isLink(abs)) out.push(`${f} (missing)`);
    else if (!fs.lstatSync(abs).isFile()) out.push(`${f} (not a regular file)`);
    else {
      const text = fs.readFileSync(abs, 'utf8');
      if (!text.trim()) out.push(`${f} (empty)`);
      else if (isDraftText(text)) out.push(`${f} (a draft: the final, reviewed text is required)`);
    }
  }
  return out;
}

function isLink(abs) {
  try {
    return fs.lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Every check a tree must pass before it may leave, against the private lists of the repository at `root`: problems,
 * each naming files (and lines) only. `structure` checks what a published tree is made of (path names, environment
 * and scanner files, links); without it only contents are scanned (build outputs). `opaque` refuses what cannot be
 * scanned. A structural problem returns before any content is read.
 */
export function scanTree({ root, dir, files, structure = true, opaque = true }) {
  const problems = [];
  const terms = readTerms(root);
  const scannerFiles = files.filter((f) => isScannerConfigName(f.split('/').pop()));
  if (scannerFiles.length) problems.push(`scanner configuration in the tree (it could silence gitleaks or Trivy):\n  ${scannerFiles.join('\n  ')}`);
  if (structure) {
    const unsafe = unsafePaths(files);
    if (unsafe.length) problems.push(`unsafe path names:\n  ${unsafe.map((f) => JSON.stringify(f)).join('\n  ')}`);
    const envFiles = files.filter(isEnvFile);
    if (envFiles.length) problems.push(`environment files (never public, but .env.example):\n  ${envFiles.join('\n  ')}`);
    const links = badLinks(dir, files);
    if (links.length) problems.push(`symbolic links leaving the export:\n  ${links.join('\n  ')}`);
    const hard = hardLinks(dir, files);
    if (hard.length) problems.push(`hard links (shared with files outside the export):\n  ${hard.join('\n  ')}`);
  }
  if (problems.length) return problems.map((p) => redactTerms(p, terms));

  const hits = findTerms(dir, files, terms);
  if (hits.length) problems.push(`private terms in the export:\n  ${hits.join('\n  ')}`);
  if (opaque) {
    const unscannable = findOpaque(dir, files, parseReviewed(readOptional(path.join(root, OPAQUE_REVIEWED))));
    if (unscannable.length) problems.push(`files that cannot be scanned (review them, then list their sha256 in ${OPAQUE_REVIEWED}):\n  ${unscannable.join('\n  ')}`);
  }
  const leaks = gitleaksFindings(dir, parseReviewed(readOptional(path.join(root, GITLEAKS_REVIEWED))));
  if (leaks.length) problems.push(`gitleaks findings not reviewed (list a review id in ${GITLEAKS_REVIEWED} only if it is not a secret):\n  ${leaks.join('\n  ')}`);
  return problems.map((p) => redactTerms(p, terms));
}

/**
 * `git ls-tree -r -z` output as `{ mode, type, object, file }`, split at the first tab only: a path may itself hold
 * tabs (it is then refused as unsafe, whole — never truncated into another name).
 */
export function parseLsTree(text) {
  return text
    .split('\0')
    .filter(Boolean)
    .map((e) => {
      const tab = e.indexOf('\t');
      const [mode, type, object] = e.slice(0, tab).split(' ');
      return { mode, type, object, file: e.slice(tab + 1) };
    });
}

/** The entries of a git tree: `{ mode, object, file }` for every blob, link and gitlink. */
function listTree(tree, opts) {
  return parseLsTree(execFileSync('git', ['ls-tree', '-r', '-z', tree], { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024, ...opts })).map(
    ({ mode, object, file }) => ({ mode, object, file }),
  );
}

/**
 * The git tree of the export directory `out`, written into the (fresh, private) repository `gitDir` with a private
 * index — and checked to hold exactly the exported `entries`: the same paths and modes, and the same blobs but for
 * the files the export rewrites. A file added, removed or changed after exporting stops it.
 */
export function writeExportTree({ gitDir, out, entries, rewritten = new Set([MODIFIED_LIST]), env: extraEnv = {} }) {
  const env = { ...process.env, ...extraEnv, GIT_DIR: gitDir, GIT_WORK_TREE: out, GIT_INDEX_FILE: path.join(gitDir, 'export-index') };
  fs.rmSync(env.GIT_INDEX_FILE, { force: true });
  // --force: files the export's .gitignore would ignore are still part of the export.
  execFileSync('git', ['add', '--all', '--force', '.'], { cwd: out, env });
  const tree = execFileSync('git', ['write-tree'], { cwd: out, env, encoding: 'utf8' }).trim();
  const listed = listTree(tree, { cwd: out, env });
  const expected = new Map(entries.map((e) => [e.file, e]));
  if (listed.length !== expected.size) throw new Error(`the tree has ${listed.length} files, the export ${expected.size}`);
  for (const e of listed) {
    const want = expected.get(e.file);
    if (!want || want.mode !== e.mode || (want.object !== e.object && !rewritten.has(e.file))) throw new Error(`the tree differs from the export at ${e.file}`);
  }
  return tree;
}

/** Code and data files: never licence texts, whatever their name (`license-policy.json`, `cla.ts`). */
const CODE_OR_DATA = /\.(?:[cm]?[jt]sx?|json5?|ya?ml|toml|css|scss|less|html?|vue|svelte|astro|sql|sh|py|rb|go|rs|lock)$/;

/**
 * A licence-like file, compared folded; its text is published only when final:
 * - one of `LICENSE_FILES`, or anything under `LICENSES/` (but the generated list of modified upstream files);
 * - at any depth, a file named LICENSE / LICENCE / COPYING / CLA / COMMERCIAL-LICENSE, alone or with a suffix after
 *   `-` or `.` (`packages/sdk/LICENSE`, `LICENSE-MIT`, `CLA.md`), or NOTICE / NOTICE.md / NOTICE.txt (the Apache-2.0
 *   notice files of the packages);
 * - at the root, also COMMERCIAL* and LICENSE* / CLA* as a word (not `CLAUDE.md`);
 * but never a code or data file (`license-policy.json`, `claims.ts`).
 */
export function isLicenceLike(file) {
  if (file === MODIFIED_LIST) return false;
  if (LICENSE_FILES.includes(file)) return true;
  const folded = foldPath(file);
  if (folded.startsWith('licenses/')) return true;
  const base = folded.split('/').pop();
  if (CODE_OR_DATA.test(base)) return false;
  if (/^(?:licen[cs]e|copying|cla|commercial-licen[cs]e)(?:[-.][^/]*)?$/.test(base) || /^notice(?:\.(?:md|txt))?$/.test(base)) return true;
  return !folded.includes('/') && /^(?:licen[cs]e|copying|cla|commercial)(?:[^a-z]|$)/.test(folded);
}

/**
 * The licence-like files among `selected` whose committed text is still a draft. A symbolic link counts as its
 * target: a link to a draft is a draft (followed through the commit's tree, relative links only, a few hops).
 */
function draftLicenceFiles(root, entries, selected) {
  const byFile = new Map(entries.map((e) => [e.file, e]));
  const blobText = (e) => git(root, ['cat-file', 'blob', e.object], { encoding: 'utf8' });
  const resolve = (e) => {
    for (let hops = 0; e && e.mode === '120000' && hops < 8; hops++) {
      const target = blobText(e);
      if (path.posix.isAbsolute(target)) return null;
      e = byFile.get(path.posix.normalize(path.posix.join(path.posix.dirname(e.file), target)));
    }
    return e && e.mode !== '120000' && e.type === 'blob' ? e : null;
  };
  return selected
    .filter((f) => isLicenceLike(f))
    .filter((f) => {
      const target = resolve(byFile.get(f));
      return target !== null && isDraftText(blobText(target));
    });
}

/**
 * Export `commit` of the repository at `root` into the empty directory `out`. Throws on any finding; every report
 * has the private terms redacted (`[term #n]`). A release (`requireLicenses`) also requires every licence file, final
 * (`LICENSE_FILES`); any other export (the CI mirror) leaves out the licence files that are still drafts
 * (`draftLicences` in the result) and does not require the others.
 */
export function exportCommit(options) {
  try {
    return exportChecked(options);
  } catch (err) {
    let terms = [];
    try {
      terms = readTerms(options.root);
    } catch {
      // No list, nothing to redact (the scan itself reports the missing list).
    }
    err.message = redactTerms(err.message, terms);
    throw err;
  }
}

function exportChecked({ root, commit = 'HEAD', out, requireLicenses = false }) {
  const sha = git(root, ['rev-parse', '--verify', `${commit}^{commit}`], { encoding: 'utf8' }).trim();
  const manifest = parseManifest(git(root, ['show', `${sha}:${MANIFEST}`], { encoding: 'utf8' }));
  const entries = parseLsTree(git(root, ['ls-tree', '-r', '-z', sha], { encoding: 'utf8' }));
  const allFiles = entries.map((e) => e.file);
  const wrongIncludes = neverPublicIncludes(manifest, allFiles);
  if (wrongIncludes.length) {
    throw new Error(`${MANIFEST} includes never-public paths (they are never exported, whatever the manifest says):\n  ${wrongIncludes.join('\n  ')}`);
  }
  const variants = nameVariants(allFiles, manifest);
  if (variants.length) {
    throw new Error(`names that are a variant of never-public, environment or scanner files (one name on a case-insensitive file system):\n  ${variants.join('\n  ')}`);
  }
  const submodules = entries.filter((e) => e.type === 'commit').map((e) => e.file);
  if (selectPaths(submodules, manifest).exported.length > 0) throw new Error(`submodules cannot be exported: ${submodules.join(', ')}`);
  const selected = selectPaths(
    entries.filter((e) => e.type === 'blob').map((e) => e.file),
    manifest,
  ).exported;
  // A licence text still in draft is never published: a release refuses it (below); every other export — the CI
  // mirror — leaves it out (it is read from the commit, so it never touches the disk).
  const drafts = draftLicenceFiles(root, entries, selected);
  const draftLicences = requireLicenses ? [] : drafts;
  const exported = selected.filter((f) => !draftLicences.includes(f));
  const unsafe = unsafePaths(exported);
  if (unsafe.length) throw new Error(`unsafe path names:\n  ${unsafe.map((f) => JSON.stringify(f)).join('\n  ')}`);

  fs.mkdirSync(out, { recursive: true });
  if (fs.readdirSync(out).length > 0) throw new Error(`${out} is not empty`);
  // Only the exported paths are written — the others never touch the disk: a temporary index holds the commit's
  // tree, loses every path not exported, and is checked out (modes and symbolic links kept).
  const index = path.join(os.tmpdir(), `heopress-export-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    git(root, ['read-tree', sha], { env });
    const exportedSet = new Set(exported);
    const remove = entries.map((e) => e.file).filter((f) => !exportedSet.has(f));
    if (remove.length > 0) git(root, ['update-index', '--force-remove', '-z', '--stdin'], { env, input: `${remove.join('\0')}\0` });
    git(root, ['checkout-index', '--all', '--force', `--prefix=${out.replace(/\/?$/, '/')}`], { env });
  } finally {
    fs.rmSync(index, { force: true });
  }

  // Links first, before anything in the export is read or written: a link must never lead a write outside it.
  const links = badLinks(out, exported);
  if (links.length) throw new Error(`symbolic links leaving the export:\n  ${links.join('\n  ')}`);

  // The Apache-2.0 §4(b) list of modified upstream files names what is distributed: the export's files only.
  // It must be a regular file (never written through a link).
  const modifiedList = path.join(out, MODIFIED_LIST);
  if (fs.existsSync(modifiedList)) {
    if (!fs.lstatSync(modifiedList).isFile()) throw new Error(`${MODIFIED_LIST} must be a regular file`);
    fs.writeFileSync(modifiedList, filterModifiedList(fs.readFileSync(modifiedList, 'utf8'), new Set(exported)));
  }

  // Scan before anything can leave.
  const problems = scanTree({ root, dir: out, files: exported });
  if (requireLicenses) {
    const licences = missingLicenseFiles(out);
    if (licences.length) problems.push(`licence files a release must carry (ADR-0008, ADR-0010 §7):\n  ${licences.join('\n  ')}`);
    if (drafts.length) problems.push(`licence texts that are still drafts (a release publishes final texts only):\n  ${drafts.join('\n  ')}`);
  }
  if (problems.length) throw new Error(problems.join('\n'));
  const exportedSet = new Set(exported);
  return { sha, files: exported.length, exported, draftLicences, entries: entries.filter((e) => exportedSet.has(e.file)) };
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = path.resolve(arg('--root') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const out = arg('--out');
  if (!out) {
    console.error('usage: public-export.mjs --out <empty dir> [--commit <rev>] [--root <repo>] [--require-licenses]');
    process.exit(2);
  }
  try {
    const result = exportCommit({ root, commit: arg('--commit') ?? 'HEAD', out: path.resolve(out), requireLicenses: argv.includes('--require-licenses') });
    console.log(`[public-export] ${result.files} files of ${result.sha} exported and scanned into ${out}`);
    if (result.draftLicences.length) console.log(`[public-export] left out, still drafts: ${result.draftLicences.join(', ')}`);
  } catch (err) {
    console.error(`[public-export] stopped: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) main(process.argv.slice(2));
