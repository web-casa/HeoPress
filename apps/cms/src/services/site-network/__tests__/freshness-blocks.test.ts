import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { htmlBlocks, itemBlocks, movedKeys, rowBlocks } from '../freshness-blocks';

/**
 * Freshness blocks (HeoPress P05 task 5.1; design E, R7, R17): keys, normalised hashes and the
 * move judgement.
 */

const hashOf = (html: string) => htmlBlocks('body', html)[0]!.hash;

describe('block keys and hashes', () => {
  it('keys are field#blockId, in order; elements without an ID and loose text are not blocks', () => {
    const blocks = htmlBlocks('body', '<p data-block-id="a">x</p>text<p>no id</p><h2 data-block-id="b">y</h2>');
    expect(blocks.map((b) => [b.key, b.order])).toEqual([
      ['body#a', 0],
      ['body#b', 1],
    ]);
    expect(rowBlocks('faq', [{ _blockId: 'r1', q: 'a' }, 'loose', { q: 'no id' }, { _blockId: 'r2', q: 'b' }]).map((b) => b.key)).toEqual(['faq#r1', 'faq#r2']);
  });

  it('the hash ignores the block ID and attribute order, nothing else (R17)', () => {
    const base = hashOf('<p data-block-id="a" class="x" id="y">Hello <b>world</b></p>');
    expect(hashOf('<p id="y" class="x" data-block-id="zzz">Hello <b>world</b></p>')).toBe(base);
    // Any content change counts, whitespace and non-breaking spaces included.
    expect(hashOf('<p data-block-id="a" class="x" id="y">Hello  <b>world</b></p>')).not.toBe(base);
    expect(hashOf('<p data-block-id="a" class="x" id="y">Hello&nbsp;<b>world</b></p>')).not.toBe(base);
    expect(hashOf('<p data-block-id="a" class="x" id="y">Hello <b> world</b></p>')).not.toBe(base);
    const code = hashOf('<pre data-block-id="c"><code>if (x) {\n  y();\n}</code></pre>');
    expect(hashOf('<pre data-block-id="c"><code>if (x) {\n    y();\n}</code></pre>')).not.toBe(code);
  });

  it('rows hash without their block ID, keys in any order; null is kept, undefined dropped', () => {
    const [a] = rowBlocks('faq', [{ _blockId: 'r', q: 'Q', a: null }]);
    const [b] = rowBlocks('faq', [{ a: null, q: 'Q', _blockId: 'other', extra: undefined }]);
    const [c] = rowBlocks('faq', [{ _blockId: 'r', q: 'Q' }]);
    expect(a!.hash).toBe(b!.hash);
    expect(c!.hash).not.toBe(a!.hash);
  });

  it('SEO fields are one pseudo block each', () => {
    const blocks = itemBlocks({ seo_title: 'T', seo_description: 'D', title: 'not seo' }, new Map());
    expect(blocks.map((b) => b.key)).toEqual(['seo_title#$', 'seo_description#$']);
  });
});

describe('moved blocks (R7)', () => {
  it('[A,B,C] → [A,C,B] with only B mapped: B goes to review (both orders are longest)', () => {
    expect([...movedKeys(['A', 'B', 'C'], ['A', 'C', 'B'], new Set(['B']))]).toEqual(['B']);
  });

  it('a block inserted in front, or removed, moves nothing', () => {
    expect(movedKeys(['A', 'B', 'C'], ['N', 'A', 'B', 'C'], new Set(['A', 'B', 'C'])).size).toBe(0);
    expect(movedKeys(['A', 'B', 'C'], ['A', 'C'], new Set(['A', 'C'])).size).toBe(0);
  });

  it('a block taken from the end to the front: it alone moved', () => {
    expect([...movedKeys(['A', 'B', 'C', 'D'], ['D', 'A', 'B', 'C'], new Set(['A', 'B', 'C', 'D']))]).toEqual(['D']);
  });

  it('property: the same order with any blocks added moves nothing', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 1, maxLength: 3 }), { maxLength: 12 }), fc.array(fc.nat(12), { maxLength: 6 }), (keys, inserts) => {
        const current = [...keys];
        inserts.forEach((at, i) => current.splice(Math.min(at, current.length), 0, `new-${i}`));
        return movedKeys(keys, current, new Set(keys)).size === 0;
      }),
    );
  });

  it('property: a single block moved elsewhere is reported, possibly with ambiguous neighbours, and never an unmapped one', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 1, maxLength: 3 }), { minLength: 2, maxLength: 10 }), fc.nat(), fc.nat(), (keys, a, b) => {
        const from = a % keys.length;
        const to = b % keys.length;
        if (from === to) return true;
        const current = [...keys];
        const [k] = current.splice(from, 1);
        current.splice(to, 0, k!);
        const mapped = new Set(keys.filter((_, i) => i % 2 === 0));
        const moved = movedKeys(keys, current, mapped);
        for (const m of moved) if (!mapped.has(m)) return false;
        return !mapped.has(k!) || moved.has(k!);
      }),
    );
  });
});
