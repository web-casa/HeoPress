#!/usr/bin/env node
/**
 * Handoff and agent-entry checks (P01 `engineering/agent-handoff`).
 *
 * - CLAUDE.md must contain only `@AGENTS.md` (AGENTS.md is the single agent entry).
 * - Every docs/handoffs/*.md must have the required sections.
 * - Commands in the "验证快照" (verification snapshot) code blocks must be read-only:
 *   whitelisted commands only, no command substitution, no redirection to files,
 *   no pipes into anything but read-only filters, no dangerous arguments and no
 *   environment that points at shared services. `pnpm test` must run with an
 *   empty DATABASE_URL so the database suites skip instead of resetting whatever
 *   database the shell points at. Every command needs an expectation.
 * - From P04 on (ADR-0017 traceability), each result in a handoff's
 *   "测试命令与结果" section is PASS, FAIL or NOT_RUN: every list item that
 *   names a command carries one of them.
 * - Test files named in the verification of an active change's tasks.md
 *   must exist (a path from the root, or a file name found in the repo).
 *
 * Usage: node scripts/docs-check.mjs [--root <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_SECTIONS = [
  { key: '当前 change', name: '当前 change、分支、最后提交' },
  { key: '已完成', name: '已完成与未完成任务' },
  { key: '测试命令与结果', name: '测试命令与结果' },
  { key: '风险', name: '风险与约束' },
  { key: '下一步', name: '下一步' },
  { key: '验证快照', name: '验证快照' },
];

const FILTERS = new Set(['head', 'tail', 'grep', 'wc', 'sort', 'uniq', 'cut']);
const SAFE_ENV = new Set(['OPENSPEC_TELEMETRY', 'npm_config_offline', 'HUSKY', 'CI', 'TZ', 'LANG', 'LC_ALL']);
const SAFE_REDIRECTS = new Set(['>/dev/null', '1>/dev/null', '2>/dev/null', '&>/dev/null', '2>&1']);

export function checkClaudeMd(text) {
  return text.trim() === '@AGENTS.md' ? [] : ['CLAUDE.md must contain only "@AGENTS.md"'];
}

/** Split a markdown document into `## ` sections: [{ heading, body }]. */
function sections(text) {
  const out = [];
  let current = null;
  for (const line of text.split('\n')) {
    const m = /^##\s+(.*)$/.exec(line);
    if (m) {
      current = { heading: m[1].trim(), body: [] };
      out.push(current);
    } else if (current) {
      current.body.push(line);
    }
  }
  return out;
}

/** Commands (with their expectation) from the fenced code blocks of the snapshot section. */
export function snapshotCommands(text) {
  const section = sections(text).find((s) => s.heading.includes('验证快照'));
  if (!section) return [];
  const commands = [];
  let inFence = false;
  for (const raw of section.body) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (!inFence || line === '') continue;
    if (line.startsWith('#')) {
      const expect = /^#\s*expect\s*:\s*(.+)$/i.exec(line);
      if (expect && commands.length > 0 && !commands.at(-1).expect) commands.at(-1).expect = expect[1].trim();
      continue;
    }
    const hash = findCommentStart(line);
    const command = (hash === -1 ? line : line.slice(0, hash)).trim();
    const comment = hash === -1 ? '' : line.slice(hash);
    const expect = /#\s*expect\s*:\s*(.+)$/i.exec(comment);
    commands.push({ command, expect: expect ? expect[1].trim() : null });
  }
  return commands;
}

/** Index of an unquoted `#` that starts a comment (preceded by whitespace), or -1. */
function findCommentStart(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return i;
    }
  }
  return -1;
}

/**
 * Tokenize a command line into words and operators, honouring quotes.
 * Throws on constructs that are never allowed (substitution, unterminated quotes).
 */
export function tokenize(command) {
  if (/\$\(|`|\$\{|<\(|>\(/.test(command)) throw new Error('command substitution or expansion is not allowed');
  const tokens = [];
  let i = 0;
  const readWord = () => {
    let word = '';
    while (i < command.length && !/\s/.test(command[i]) && !'|;&<>'.includes(command[i])) {
      const ch = command[i];
      if (ch === "'" || ch === '"') {
        const end = command.indexOf(ch, i + 1);
        if (end === -1) throw new Error('unterminated quote');
        word += command.slice(i + 1, end);
        i = end + 1;
      } else {
        word += ch;
        i += 1;
      }
    }
    return word;
  };
  const readRedirect = (prefix) => {
    // prefix is e.g. ">", ">>", "2>", "&>", "<"; target is "&N" or a word.
    while (i < command.length && /\s/.test(command[i])) i += 1;
    let target;
    if (command[i] === '&' && /\d/.test(command[i + 1] ?? '')) {
      target = command.slice(i, i + 2);
      i += 2;
    } else {
      target = readWord();
    }
    tokens.push({ op: `${prefix}${target}` });
  };
  while (i < command.length) {
    const c = command[i];
    const two = command.slice(i, i + 2);
    if (/\s/.test(c)) { i += 1; continue; }
    if (two === '&&' || two === '||') { tokens.push({ op: two }); i += 2; continue; }
    if (two === '&>') { i += 2; readRedirect('&>'); continue; }
    if (/\d/.test(c) && (command[i + 1] === '>' || command[i + 1] === '<')) {
      const prefix = command.slice(i, command[i + 2] === '>' ? i + 3 : i + 2);
      i += prefix.length;
      readRedirect(prefix);
      continue;
    }
    if (c === '>' || c === '<') {
      const prefix = two === '>>' ? '>>' : c;
      i += prefix.length;
      readRedirect(prefix);
      continue;
    }
    if (c === '|' || c === ';' || c === '&') { tokens.push({ op: c }); i += 1; continue; }
    tokens.push({ word: readWord() });
  }
  return tokens;
}

/** Operands (non-option arguments) of a plain filter command. */
const operands = (args) => args.filter((a) => a === '-' || !a.startsWith('-'));

function checkSegment(words, { afterPipe }) {
  const problems = [];
  const env = new Map();
  let k = 0;
  while (k < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[k])) {
    const eq = words[k].indexOf('=');
    const name = words[k].slice(0, eq);
    const value = words[k].slice(eq + 1);
    env.set(name, value);
    // An empty DATABASE_URL only switches the database suites off.
    const harmless = SAFE_ENV.has(name) || (name === 'DATABASE_URL' && value === '');
    if (!harmless) problems.push(`environment variable ${name} is not allowed (shared services or secrets)`);
    k += 1;
  }
  const [cmd, ...args] = words.slice(k);
  if (!cmd) return ['empty command'];
  const deny = (msg) => problems.push(msg);
  if (afterPipe && !FILTERS.has(cmd)) {
    deny(`"${cmd}" may not receive piped input; only ${[...FILTERS].join(', ')} may`);
    return problems;
  }
  switch (cmd) {
    case 'git': {
      const [sub, ...gitArgs] = args;
      const readOnly = new Set(['rev-parse', 'status', 'log', 'diff', 'branch', 'check-ignore', 'ls-files', 'show', 'merge-base', 'cat-file']);
      if (!readOnly.has(sub)) deny(`"git ${sub ?? ''}" is not a whitelisted read-only git command`);
      if (gitArgs.some((a) => /^--output(=|$)/.test(a) || a === '-o')) deny('git output-to-file arguments are not allowed');
      if (sub === 'branch' && gitArgs.some((a) => !['--show-current', '--list', '-a', '-r', '-v', '-vv'].includes(a))) {
        deny('git branch is only allowed with --show-current, --list, -a, -r or -v');
      }
      if (sub === 'cat-file' && gitArgs.some((a) => a.startsWith('-') && !['-e', '-t', '-s'].includes(a))) deny('git cat-file is only allowed with -e, -t or -s');
      break;
    }
    case 'pnpm': {
      const scripts = new Set(['typecheck', 'test', 'lint', 'check:all', 'notices:check', 'docs:check']);
      const positional = args.filter((a, idx) => !a.startsWith('-') && !['-F', '--filter'].includes(args[idx - 1]));
      if (!positional.length || !scripts.has(positional[0])) deny(`"pnpm ${args.join(' ')}" is not a whitelisted check (typecheck, test, lint, check:all, notices:check, docs:check)`);
      if (args.some((a) => ['-u', '--update', '--fix', '--write', '--watch', '-w=false'].includes(a) || a.startsWith('--update'))) {
        deny('pnpm arguments that write files or watch are not allowed');
      }
      if (args.some((a) => /^--?(output|outfile|out-file)/i.test(a) || /^--[a-z-]*(outputfile|output-file)/i.test(a))) {
        deny('pnpm arguments that write a report file are not allowed');
      }
      if (positional[0] === 'test' && env.get('DATABASE_URL') !== '') {
        // The database suites reset the install state of whatever DATABASE_URL names.
        deny('pnpm test must run as "DATABASE_URL= pnpm test" so the database suites skip');
      }
      break;
    }
    case 'npx': {
      const ok = args[0] === '-y' && args[1] === '@fission-ai/openspec@1.14.1' && ['validate', 'status', 'list', 'show'].includes(args[2]);
      if (!ok) deny('npx is only allowed as "npx -y @fission-ai/openspec@1.14.1 validate|status|list|show"');
      break;
    }
    case 'test': {
      if (!args.every((a) => ['-f', '-d', '-e', '-s', '!'].includes(a) || !a.startsWith('-'))) deny('test is only allowed with -f, -d, -e, -s or !');
      break;
    }
    case 'sort':
      if (args.some((a) => /^-[^-]*o/.test(a) || a.startsWith('--output'))) deny('sort -o writes a file');
      if (args.some((a) => a.startsWith('--compress-program'))) deny('sort --compress-program runs a program');
      break;
    case 'uniq':
      // `uniq INPUT OUTPUT` writes OUTPUT.
      if (operands(args).length > 1) deny('uniq with an output file is not allowed');
      break;
    case 'cat': case 'ls': case 'grep': case 'head': case 'tail': case 'wc': case 'cut': case 'echo':
      break;
    default:
      deny(`"${cmd}" is not a whitelisted read-only command`);
  }
  return problems;
}

/** Problems with one snapshot command line; empty when it is read-only. */
export function checkCommand(command) {
  let tokens;
  try {
    tokens = tokenize(command);
  } catch (err) {
    return [err.message];
  }
  const problems = [];
  let words = [];
  let afterPipe = false;
  const flush = () => {
    problems.push(...checkSegment(words, { afterPipe }));
    words = [];
  };
  for (const t of tokens) {
    if (t.word !== undefined) {
      words.push(t.word);
      continue;
    }
    const op = t.op;
    if (op === '|') { flush(); afterPipe = true; continue; }
    if (op === '&&' || op === '||') { flush(); afterPipe = false; continue; }
    if (op === ';' || op === '&') { problems.push(`"${op}" is not allowed; chain checks with && instead`); continue; }
    if (/^<|^\d?>|^>|^&>/.test(op)) {
      if (!SAFE_REDIRECTS.has(op)) problems.push(`redirection "${op}" is not allowed (only to /dev/null or 2>&1)`);
      continue;
    }
    problems.push(`operator "${op}" is not allowed`);
  }
  flush();
  return [...new Set(problems)];
}

export const RESULT_STATUSES = ['PASS', 'FAIL', 'NOT_RUN'];
const STATUS_RE = /(?<![A-Za-z_])(PASS|FAIL|NOT_RUN)(?![A-Za-z_])/;

/** The phase number in a handoff file name (`…-p04-…` → 4), or null. */
function phaseOf(name) {
  const m = /-p(\d{2})-/.exec(name);
  return m ? Number(m[1]) : null;
}

/**
 * A result record: a list item (`-`, `*`, `+`, `1.`) or a table row whose text
 * starts with the backticked command, e.g. "- `pnpm test`：PASS — 3460 passed"
 * or "| `pnpm lint` | FAIL | 2 errors |". Other lines (notes, a seed in
 * backticks mid-sentence) are not records.
 */
function resultRecord(line) {
  const m = /^(?:[-*+]\s+|\d+[.)]\s+|\|\s*)(`[^`]+`)(.*)$/.exec(line);
  return m ? { command: m[1], rest: m[2] } : null;
}

/** From P04 on: every result record carries PASS, FAIL or NOT_RUN, and there is at least one. */
export function checkTestResults(text, name) {
  const phase = phaseOf(name);
  if (phase === null || phase < 4) return [];
  const section = sections(text).find((s) => s.heading.includes('测试命令与结果'));
  if (!section) return [];
  const problems = [];
  let inFence = false;
  let records = 0;
  for (const raw of section.body) {
    const line = raw.trim();
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\|[\s:-]+\|/.test(line)) continue; // fenced commands; a table's separator row
    const record = resultRecord(line);
    if (!record) continue;
    records += 1;
    if (!STATUS_RE.test(record.rest)) problems.push(`${name}: test result without PASS / FAIL / NOT_RUN: ${line.slice(0, 80)}`);
  }
  if (records === 0) problems.push(`${name}: "测试命令与结果" records no result ("- \`command\`：PASS | FAIL | NOT_RUN")`);
  return problems;
}

const TEST_FILE_RE = /[\w./@-]*[\w-]\.(?:test|spec)\.(?:ts|tsx|mts|js|mjs)\b/g;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.turbo', 'coverage', 'build']);

/** Test file names referenced in a tasks.md. */
export function referencedTestFiles(text) {
  return [...new Set(text.match(TEST_FILE_RE) ?? [])];
}

function testFileNames(root) {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (/\.(?:test|spec)\./.test(entry.name)) {
        names.add(entry.name);
      }
    }
  };
  for (const top of ['apps', 'packages', 'scripts', 'tests', 'e2e']) {
    if (fs.existsSync(path.join(root, top))) walk(path.join(root, top));
  }
  return names;
}

/** Test files named in active changes' tasks.md that do not exist. */
export function checkTaskTestRefs(root) {
  const changes = path.join(root, 'openspec', 'changes');
  if (!fs.existsSync(changes)) return [];
  let names = null;
  const problems = [];
  for (const change of fs.readdirSync(changes).sort()) {
    const tasks = path.join(changes, change, 'tasks.md');
    if (change === 'archive' || !fs.existsSync(tasks)) continue;
    for (const ref of referencedTestFiles(fs.readFileSync(tasks, 'utf8'))) {
      const exists = ref.includes('/') ? fs.existsSync(path.join(root, ref)) : (names ??= testFileNames(root)).has(ref);
      if (!exists) problems.push(`openspec/changes/${change}/tasks.md: test file "${ref}" does not exist`);
    }
  }
  return problems;
}

export function checkHandoff(text, name) {
  const problems = [...checkTestResults(text, name)];
  const heads = sections(text).map((s) => s.heading);
  for (const req of REQUIRED_SECTIONS) {
    if (!heads.some((h) => h.includes(req.key))) problems.push(`${name}: missing section "${req.name}"`);
  }
  const commands = snapshotCommands(text);
  if (heads.some((h) => h.includes('验证快照')) && commands.length === 0) problems.push(`${name}: verification snapshot has no commands`);
  for (const { command, expect } of commands) {
    for (const p of checkCommand(command)) problems.push(`${name}: snapshot command \`${command}\`: ${p}`);
    if (!expect) problems.push(`${name}: snapshot command \`${command}\` has no "# expect:" result`);
  }
  return problems;
}

export function runDocsCheck(root) {
  const problems = [];
  const claude = path.join(root, 'CLAUDE.md');
  problems.push(...(fs.existsSync(claude) ? checkClaudeMd(fs.readFileSync(claude, 'utf8')) : ['CLAUDE.md is missing']));
  const dir = path.join(root, 'docs', 'handoffs');
  for (const file of fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort() : []) {
    problems.push(...checkHandoff(fs.readFileSync(path.join(dir, file), 'utf8'), `docs/handoffs/${file}`));
  }
  problems.push(...checkTaskTestRefs(root));
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const idx = process.argv.indexOf('--root');
  const root = idx === -1 ? process.cwd() : path.resolve(process.argv[idx + 1]);
  const problems = runDocsCheck(root);
  if (problems.length > 0) {
    console.error(`[docs-check] ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  ✖ ${p}`);
    process.exit(1);
  }
  console.log('[docs-check] ok');
}
