/**
 * The audit ignores of `pnpm-workspace.yaml` (`auditConfig.ignoreGhsas` / `auditConfig.ignoreCves`), read and removed
 * without a YAML library (P07 task 8.1): the settings parity check and the security scans run before — or without —
 * `pnpm install`, so they must not depend on one.
 *
 * Keys may be plain, single- or double-quoted (`auditConfig:`, `'auditConfig':`, `"ignoreCves":`); lists may be block
 * (`- GHSA-…`) or flow (`[GHSA-…, "CVE-…"]`) sequences, and `auditConfig` may be a flow mapping. Anything else under a
 * top-level `auditConfig` key (another key, an alias, a scalar) is refused: an ignore that cannot be read must not be
 * skipped silently.
 */

const IGNORE_KEYS = ['ignoreGhsas', 'ignoreCves'];

/** A YAML scalar or key without its quotes. */
function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && ((v[0] === "'" && v.at(-1) === "'") || (v[0] === '"' && v.at(-1) === '"'))) {
    return v[0] === "'" ? v.slice(1, -1).replace(/''/g, "'") : v.slice(1, -1).replace(/\\"/g, '"');
  }
  return v;
}

/** A line without its comment (a `#` at the start or after whitespace, outside quotes). */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === "'" || c === '"') quote = c;
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/** `key: rest` of a line (key unquoted), or null. */
function keyOf(line) {
  const m = /^(\s*)('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s:'"][^:]*?)\s*:(?:\s+(.*)|\s*)$/.exec(line);
  return m ? { indent: m[1].length, key: unquote(m[2]), rest: (m[3] ?? '').trim() } : null;
}

/** The items of a flow sequence `[a, "b"]`. */
function flowSequence(text, where) {
  const t = text.trim();
  if (!t.startsWith('[') || !t.endsWith(']')) throw new Error(`${where}: not a list (${t})`);
  const inner = t.slice(1, -1).trim();
  return inner ? inner.split(',').map((s) => unquote(s)).filter(Boolean) : [];
}

/** The line range [start, end) of the top-level `auditConfig` block, or null. */
function auditBlock(lines) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i]);
    if (!line.trim() || /^\s/.test(line)) continue;
    const k = keyOf(line);
    if (start !== -1) return { start, end: i };
    if (k && k.indent === 0 && k.key === 'auditConfig') start = i;
  }
  return start === -1 ? null : { start, end: lines.length };
}

/** `{ ignoreGhsas, ignoreCves }` of a pnpm-workspace.yaml text (empty lists when there is no `auditConfig`). */
export function readWorkspaceAuditIgnores(text) {
  const out = { ignoreGhsas: [], ignoreCves: [] };
  const lines = String(text ?? '').split('\n');
  const block = auditBlock(lines);
  if (!block) {
    // A top-level auditConfig the reader did not recognise (a malformed key) must not pass as "no ignores".
    if (lines.some((l) => /^\S.*auditConfig/.test(stripComment(l)))) throw new Error('pnpm-workspace.yaml: an auditConfig key that cannot be read');
    return out;
  }
  const head = keyOf(stripComment(lines[block.start]));
  if (head.rest) {
    // A flow mapping: { ignoreCves: [..], 'ignoreGhsas': [..] }
    const t = head.rest;
    if (!t.startsWith('{') || !t.endsWith('}')) throw new Error(`pnpm-workspace.yaml: auditConfig is not a mapping (${t})`);
    const re = /('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[A-Za-z]+)\s*:\s*(\[[^\]]*\])/g;
    let consumed = t.slice(1, -1);
    for (const m of t.slice(1, -1).matchAll(re)) {
      const key = unquote(m[1]);
      if (!IGNORE_KEYS.includes(key)) throw new Error(`pnpm-workspace.yaml: unknown auditConfig key ${key}`);
      out[key].push(...flowSequence(m[2], `auditConfig.${key}`));
      consumed = consumed.replace(m[0], '');
    }
    if (consumed.replace(/[\s,]/g, '')) throw new Error(`pnpm-workspace.yaml: auditConfig holds something that cannot be read (${t})`);
    return out;
  }
  let current = null;
  for (let i = block.start + 1; i < block.end; i++) {
    const line = stripComment(lines[i]);
    if (!line.trim()) continue;
    const item = /^\s+-\s*(.*)$/.exec(line);
    if (item) {
      if (!current) throw new Error(`pnpm-workspace.yaml:${i + 1}: a list item outside ignoreGhsas / ignoreCves`);
      out[current].push(unquote(item[1]));
      continue;
    }
    const k = keyOf(line);
    if (!k || !IGNORE_KEYS.includes(k.key)) throw new Error(`pnpm-workspace.yaml:${i + 1}: auditConfig holds something that cannot be read`);
    current = k.key;
    if (k.rest) {
      out[current].push(...flowSequence(k.rest, `pnpm-workspace.yaml:${i + 1}`));
      current = null;
    }
  }
  return out;
}

/** The pnpm-workspace.yaml text without its top-level `auditConfig` block (checked: nothing of it may remain). */
export function workspaceWithoutAuditIgnores(text) {
  readWorkspaceAuditIgnores(text); // refuses what it cannot read
  const lines = String(text).split('\n');
  const block = auditBlock(lines);
  if (!block) return text;
  const out = [...lines.slice(0, block.start), ...lines.slice(block.end)].join('\n');
  if (auditBlock(out.split('\n'))) throw new Error('pnpm-workspace.yaml: more than one auditConfig key');
  return out;
}

/** The ignores of both copies: package.json `pnpm.auditConfig` and pnpm-workspace.yaml `auditConfig`. */
export function allAuditIgnores(pkg, workspaceText) {
  const config = pkg?.pnpm?.auditConfig ?? {};
  const ws = readWorkspaceAuditIgnores(workspaceText ?? '');
  return [...new Set([...(config.ignoreGhsas ?? []), ...(config.ignoreCves ?? []), ...ws.ignoreGhsas, ...ws.ignoreCves].map(String))];
}
