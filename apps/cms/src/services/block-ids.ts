/**
 * Stable block IDs (HeoPress P04, spec content/block-identity).
 *
 * Two kinds of field hold blocks:
 *
 *   - rich text (`wysiwyg` interface, HTML): each top-level element is a
 *     block and carries `data-block-id`;
 *   - repeaters (`repeater` interface, an array of objects): each row is a
 *     block and carries `_blockId`.
 *
 * On every save a block without an ID gets a new one, and an ID that occurs
 * more than once keeps it only at its first occurrence — the later copies get
 * new IDs. That is what makes a copied block distinct: editors (and a browser
 * splitting a paragraph on Enter) copy the attribute along with the element.
 * Edits leave the ID alone. Text at the top level of rich text that is not
 * inside an element is not a block and has no ID.
 *
 * Rich text is edited in place by source offsets: assigning an ID inserts
 * (or rewrites) just that attribute, and replacing a block swaps just that
 * element's source. Everything else is kept byte for byte as sent.
 */
import { nanoid } from 'nanoid';
import { parseFragment, serialize, serializeOuter } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';

const BLOCK_ID_ATTR = 'data-block-id';
const ROW_BLOCK_ID = '_blockId';

type Element = DefaultTreeAdapterMap['element'];
type ChildNode = DefaultTreeAdapterMap['childNode'];

export type BlockFieldKind = 'html' | 'rows';

/** Which fields of a collection hold blocks, by name. */
export function blockFieldsOf(fields: ReadonlyArray<{ name: string; interface?: string | null }>): Map<string, BlockFieldKind> {
  const out = new Map<string, BlockFieldKind>();
  for (const f of fields) {
    if (f.interface === 'wysiwyg') out.set(f.name, 'html');
    else if (f.interface === 'repeater') out.set(f.name, 'rows');
  }
  return out;
}

const newBlockId = (): string => `b_${nanoid(10)}`;

function isElement(node: ChildNode): node is Element {
  return 'tagName' in node;
}

function attrOf(el: Element, name: string): string | undefined {
  return el.attrs.find((a) => a.name === name)?.value;
}

function setAttr(el: Element, name: string, value: string): void {
  const existing = el.attrs.find((a) => a.name === name);
  if (existing) existing.value = value;
  else el.attrs.push({ name, value });
}

/** Top-level elements of an HTML fragment, in order, with source offsets. */
function topLevel(html: string): { fragment: DefaultTreeAdapterMap['documentFragment']; blocks: Element[] } {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true });
  return { fragment, blocks: fragment.childNodes.filter(isElement) };
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Apply non-overlapping source edits (any order). */
function applyEdits(source: string, edits: Edit[]): string {
  let out = source;
  for (const e of [...edits].sort((a, b) => b.start - a.start)) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

const attrText = (id: string) => `${BLOCK_ID_ATTR}="${id}"`;

/** Give every top-level element a unique `data-block-id` (see the module comment). */
export function assignHtmlBlockIds(html: string): string {
  if (!html) return html;
  const { fragment, blocks } = topLevel(html);
  const seen = new Set<string>();
  const edits: Edit[] = [];
  let located = true;
  for (const el of blocks) {
    const id = attrOf(el, BLOCK_ID_ATTR);
    if (id && !seen.has(id)) {
      seen.add(id);
      continue;
    }
    const fresh = newBlockId();
    seen.add(fresh);
    setAttr(el, BLOCK_ID_ATTR, fresh);
    const loc = el.sourceCodeLocation;
    const attrLoc = loc?.attrs?.[BLOCK_ID_ATTR];
    if (id !== undefined && attrLoc) {
      // A repeated (or empty) ID: rewrite just that attribute.
      edits.push({ start: attrLoc.startOffset, end: attrLoc.endOffset, text: attrText(fresh) });
    } else if (loc?.startTag) {
      // Insert right after `<tagname`.
      const at = loc.startTag.startOffset + 1 + el.tagName.length;
      edits.push({ start: at, end: at, text: ` ${attrText(fresh)}` });
    } else {
      located = false;
    }
  }
  if (edits.length === 0 && located) return html;
  // Without source locations (not expected from parse5) fall back to re-serialising.
  return located ? applyEdits(html, edits) : serialize(fragment);
}

/** Give every row object a unique `_blockId`. Non-object rows are left as they are. */
export function assignRowBlockIds(rows: unknown[]): unknown[] {
  const seen = new Set<string>();
  let changed = false;
  const out = rows.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    const id = (row as Record<string, unknown>)[ROW_BLOCK_ID];
    if (typeof id === 'string' && id && !seen.has(id)) {
      seen.add(id);
      return row;
    }
    const fresh = newBlockId();
    seen.add(fresh);
    changed = true;
    return { ...(row as Record<string, unknown>), [ROW_BLOCK_ID]: fresh };
  });
  return changed ? out : rows;
}

/**
 * Assign block IDs in every block field present in `data`; other fields are
 * returned untouched. Returns `data` itself when nothing changed.
 */
export function assignBlockIds(
  data: Record<string, unknown>,
  blockFields: ReadonlyMap<string, BlockFieldKind>,
): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const [name, kind] of blockFields) {
    const value = data[name];
    let next: unknown = value;
    if (kind === 'html' && typeof value === 'string') next = assignHtmlBlockIds(value);
    else if (kind === 'rows' && Array.isArray(value)) next = assignRowBlockIds(value);
    if (next !== value) {
      out ??= { ...data };
      out[name] = next;
    }
  }
  return out ?? data;
}

export class BlockError extends Error {
  constructor(
    public readonly code: 'BLOCK_NOT_FOUND' | 'DUPLICATE_BLOCK_ID' | 'INVALID_BLOCK' | 'NOT_A_BLOCK_FIELD',
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'BlockError';
  }
}

/**
 * Replace the one rich-text block with `blockId` by `blockHtml` (exactly one
 * element), keeping its ID. Every other block is left byte for byte.
 */
export function replaceHtmlBlock(html: string, blockId: string, blockHtml: string): string {
  const { fragment, blocks } = topLevel(html ?? '');
  const matches = blocks.filter((el) => attrOf(el, BLOCK_ID_ATTR) === blockId);
  if (matches.length === 0) throw new BlockError('BLOCK_NOT_FOUND', `No block "${blockId}" in this field.`, 404);
  if (matches.length > 1) throw new BlockError('DUPLICATE_BLOCK_ID', `Block id "${blockId}" occurs more than once.`, 409);

  const replacement = parseFragment(blockHtml);
  const elements = replacement.childNodes.filter(isElement);
  const strayText = replacement.childNodes.some((n) => !isElement(n) && 'value' in n && String(n.value).trim() !== '');
  if (elements.length !== 1 || strayText) {
    throw new BlockError('INVALID_BLOCK', 'The new block must be exactly one element.', 400);
  }
  const [el] = elements as [Element];
  const ownId = attrOf(el, BLOCK_ID_ATTR);
  if (ownId && ownId !== blockId) {
    throw new BlockError('DUPLICATE_BLOCK_ID', 'The new block must not carry another block id.', 400);
  }
  setAttr(el, BLOCK_ID_ATTR, blockId);
  const loc = matches[0]!.sourceCodeLocation;
  if (loc) {
    // Swap just the target element's source; untouched blocks stay byte for byte.
    return applyEdits(html, [{ start: loc.startOffset, end: loc.endOffset, text: serializeOuter(el) }]);
  }
  el.parentNode = fragment;
  fragment.childNodes.splice(fragment.childNodes.indexOf(matches[0]!), 1, el);
  return serialize(fragment);
}

/** Replace the one repeater row with `blockId` by `row`, keeping its ID. */
export function replaceRowBlock(rows: unknown[], blockId: string, row: Record<string, unknown>): unknown[] {
  const indexes = rows.flatMap((r, i) =>
    r && typeof r === 'object' && (r as Record<string, unknown>)[ROW_BLOCK_ID] === blockId ? [i] : [],
  );
  if (indexes.length === 0) throw new BlockError('BLOCK_NOT_FOUND', `No block "${blockId}" in this field.`, 404);
  if (indexes.length > 1) throw new BlockError('DUPLICATE_BLOCK_ID', `Block id "${blockId}" occurs more than once.`, 409);
  const own = row[ROW_BLOCK_ID];
  if (own !== undefined && own !== blockId) {
    throw new BlockError('DUPLICATE_BLOCK_ID', 'The new block must not carry another block id.', 400);
  }
  const out = rows.slice();
  out[indexes[0]!] = { ...row, [ROW_BLOCK_ID]: blockId };
  return out;
}
