import { Extension, type Editor } from '@tiptap/core';

/**
 * Stable block IDs (spec content/block-identity): the server gives every top-level element of rich text a
 * `data-block-id` and keeps it through edits, so the editor must carry it in and out unchanged. A copied block
 * (Enter splitting a paragraph) carries the ID along; the server gives the copy a new one on save.
 */
const BLOCK_TYPES = ['paragraph', 'heading', 'blockquote', 'bulletList', 'orderedList', 'codeBlock', 'horizontalRule', 'table', 'image', 'video'];

export const BlockIds = Extension.create({
  name: 'blockIds',
  addGlobalAttributes() {
    return [
      {
        types: BLOCK_TYPES,
        attributes: {
          blockId: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-block-id'),
            renderHTML: (attributes) => (attributes.blockId ? { 'data-block-id': attributes.blockId as string } : {}),
          },
        },
      },
    ];
  },
});

/** The HTML without block IDs: what a person sees and edits. */
export function withoutBlockIds(html: string): string {
  return html.replace(/\sdata-block-id="[^"]*"/g, '');
}

/**
 * When a saved value differs from the editor only by block IDs (the server just gave new blocks theirs), sets the
 * IDs in place — the content, the caret and the undo history stay as they are. False when more than IDs differ.
 */
export function adoptBlockIds(editor: Editor, html: string, current: string): boolean {
  if (withoutBlockIds(html) !== withoutBlockIds(current)) return false;
  const ids = [...new DOMParser().parseFromString(html, 'text/html').body.children].map((el) => el.getAttribute('data-block-id'));
  const { tr, doc } = editor.state;
  if (ids.length !== doc.childCount) return false;
  doc.forEach((node, offset, index) => {
    const id = ids[index] ?? null;
    if ('blockId' in node.attrs && node.attrs.blockId !== id) tr.setNodeAttribute(offset, 'blockId', id);
  });
  if (tr.docChanged) editor.view.dispatch(tr.setMeta('addToHistory', false).setMeta('blockIds', true));
  return true;
}
