import { createHash } from 'node:crypto';
import { parseFragment, serializeOuter } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import type { BlockFieldKind } from '../block-ids';

/**
 * Blocks of an item for translation freshness (HeoPress P05 task 5.1; design E, R7, R17): pure.
 *
 * - A block key is `<field>#<block ID>`: a rich-text field's top-level elements (`data-block-id`),
 *   a repeater's rows (`_blockId`); a whole SEO field is one pseudo block `<field>#$`.
 * - The hash is SHA-256 of a normalised form that changes with any content change, whitespace and
 *   non-breaking spaces included (R17): HTML is parsed, `data-block-id` dropped and every element's
 *   attributes sorted by name, then serialised; a row is JSON with `_blockId` dropped and keys sorted
 *   (`null` kept, `undefined` dropped); a SEO field's value likewise.
 * - Moved blocks (R7): of the blocks both in the baseline order and now, a mapped block is unmoved
 *   only when it is in every longest increasing subsequence of the current order's baseline
 *   positions; otherwise it may have moved, and goes to review.
 */

type Element = DefaultTreeAdapterMap['element'];
type Node = DefaultTreeAdapterMap['childNode'] | DefaultTreeAdapterMap['documentFragment'];

/** SEO fields treated as one block each (spec "SEO 字段纳入新鲜度"). */
const SEO_FRESHNESS_FIELDS = ['seo_title', 'seo_description', 'seo_image'] as const;

export interface ItemBlock {
  key: string;
  field: string;
  /** Position within its field. */
  order: number;
  hash: string;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

function isElement(node: { nodeName: string }): node is Element {
  return 'tagName' in node;
}

/** Strip `data-block-id` and sort attributes, recursively (in place, on a parsed copy). */
function normaliseNode(node: Node): void {
  if (isElement(node as Element)) {
    const el = node as Element;
    el.attrs = el.attrs.filter((a) => a.name !== 'data-block-id').sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  const children = (node as { childNodes?: Node[] }).childNodes;
  if (children) for (const c of children) normaliseNode(c);
  // `<template>` content lives apart.
  const content = (node as { content?: Node }).content;
  if (content) normaliseNode(content);
}

/** Stable JSON: keys sorted, `undefined` dropped, `null` kept. */
function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableJson(v === undefined ? null : v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}

export function htmlBlocks(field: string, html: unknown): ItemBlock[] {
  if (typeof html !== 'string' || !html) return [];
  const fragment = parseFragment(html);
  const out: ItemBlock[] = [];
  for (const node of fragment.childNodes) {
    if (!isElement(node)) continue;
    const id = node.attrs.find((a) => a.name === 'data-block-id')?.value;
    if (!id) continue;
    normaliseNode(node);
    out.push({ key: `${field}#${id}`, field, order: out.length, hash: sha256(serializeOuter(node)) });
  }
  return out;
}

export function rowBlocks(field: string, rows: unknown): ItemBlock[] {
  if (!Array.isArray(rows)) return [];
  const out: ItemBlock[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const { _blockId: id, ...rest } = row as Record<string, unknown>;
    if (typeof id !== 'string' || !id) continue;
    out.push({ key: `${field}#${id}`, field, order: out.length, hash: sha256(stableJson(rest)) });
  }
  return out;
}

/** Every block of an item: its block fields' blocks and the SEO pseudo blocks present. */
export function itemBlocks(data: Record<string, unknown>, blockFields: Map<string, BlockFieldKind>): ItemBlock[] {
  const out: ItemBlock[] = [];
  for (const [field, kind] of blockFields) out.push(...(kind === 'html' ? htmlBlocks(field, data[field]) : rowBlocks(field, data[field])));
  for (const field of SEO_FRESHNESS_FIELDS) {
    if (data[field] === undefined) continue;
    out.push({ key: `${field}#$`, field, order: 0, hash: sha256(stableJson(data[field])) });
  }
  return out;
}

/**
 * The mapped keys that may have moved (R7): `baseline` and `current` are a field's block keys in
 * order; a mapped key present in both is unmoved only when it lies in every longest increasing
 * subsequence of the current order's baseline positions.
 */
export function movedKeys(baseline: string[], current: string[], mapped: ReadonlySet<string>): Set<string> {
  const pos = new Map(baseline.map((k, i) => [k, i]));
  const seq = current.filter((k) => pos.has(k));
  const v = seq.map((k) => pos.get(k)!);
  const n = v.length;
  const end = new Array<number>(n).fill(1);
  const start = new Array<number>(n).fill(1);
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) if (v[j]! < v[i]!) end[i] = Math.max(end[i]!, end[j]! + 1);
  for (let i = n - 1; i >= 0; i--) for (let j = i + 1; j < n; j++) if (v[j]! > v[i]!) start[i] = Math.max(start[i]!, start[j]! + 1);
  const best = Math.max(0, ...end);
  // On some longest subsequence: end + start - 1 = best. In every one: also the only such position at its length.
  const onSome = v.map((_, i) => end[i]! + start[i]! - 1 === best);
  const perLevel = new Map<number, number>();
  for (let i = 0; i < n; i++) if (onSome[i]) perLevel.set(end[i]!, (perLevel.get(end[i]!) ?? 0) + 1);
  const moved = new Set<string>();
  for (let i = 0; i < n; i++) {
    const inEvery = onSome[i] && perLevel.get(end[i]!) === 1;
    if (!inEvery && mapped.has(seq[i]!)) moved.add(seq[i]!);
  }
  return moved;
}
