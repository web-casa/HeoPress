import type { Editor, Range } from '@tiptap/core';

/**
 * The blocks the "/" menu inserts (ADR-0020). `label` and `hint` are keys of the `editor` namespace (`blocks.*`);
 * `keywords` match what a person may type after "/" in either language.
 */
export interface BlockItem {
  id: string;
  keywords: string;
  /** Inserts the block in place of the "/query" text. `ask` opens a small form first (image, link). */
  run: (editor: Editor, range: Range) => void;
  ask?: 'image';
}

export const BLOCKS: readonly BlockItem[] = [
  { id: 'text', keywords: 'text paragraph 正文 段落', run: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  { id: 'h2', keywords: 'heading h2 title 标题 二级', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 2 }).run() },
  { id: 'h3', keywords: 'heading h3 subtitle 标题 三级', run: (e, r) => e.chain().focus().deleteRange(r).setHeading({ level: 3 }).run() },
  { id: 'bullet', keywords: 'bullet list ul 列表 无序', run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { id: 'ordered', keywords: 'numbered ordered list ol 列表 有序 编号', run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { id: 'quote', keywords: 'quote blockquote 引用', run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { id: 'code', keywords: 'code block pre 代码', run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  { id: 'divider', keywords: 'divider hr rule line 分隔线 分割', run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
  { id: 'table', keywords: 'table grid 表格', run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: 'image', keywords: 'image picture photo img 图片 图像', ask: 'image', run: (e, r) => e.chain().focus().deleteRange(r).run() },
];

/** The blocks whose id, keywords or translated label contain the query (case-insensitive). */
export function filterBlocks(query: string, label: (b: BlockItem) => string, blocks: readonly BlockItem[] = BLOCKS): BlockItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...blocks];
  return blocks.filter((b) => `${b.id} ${b.keywords} ${label(b)}`.toLowerCase().includes(q));
}
