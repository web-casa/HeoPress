// @vitest-environment jsdom
import { Editor } from '@tiptap/core';
import { TableKit } from '@tiptap/extension-table';
import StarterKit from '@tiptap/starter-kit';
import { afterEach, describe, expect, it } from 'vitest';
import { adoptBlockIds, BlockIds, withoutBlockIds } from '../block-ids';
import { BLOCKS, filterBlocks } from '../blocks';
import { htmlOf } from '../rich-text-editor';

let editor: Editor | null = null;
const make = (content: string) => (editor = new Editor({ extensions: [StarterKit, TableKit, BlockIds], content }));
afterEach(() => editor?.destroy());

describe('block IDs (spec content/block-identity)', () => {
  it('are kept through loading and edits', () => {
    const e = make('<h2 data-block-id="b_1">One</h2><p data-block-id="b_2">Two</p>');
    e.commands.insertContentAt(e.state.doc.content.size - 1, '!');
    expect(htmlOf(e)).toBe('<h2 data-block-id="b_1">One</h2><p data-block-id="b_2">Two!</p>');
  });

  it('given by a save are set in place, without touching the content or the undo history', () => {
    const e = make('<p data-block-id="b_1">One</p><p>New</p>');
    const before = htmlOf(e);
    expect(adoptBlockIds(e, '<p data-block-id="b_1">One</p><p data-block-id="b_9">New</p>', before)).toBe(true);
    expect(htmlOf(e)).toBe('<p data-block-id="b_1">One</p><p data-block-id="b_9">New</p>');
    expect(e.can().undo()).toBe(false);
  });

  it('are not adopted when the content differs too', () => {
    const e = make('<p>One</p>');
    expect(adoptBlockIds(e, '<p data-block-id="b_1">Other</p>', htmlOf(e))).toBe(false);
    expect(withoutBlockIds('<p data-block-id="x" class="a">t</p>')).toBe('<p class="a">t</p>');
  });

  it('an empty document is stored as nothing', () => {
    expect(htmlOf(make(''))).toBe('');
  });
});

describe('the "/" menu', () => {
  const label = (b: { id: string }) => ({ h2: 'Heading', h3: 'Subheading', table: '表格' })[b.id as 'h2'] ?? b.id;
  it('finds blocks by name, keyword or translated label, in either language', () => {
    expect(filterBlocks('head', label).map((b) => b.id)).toEqual(['h2', 'h3']);
    expect(filterBlocks('列表', label).map((b) => b.id)).toEqual(['bullet', 'ordered']);
    expect(filterBlocks('表格', label).map((b) => b.id)).toEqual(['table']);
    expect(filterBlocks('', label)).toHaveLength(BLOCKS.length);
    expect(filterBlocks('zzz', label)).toEqual([]);
  });

  it('each block turns the "/query" into the block', () => {
    for (const block of BLOCKS.filter((b) => !b.ask)) {
      const e = make('<p>/x</p>');
      block.run(e, { from: 1, to: 3 });
      expect(e.getText().includes('/x')).toBe(false);
      e.destroy();
    }
  });
});
