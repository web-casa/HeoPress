import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { BlockFieldKind } from '../../block-ids';
import { blocksOf, diffData, threeWayMerge } from '../branch-merge';

/** HeoPress P10 tasks 4.1, 4.3: field- and block-level diff and the three-way merge (spec agents/content-branches). */

const html = new Map<string, BlockFieldKind>([['body', 'html']]);
const rows = new Map<string, BlockFieldKind>([['faq', 'rows']]);
const p = (id: string, text: string) => `<p data-block-id="${id}">${text}</p>`;
const doc = (...texts: string[]) => texts.map((t, i) => p(`b${i + 1}`, t)).join('\n');
const FIVE = ['one', 'two', 'three', 'four', 'five'];
const edit = (i: number, text: string) => doc(...FIVE.map((t, j) => (j === i ? text : t)));

describe('threeWayMerge — spec scenarios', () => {
  it('同一区块冲突: both changed paragraph 2 → a block conflict holding both versions; the merge has no result until a person chooses', () => {
    const base = { body: doc(...FIVE) };
    const out = threeWayMerge(base, { body: edit(1, 'two (main)') }, { body: edit(1, 'two (branch)') }, html);
    expect(out.unresolved).toEqual([{ id: 'body#b2', field: 'body', kind: 'block', blockId: 'b2', base: p('b2', 'two'), main: p('b2', 'two (main)'), branch: p('b2', 'two (branch)') }]);
    const chosen = threeWayMerge(base, { body: edit(1, 'two (main)') }, { body: edit(1, 'two (branch)') }, html, { 'body#b2': 'branch' });
    expect(chosen.unresolved).toEqual([]);
    expect(chosen.data.body).toBe(edit(1, 'two (branch)'));
  });

  it('不同区块: branch changes paragraph 2, main paragraph 5 → merged, holding both', () => {
    const out = threeWayMerge({ body: doc(...FIVE) }, { body: edit(4, 'five (main)') }, { body: edit(1, 'two (branch)') }, html);
    expect(out.conflicts).toEqual([]);
    expect(out.data.body).toBe(doc('one', 'two (branch)', 'three', 'four', 'five (main)'));
  });

  it('the same field changed on both sides → a field conflict; different fields merge', () => {
    const base = { title: 'a', slug: 's', tags: ['x'] };
    const out = threeWayMerge(base, { ...base, title: 'main', tags: ['x', 'y'] }, { ...base, title: 'branch', slug: 's2' }, new Map());
    expect(out.unresolved.map((c) => c.id)).toEqual(['title']);
    expect(out.data).toEqual({ title: 'main', slug: 's2', tags: ['x', 'y'] });
    expect(out.fromBranch).toEqual(['slug']);
    expect(out.fromMain).toEqual(['tags']);
  });

  it('blocks: an addition on each side keeps its place; a removal merges; a change against a removal conflicts', () => {
    const base = { body: doc('one', 'two', 'three') };
    const main = { body: [p('b1', 'one'), p('m1', 'main new'), p('b2', 'two'), p('b3', 'three')].join('\n') };
    const branch = { body: [p('b1', 'one'), p('b2', 'two'), p('r1', 'branch new')].join('\n') };
    const out = threeWayMerge(base, main, branch, html);
    expect(out.conflicts).toEqual([]);
    expect(out.data.body).toBe([p('b1', 'one'), p('m1', 'main new'), p('b2', 'two'), p('r1', 'branch new')].join('\n'));
    const removedChanged = threeWayMerge(base, { body: doc('one', 'two (main)', 'three') }, { body: [p('b1', 'one'), p('b3', 'three')].join('\n') }, html);
    expect(removedChanged.unresolved).toMatchObject([{ id: 'body#b2', main: p('b2', 'two (main)'), branch: null }]);
  });

  it('blocks: both reordered differently → an order conflict; one side reordering wins over none', () => {
    const base = { body: doc('one', 'two', 'three') };
    const swap12 = { body: [p('b2', 'two'), p('b1', 'one'), p('b3', 'three')].join('\n') };
    const swap23 = { body: [p('b1', 'one'), p('b3', 'three'), p('b2', 'two')].join('\n') };
    expect(threeWayMerge(base, swap12, swap23, html).unresolved.map((c) => c.id)).toEqual(['body#order']);
    const onlyBranch = threeWayMerge(base, { body: doc('one (main)', 'two', 'three') }, swap23, html);
    expect(onlyBranch.conflicts).toEqual([]);
    expect(onlyBranch.data.body).toBe([p('b1', 'one (main)'), p('b3', 'three'), p('b2', 'two')].join('\n'));
  });

  it('repeater rows merge by _blockId; html without block ids falls back to a field conflict', () => {
    const row = (id: string, q: string) => ({ _blockId: id, q });
    const out = threeWayMerge({ faq: [row('r1', 'a'), row('r2', 'b')] }, { faq: [row('r1', 'a (main)'), row('r2', 'b')] }, { faq: [row('r1', 'a'), row('r2', 'b (branch)')] }, rows);
    expect(out.data.faq).toEqual([row('r1', 'a (main)'), row('r2', 'b (branch)')]);
    expect(blocksOf('<p>no id</p>', 'html')).toBeNull();
    expect(threeWayMerge({ body: '<p>x</p>' }, { body: '<p>m</p>' }, { body: '<p>r</p>' }, html).unresolved.map((c) => c.kind)).toEqual(['field']);
  });
});

describe('diffData', () => {
  it('reports fields and, for block fields, the blocks that changed, were added, removed or moved', () => {
    const before = { title: 'a', body: doc('one', 'two', 'three') };
    const after = { title: 'b', body: [p('b3', 'three'), p('b2', 'two!'), p('n1', 'new')].join('') };
    const changes = diffData(before, after, html);
    expect(changes.map((c) => [c.field, c.kind])).toEqual([['body', 'changed'], ['title', 'changed']]);
    expect(changes[0]!.blocks).toEqual([
      { blockId: 'b1', kind: 'removed', before: p('b1', 'one') },
      { blockId: 'b2', kind: 'changed', before: p('b2', 'two'), after: p('b2', 'two!') },
      { blockId: 'n1', kind: 'added', after: p('n1', 'new') },
      { blockId: 'b3', kind: 'moved' },
    ]);
    expect(diffData(before, before, html)).toEqual([]);
  });
});

describe('threeWayMerge — properties', () => {
  const value = fc.oneof(fc.string({ maxLength: 4 }), fc.integer({ min: 0, max: 3 }), fc.constant(null));
  const data = fc.dictionary(fc.constantFrom('a', 'b', 'c', 'd'), value);
  const texts = fc.array(fc.constantFrom('x', 'y', 'z'), { minLength: 5, maxLength: 5 });

  it('an untouched side never wins: branch = base → main; main = base → branch; never a conflict', () => {
    fc.assert(
      fc.property(data, data, (base, other) => {
        const a = threeWayMerge(base, other, base, new Map());
        const b = threeWayMerge(base, base, other, new Map());
        expect(a.conflicts).toEqual([]);
        expect(b.conflicts).toEqual([]);
        expect(a.data).toEqual(other);
        expect(b.data).toEqual(other);
      }),
    );
  });

  it('nothing is overwritten silently: a field both sides changed differently is always a conflict', () => {
    fc.assert(
      fc.property(data, data, data, (base, main, branch) => {
        const out = threeWayMerge(base, main, branch, new Map());
        for (const k of new Set([...Object.keys(base), ...Object.keys(main), ...Object.keys(branch)])) {
          const [b, m, r] = [base, main, branch].map((d) => JSON.stringify(k in d ? d[k] : '∅'));
          const both = b !== m && b !== r && m !== r;
          expect(out.unresolved.some((c) => c.id === k)).toBe(both);
          if (!both) expect(JSON.stringify(k in out.data ? out.data[k] : '∅')).toBe(b === r ? m : r);
        }
      }),
    );
  });

  it('paragraph edits on disjoint positions merge to the combination of both', () => {
    fc.assert(
      fc.property(texts, texts, (mainTexts, branchTexts) => {
        const mixed = FIVE.map((t, i) => (i % 2 === 0 ? `${t}${mainTexts[i]}` : `${t}${branchTexts[i]}`));
        const main = doc(...FIVE.map((t, i) => (i % 2 === 0 ? mixed[i]! : t)));
        const branch = doc(...FIVE.map((t, i) => (i % 2 === 1 ? mixed[i]! : t)));
        const out = threeWayMerge({ body: doc(...FIVE) }, { body: main }, { body: branch }, html);
        expect(out.conflicts).toEqual([]);
        expect(out.data.body).toBe(doc(...mixed));
      }),
    );
  });
});
