/**
 * Field- and block-level diff and three-way merge of content branches (HeoPress P10 tasks 4.1, 4.3; spec
 * agents/content-branches "合并冲突不静默覆盖").
 *
 * A branch remembers main as it was when the branch was made (`base`). Merging compares both sides with it:
 *
 *   - a field (or a block) only one side changed takes that side's value — the other side's change is kept;
 *   - both sides changed it to the same value: that value;
 *   - both sides changed it differently: a **conflict**, listing base, main and branch; a person chooses `main` or
 *     `branch`. Nothing is resolved silently, and an unresolved conflict fails the merge.
 *
 * Blocks are the units of rich text (top-level elements with `data-block-id`) and repeaters (rows with `_blockId`),
 * see `block-ids.ts`. When both sides changed a block field, it is merged block by block: different blocks merge,
 * the same block changed (or changed on one side and removed on the other) is a block conflict, and both sides
 * reordering the blocks differently is an order conflict. A value without usable block ids is merged as a whole field.
 *
 * Pure functions: no database, no clock.
 */
import { parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { BlockFieldKind } from '../block-ids';

type Data = Record<string, unknown>;
type Side = 'main' | 'branch';
export type Resolutions = Readonly<Record<string, Side>>;

interface BlockChange {
  blockId: string;
  kind: 'added' | 'removed' | 'changed' | 'moved';
  before?: unknown;
  after?: unknown;
}

export interface FieldChange {
  field: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
  /** For a block field whose both values have block ids: which blocks changed. */
  blocks?: BlockChange[];
}

export interface MergeConflict {
  /** `title`, `body#b_abc` (a block) or `body#order` (block order); the key of a resolution. */
  id: string;
  field: string;
  kind: 'field' | 'block' | 'order';
  blockId: string | null;
  base: unknown;
  main: unknown;
  branch: unknown;
}

export interface MergeOutcome {
  /** The merged data; for an unresolved conflict it holds main's value (it is never written while one remains). */
  data: Data;
  /** Every conflict found, resolved or not. */
  conflicts: MergeConflict[];
  /** Conflicts without a resolution: the merge fails while any remain. */
  unresolved: MergeConflict[];
  /** Fields that took the branch's change. */
  fromBranch: string[];
  /** Fields that kept main's change (made after the branch was created). */
  fromMain: string[];
}

// ── equality ────────────────────────────────────────────────────────

function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'undefined';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Data)
        .sort()
        .map((k) => [k, sortKeys((value as Data)[k])]),
    );
  }
  return value;
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

// ── blocks ──────────────────────────────────────────────────────────

interface Block {
  id: string;
  value: unknown;
}

interface Blocks {
  list: Block[];
  /** The text between blocks in the source (html), reused when joining. */
  separator: string;
}

type Element = DefaultTreeAdapterMap['element'];

/** The blocks of a value, or null when it has none with unique ids (then it merges as a whole field). */
export function blocksOf(value: unknown, kind: BlockFieldKind): Blocks | null {
  if (value === undefined || value === null || value === '') return { list: [], separator: '' };
  if (kind === 'rows') {
    if (!Array.isArray(value)) return null;
    const seen = new Set<string>();
    const list: Block[] = [];
    for (const row of value) {
      const id = row && typeof row === 'object' && !Array.isArray(row) ? (row as Data)._blockId : undefined;
      if (typeof id !== 'string' || !id || seen.has(id)) return null;
      seen.add(id);
      list.push({ id, value: row });
    }
    return { list, separator: '' };
  }
  if (typeof value !== 'string') return null;
  const fragment = parseFragment(value, { sourceCodeLocationInfo: true });
  const seen = new Set<string>();
  const list: Block[] = [];
  let separator: string | null = null;
  let lastEnd = 0;
  for (const node of fragment.childNodes) {
    const loc = node.sourceCodeLocation;
    if (!loc) return null;
    if (!('tagName' in node)) {
      // Text between blocks must be whitespace (or a comment): anything else is content without an id.
      if (node.nodeName === '#text' && (node as { value: string }).value.trim() !== '') return null;
      continue;
    }
    const el = node as Element;
    const id = el.attrs.find((a) => a.name === 'data-block-id')?.value;
    if (!id || seen.has(id)) return null;
    seen.add(id);
    if (list.length === 1 && separator === null) separator = value.slice(lastEnd, loc.startOffset);
    list.push({ id, value: value.slice(loc.startOffset, loc.endOffset) });
    lastEnd = loc.endOffset;
  }
  return { list, separator: separator !== null && separator.trim() === '' ? separator : '' };
}

function joinBlocks(list: Block[], kind: BlockFieldKind, separator: string): unknown {
  return kind === 'rows' ? list.map((b) => b.value) : list.map((b) => b.value as string).join(separator);
}

function blockDiff(before: Blocks, after: Blocks): BlockChange[] {
  const b = new Map(before.list.map((x) => [x.id, x.value]));
  const a = new Map(after.list.map((x) => [x.id, x.value]));
  const out: BlockChange[] = [];
  for (const x of before.list) if (!a.has(x.id)) out.push({ blockId: x.id, kind: 'removed', before: x.value });
  for (const x of after.list) {
    if (!b.has(x.id)) out.push({ blockId: x.id, kind: 'added', after: x.value });
    else if (!same(b.get(x.id), x.value)) out.push({ blockId: x.id, kind: 'changed', before: b.get(x.id), after: x.value });
  }
  // Moved: blocks kept on both sides whose relative order changed.
  const keptBefore = before.list.filter((x) => a.has(x.id)).map((x) => x.id);
  const keptAfter = after.list.filter((x) => b.has(x.id)).map((x) => x.id);
  keptAfter.forEach((id, i) => {
    if (keptBefore[i] !== id && !out.some((c) => c.blockId === id)) out.push({ blockId: id, kind: 'moved' });
  });
  return out;
}

// ── diff ────────────────────────────────────────────────────────────

/** What changed from `before` to `after`, per field, and per block in block fields. */
export function diffData(before: Data, after: Data, blockFields: ReadonlyMap<string, BlockFieldKind>): FieldChange[] {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: FieldChange[] = [];
  for (const field of keys) {
    const inB = Object.prototype.hasOwnProperty.call(before, field);
    const inA = Object.prototype.hasOwnProperty.call(after, field);
    if (inB && inA && same(before[field], after[field])) continue;
    const change: FieldChange = { field, kind: !inB ? 'added' : !inA ? 'removed' : 'changed', before: before[field], after: after[field] };
    const kind = blockFields.get(field);
    if (kind) {
      const bb = blocksOf(before[field], kind);
      const ab = blocksOf(after[field], kind);
      if (bb && ab) change.blocks = blockDiff(bb, ab);
    }
    out.push(change);
  }
  return out;
}

// ── merge ───────────────────────────────────────────────────────────

const ABSENT = Symbol('absent');
type Val = unknown | typeof ABSENT;

function pick(o: Data, k: string): Val {
  return Object.prototype.hasOwnProperty.call(o, k) ? o[k] : ABSENT;
}

const eq = (a: Val, b: Val) => (a === ABSENT || b === ABSENT ? a === b : same(a, b));
const shown = (v: Val) => (v === ABSENT ? null : v);

/** The relative order of `ids` within `list`. */
const orderOf = (list: Block[], ids: Set<string>) => list.filter((b) => ids.has(b.id)).map((b) => b.id);
const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Merge one block field whose three values all have block ids; conflicts are added to `conflicts`. */
function mergeBlocks(
  field: string,
  kind: BlockFieldKind,
  base: Blocks,
  main: Blocks,
  branch: Blocks,
  mainRaw: unknown,
  branchRaw: unknown,
  resolutions: Resolutions,
  conflicts: MergeConflict[],
): unknown {
  const B = new Map(base.list.map((b) => [b.id, b.value]));
  const M = new Map(main.list.map((b) => [b.id, b.value]));
  const R = new Map(branch.list.map((b) => [b.id, b.value]));
  const ids = [...new Set([...B.keys(), ...M.keys(), ...R.keys()])];
  const content = new Map<string, Val>();
  for (const id of ids) {
    const b: Val = B.has(id) ? B.get(id) : ABSENT;
    const m: Val = M.has(id) ? M.get(id) : ABSENT;
    const r: Val = R.has(id) ? R.get(id) : ABSENT;
    if (eq(m, r) || eq(b, r)) content.set(id, m);
    else if (eq(b, m)) content.set(id, r);
    else {
      const cid = `${field}#${id}`;
      conflicts.push({ id: cid, field, kind: 'block', blockId: id, base: shown(b), main: shown(m), branch: shown(r) });
      content.set(id, resolutions[cid] === 'branch' ? r : m);
    }
  }
  // Order: of the blocks every side still has.
  const common = new Set(ids.filter((id) => B.has(id) && M.has(id) && R.has(id)));
  const baseOrder = orderOf(base.list, common);
  const mainOrder = orderOf(main.list, common);
  const branchOrder = orderOf(branch.list, common);
  const mainMoved = !sameOrder(baseOrder, mainOrder);
  const branchMoved = !sameOrder(baseOrder, branchOrder);
  let skeletonSide: Side = branchMoved && !mainMoved ? 'branch' : 'main';
  if (mainMoved && branchMoved && !sameOrder(mainOrder, branchOrder)) {
    const cid = `${field}#order`;
    conflicts.push({ id: cid, field, kind: 'order', blockId: null, base: baseOrder, main: mainOrder, branch: branchOrder });
    skeletonSide = resolutions[cid] === 'branch' ? 'branch' : 'main';
  }
  const skeleton = skeletonSide === 'branch' ? branch.list : main.list;
  const other = skeletonSide === 'branch' ? main.list : branch.list;
  const seq = skeleton.map((b) => b.id);
  // Blocks the other side added go after the block they follow there.
  let prev: string | null = null;
  for (const b of other) {
    if (!seq.includes(b.id) && !B.has(b.id)) {
      const at = prev === null ? 0 : seq.indexOf(prev) + 1;
      seq.splice(at, 0, b.id);
    }
    if (seq.includes(b.id)) prev = b.id;
  }
  const merged: Block[] = seq.filter((id) => content.get(id) !== ABSENT && content.has(id)).map((id) => ({ id, value: content.get(id) }));
  const result = joinBlocks(merged, kind, main.separator || branch.separator);
  // Byte for byte one side's value when the merge comes to it.
  if (same(merged, main.list)) return mainRaw;
  if (same(merged, branch.list)) return branchRaw;
  return result;
}

/**
 * Three-way merge of `branch` into `main` against their common `base`. `resolutions` chooses a side per conflict id.
 */
export function threeWayMerge(
  base: Data,
  main: Data,
  branch: Data,
  blockFields: ReadonlyMap<string, BlockFieldKind>,
  resolutions: Resolutions = {},
): MergeOutcome {
  const keys = [...new Set([...Object.keys(base), ...Object.keys(main), ...Object.keys(branch)])].sort();
  const data: Data = {};
  const conflicts: MergeConflict[] = [];
  const fromBranch: string[] = [];
  const fromMain: string[] = [];
  for (const field of keys) {
    const b = pick(base, field);
    const m = pick(main, field);
    const r = pick(branch, field);
    let out: Val;
    if (eq(m, r)) out = m;
    else if (eq(b, r)) {
      out = m;
      fromMain.push(field);
    } else if (eq(b, m)) {
      out = r;
      fromBranch.push(field);
    } else {
      const kind = blockFields.get(field);
      const bb = kind ? blocksOf(shown(b), kind) : null;
      const mb = kind && m !== ABSENT ? blocksOf(m, kind) : null;
      const rb = kind && r !== ABSENT ? blocksOf(r, kind) : null;
      if (kind && bb && mb && rb) {
        out = mergeBlocks(field, kind, bb, mb, rb, m, r, resolutions, conflicts);
        fromMain.push(field);
        fromBranch.push(field);
      } else {
        conflicts.push({ id: field, field, kind: 'field', blockId: null, base: shown(b), main: shown(m), branch: shown(r) });
        out = resolutions[field] === 'branch' ? r : m;
      }
    }
    if (out !== ABSENT) data[field] = out;
  }
  const unresolved = conflicts.filter((c) => resolutions[c.id] !== 'main' && resolutions[c.id] !== 'branch');
  return { data, conflicts, unresolved, fromBranch, fromMain };
}
