/**
 * Property: any text a two-model translation accepts passes the mechanical gates (HeoPress v1.4, spec
 * ai/dual-model-translation "一次有界修订" / "可观察的结果").
 *
 * `applyReview` is the only place that decides what is accepted, so generating arbitrary sources, drafts, reviewer
 * verdicts and revisions covers the invariant directly: a segment in state `verified` or `revised` always has an empty
 * gate result. Counts must agree with the states, and every requested id appears exactly once, in request order.
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { applyReview, type DraftSegment, type ReviewVerdict } from '../dual-model-translation';
import { gateFindings } from '../translation-gates';

const token = fc.constantFrom(
  'a',
  'b',
  ' ',
  '  ',
  '⟦P0⟧',
  '⟦T1⟧',
  '<b>',
  '</b>',
  'https://example.com/x',
  '1',
  '42',
  '2024',
  '.',
  ',',
  '你',
  '好',
  'é',
  '世界',
);
const text = fc.array(token, { maxLength: 14 }).map((parts) => parts.join(''));
const locale = fc.constantFrom('en', 'en-US', 'zh-CN', 'de', 'ja');

const scenario = fc.integer({ min: 1, max: 3 }).chain((n) =>
  fc.record({
    pairs: fc.array(fc.tuple(text, text), { minLength: n, maxLength: n }),
    revise: fc.array(fc.boolean(), { minLength: n, maxLength: n }),
    revisions: fc.array(text, { minLength: n, maxLength: n }),
    reasons: fc.array(fc.option(fc.string({ maxLength: 30 }), { nil: undefined }), { minLength: n, maxLength: n }),
    reviewRan: fc.boolean(),
    sourceLocale: locale,
    targetLocale: locale,
    glossary: fc.array(fc.record({ source: fc.string({ minLength: 1, maxLength: 6 }), target: fc.string({ minLength: 1, maxLength: 6 }) }), { maxLength: 2 }),
  }),
);

describe('two-model acceptance', () => {
  it('accepts only text that passes the mechanical gates', () => {
    fc.assert(
      fc.property(scenario, ({ pairs, revise, revisions, reasons, reviewRan, sourceLocale, targetLocale, glossary }) => {
        const source = pairs.map(([sourceText], i) => ({ id: `s${i + 1}`, text: sourceText }));
        const draft: DraftSegment[] = pairs.map(([, draftText], i) => ({ id: `s${i + 1}`, target: draftText }));
        const verdicts: ReviewVerdict[] | null = reviewRan
          ? pairs.map((_, i) => ({
              id: `s${i + 1}`,
              verdict: revise[i] ? ('revise' as const) : ('ok' as const),
              ...(revise[i] ? { revised: revisions[i]! } : {}),
              ...(reasons[i] ? { reason: reasons[i]! } : {}),
            }))
          : null;

        const out = applyReview({ source, draft, verdicts, sourceLocale, targetLocale, glossary });
        const ctx = { sourceLocale, targetLocale, glossary };

        expect(out.segments.map((segment) => segment.id)).toEqual(source.map((segment) => segment.id));
        for (const state of out.states) {
          if (state.state === 'verified' || state.state === 'revised') {
            const accepted = out.segments.find((segment) => segment.id === state.id)!;
            const sourceText = source.find((segment) => segment.id === state.id)!.text;
            expect(gateFindings(sourceText, accepted.text, ctx)).toEqual([]);
            // A verified segment has no findings; a revised one keeps the draft's defects as provenance.
            if (state.state === 'verified') expect(state.findings).toEqual([]);
          }
        }
        expect(out.revisedSegments).toBe(out.states.filter((state) => state.state === 'revised').length);
        expect(out.rejectedSegments).toBe(out.states.filter((state) => state.state === 'rejected_verification').length);
      }),
      { numRuns: 300 },
    );
  });
});
