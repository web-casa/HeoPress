import { describe, expect, it } from 'vitest';
import {
  assignBlockIds,
  assignHtmlBlockIds,
  assignRowBlockIds,
  blockFieldsOf,
  replaceHtmlBlock,
  replaceRowBlock,
} from '../block-ids';

/**
 * Stable block IDs (HeoPress P04 task 4.1; spec content/block-identity
 * "区块稳定 ID"): a block keeps its ID when its text is edited, a copied block
 * gets a new one, and content that already has its IDs is left as sent.
 */

const ids = (html: string) => [...html.matchAll(/data-block-id="([^"]+)"/g)].map((m) => m[1]);

describe('rich text blocks', () => {
  it('gives every top-level element an ID on first save', () => {
    const out = assignHtmlBlockIds('<h2>Title</h2><p>One</p><ul><li>a</li><li>b</li></ul>');
    expect(ids(out)).toHaveLength(3);
    expect(new Set(ids(out)).size).toBe(3);
    // Nested elements (list items) are part of their block, not blocks.
    expect(out).toMatch(/<li>a<\/li>/);
  });

  it('editing a paragraph’s text keeps its ID', () => {
    const saved = assignHtmlBlockIds('<p>Hello</p><p>World</p>');
    const [first, second] = ids(saved);
    const edited = saved.replace('Hello', 'Hello, edited <strong>with</strong> markup');
    const resaved = assignHtmlBlockIds(edited);
    expect(ids(resaved)).toEqual([first, second]);
    expect(resaved).toBe(edited); // nothing to assign: stored as sent
  });

  it('a copied block gets a new ID; the original keeps its own', () => {
    const saved = assignHtmlBlockIds('<p>Hello</p><p>World</p>');
    const [first, second] = ids(saved);
    const copyPara = saved.match(/<p data-block-id="[^"]+">Hello<\/p>/)![0];
    const withCopy = saved.replace(copyPara, copyPara + copyPara);
    const resaved = assignHtmlBlockIds(withCopy);
    const after = ids(resaved);
    expect(after).toHaveLength(3);
    expect(after[0]).toBe(first);
    expect(after[1]).not.toBe(first);
    expect(after[2]).toBe(second);
  });

  it('is idempotent', () => {
    const once = assignHtmlBlockIds('<p>a</p>text<p>b</p>');
    expect(assignHtmlBlockIds(once)).toBe(once);
  });
});

describe('repeater rows', () => {
  it('assigns, keeps and de-duplicates row IDs', () => {
    const saved = assignRowBlockIds([{ q: 'a' }, { q: 'b' }]) as Array<Record<string, unknown>>;
    const [a, b] = saved.map((r) => r._blockId);
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
    const edited = [{ ...saved[0], q: 'a, edited' }, saved[1], { ...saved[1] }];
    const resaved = assignRowBlockIds(edited) as Array<Record<string, unknown>>;
    expect(resaved[0]!._blockId).toBe(a);
    expect(resaved[1]!._blockId).toBe(b);
    expect(resaved[2]!._blockId).not.toBe(b);
  });
});

describe('fields', () => {
  it('only wysiwyg and repeater fields hold blocks; other fields are untouched', () => {
    const fields = blockFieldsOf([
      { name: 'body', interface: 'wysiwyg' },
      { name: 'faq', interface: 'repeater' },
      { name: 'title', interface: 'input' },
    ]);
    const data = { title: '<p>not a block</p>', body: '<p>x</p>', faq: [{ q: 'y' }] };
    const out = assignBlockIds(data, fields);
    expect(out.title).toBe('<p>not a block</p>');
    expect(ids(out.body as string)).toHaveLength(1);
    expect((out.faq as Array<Record<string, unknown>>)[0]!._blockId).toBeTruthy();
    expect(assignBlockIds(out, fields)).toBe(out);
  });
});

describe('replacing one block (task 4.2)', () => {
  it('rich text: only the target changes, every other block is byte-identical', () => {
    const saved = assignHtmlBlockIds('<p>One</p><p>Two <em>x</em></p><p>Three</p>');
    const [, target] = ids(saved);
    const out = replaceHtmlBlock(saved, target!, '<p>Two, rewritten</p>');
    expect(ids(out)).toEqual(ids(saved));
    expect(out).toContain(`<p data-block-id="${target}">Two, rewritten</p>`);
    expect(out.replace(/<p data-block-id="[^"]+">Two, rewritten<\/p>/, '')).toBe(
      saved.replace(/<p data-block-id="[^"]+">Two <em>x<\/em><\/p>/, ''),
    );
  });

  it('rejects an unknown ID, a duplicated ID, more than one element and a foreign ID', () => {
    const saved = assignHtmlBlockIds('<p>One</p><p>Two</p>');
    const [a, b] = ids(saved);
    expect(() => replaceHtmlBlock(saved, 'b_missing', '<p>x</p>')).toThrow(expect.objectContaining({ code: 'BLOCK_NOT_FOUND' }));
    const dup = `<p data-block-id="${a}">1</p><p data-block-id="${a}">2</p>`;
    expect(() => replaceHtmlBlock(dup, a!, '<p>x</p>')).toThrow(expect.objectContaining({ code: 'DUPLICATE_BLOCK_ID' }));
    expect(() => replaceHtmlBlock(saved, a!, '<p>x</p><p>y</p>')).toThrow(expect.objectContaining({ code: 'INVALID_BLOCK' }));
    expect(() => replaceHtmlBlock(saved, a!, `<p data-block-id="${b}">x</p>`)).toThrow(
      expect.objectContaining({ code: 'DUPLICATE_BLOCK_ID' }),
    );
  });

  it('repeater: replaces the row, keeps its ID', () => {
    const saved = assignRowBlockIds([{ q: 'a' }, { q: 'b' }]) as Array<Record<string, unknown>>;
    const out = replaceRowBlock(saved, saved[1]!._blockId as string, { q: 'b2' }) as Array<Record<string, unknown>>;
    expect(out[0]).toBe(saved[0]);
    expect(out[1]).toEqual({ q: 'b2', _blockId: saved[1]!._blockId });
  });

  it('leaves untouched blocks byte for byte, however they are written (Codex review P04-1, #12)', () => {
    const odd = `<P DATA-BLOCK-ID="b_a" title='x'>&#65;</P><p data-block-id=b_b class=k>B&amp;b</p><div>no id <br></div>`;
    const assigned = assignHtmlBlockIds(odd);
    // Only an attribute was inserted into the third block.
    expect(assigned.startsWith(`<P DATA-BLOCK-ID="b_a" title='x'>&#65;</P><p data-block-id=b_b class=k>B&amp;b</p><div data-block-id="`)).toBe(true);
    expect(assigned.endsWith(`">no id <br></div>`)).toBe(true);
    const third = ids(assigned)[0]!;
    const replaced = replaceHtmlBlock(assigned, 'b_b', '<p>new</p>');
    expect(replaced).toBe(
      `<P DATA-BLOCK-ID="b_a" title='x'>&#65;</P><p data-block-id="b_b">new</p><div data-block-id="${third}">no id <br></div>`,
    );
  });

  it('rewrites only the attribute of a repeated ID', () => {
    const html = `<p data-block-id="b_d" class='q'>1</p><p class='q' data-block-id="b_d">2</p>`;
    const out = assignHtmlBlockIds(html);
    expect(out.startsWith(`<p data-block-id="b_d" class='q'>1</p><p class='q' data-block-id="b_`)).toBe(true);
    expect(out.endsWith(`">2</p>`)).toBe(true);
    expect(ids(out)[1]).not.toBe('b_d');
  });
});
