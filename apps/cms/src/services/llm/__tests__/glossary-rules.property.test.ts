/**
 * Properties of the three glossary rules in the mechanical gates (HeoPress v1.4, spec `ai/site-glossary`).
 *
 * `gateFindings` is the only place a rule becomes a finding, so generating arbitrary terms, renderings and translations
 * covers the contract directly:
 *
 *   - `prefer` requires the rendering exactly when the source term occurs, and never bans anything;
 *   - `forbidden` reports `glossary_forbidden` exactly when the banned rendering occurs (whether or not the source term
 *     does), and never reports it otherwise;
 *   - `do-not-translate` requires the source spelling verbatim, so an altered or translated term is `glossary_missing`;
 *   - a missing rule behaves exactly like `prefer`, and the same input always produces the same findings.
 */
import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type { GlossaryRule } from '@heopress/contracts/schemas';
import { gateFindings } from '../translation-gates';

const EN2ZH = { sourceLocale: 'en', targetLocale: 'zh-CN' } as const;
const codesOf = (source: string, target: string, glossary: Array<{ source: string; target: string; rule?: GlossaryRule }>) =>
  gateFindings(source, target, { ...EN2ZH, glossary }).map((finding) => finding.code);

const latinTerm = fc.stringMatching(/^[a-z]{3,8}$/);
/** A Han rendering disjoint from the fixed target filler (`译文`), so "contains" is exact. */
const hanRendering = fc
  .array(fc.integer({ min: 0x4e00, max: 0x5dff }), { minLength: 2, maxLength: 4 })
  .map((points) => String.fromCodePoint(...points));
const distinctRenderings = fc
  .tuple(hanRendering, hanRendering)
  .filter(([a, b]) => !a.includes(b) && !b.includes(a));

const sourceWith = (term: string) => `hello ${term} world`;
const TARGET_FILLER = '译文';

describe('glossary rules — properties', () => {
  it('prefer requires the rendering exactly when the source term occurs, and never forbids', () => {
    fc.assert(
      fc.property(latinTerm, distinctRenderings, fc.boolean(), (term, [rendering, other], usesRendering) => {
        const target = `${TARGET_FILLER}${usesRendering ? rendering : other}${TARGET_FILLER}`;
        const findings = codesOf(sourceWith(term), target, [{ source: term, target: rendering }]);
        expect(findings.includes('glossary_missing')).toBe(!usesRendering);
        expect(findings).not.toContain('glossary_forbidden');
      }),
    );
  });

  it('forbidden reports the banned rendering exactly when it appears, with or without the source term', () => {
    fc.assert(
      fc.property(latinTerm, distinctRenderings, fc.boolean(), fc.boolean(), (term, [rendering, other], banned, termInSource) => {
        const target = `${TARGET_FILLER}${banned ? rendering : other}${TARGET_FILLER}`;
        const source = termInSource ? sourceWith(term) : 'hello world';
        const findings = codesOf(source, target, [{ source: term, target: rendering, rule: 'forbidden' }]);
        expect(findings.includes('glossary_forbidden')).toBe(banned);
      }),
    );
  });

  it('do-not-translate requires the source spelling verbatim, and an altered term is missing', () => {
    fc.assert(
      fc.property(latinTerm, distinctRenderings, fc.boolean(), (term, [rendering, other], kept) => {
        // `kept` keeps the source spelling somewhere in a Han sentence; otherwise the term is translated/recased.
        const target = kept ? `${TARGET_FILLER} ${term} ${TARGET_FILLER}` : `${TARGET_FILLER}${rendering}${other}${TARGET_FILLER}`;
        const findings = codesOf(sourceWith(term), target, [{ source: term, target: term, rule: 'do-not-translate' }]);
        expect(findings.includes('glossary_missing')).toBe(!kept);
      }),
    );
  });

  it('a missing rule is exactly prefer, and the findings are deterministic', () => {
    fc.assert(
      fc.property(latinTerm, distinctRenderings, fc.boolean(), (term, [rendering, other], usesRendering) => {
        const target = `${TARGET_FILLER}${usesRendering ? rendering : other}${TARGET_FILLER}`;
        const source = sourceWith(term);
        const omitted = gateFindings(source, target, { ...EN2ZH, glossary: [{ source: term, target: rendering }] });
        const prefer = gateFindings(source, target, { ...EN2ZH, glossary: [{ source: term, target: rendering, rule: 'prefer' }] });
        expect(omitted).toEqual(prefer);
        expect(gateFindings(source, target, { ...EN2ZH, glossary: [{ source: term, target: rendering }] })).toEqual(omitted);
      }),
    );
  });
});
