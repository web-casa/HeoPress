// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, expect, it } from 'vitest';
import {
  GLOSSARY_LIMITS,
  GlossaryEntryInputSchema,
  GlossaryEntryUpdateSchema,
  GlossaryListQuerySchema,
  glossaryRuleOf,
} from '@heopress/contracts/schemas';

/**
 * The site glossary contract (HeoPress v1.4, spec `ai/site-glossary`): the three rules and their cross-field constraints,
 * canonical language tags, length limits, and the single coercion of a missing/unknown rule to `prefer`.
 */

const base = { sourceLang: 'en', targetLang: 'zh-CN', term: 'HeoPress', translation: '禾普' };

describe('GlossaryEntryInputSchema', () => {
  it('defaults a missing rule to prefer and canonicalizes the language tags', () => {
    const parsed = GlossaryEntryInputSchema.parse({ ...base, sourceLang: 'EN', targetLang: 'zh-cn' });
    expect(parsed).toMatchObject({ sourceLang: 'en', targetLang: 'zh-CN', rule: 'prefer' });
    expect(parsed.note).toBeUndefined();
  });

  it('accepts a do-not-translate term only when the translation equals the term', () => {
    expect(GlossaryEntryInputSchema.safeParse({ ...base, translation: base.term, rule: 'do-not-translate' }).success).toBe(true);
    expect(GlossaryEntryInputSchema.safeParse({ ...base, rule: 'do-not-translate' }).success).toBe(false);
  });

  it('rejects prefer and forbidden entries whose translation equals the term', () => {
    for (const rule of ['prefer', 'forbidden'] as const) {
      expect(GlossaryEntryInputSchema.safeParse({ ...base, translation: base.term, rule }).success).toBe(false);
    }
  });

  it('rejects a rule outside the three values', () => {
    expect(GlossaryEntryInputSchema.safeParse({ ...base, rule: 'sometimes' }).success).toBe(false);
  });

  it('rejects an unknown language code and the same language on both sides', () => {
    expect(GlossaryEntryInputSchema.safeParse({ ...base, sourceLang: 'en_US' }).success).toBe(false);
    expect(GlossaryEntryInputSchema.safeParse({ ...base, targetLang: 'not a tag' }).success).toBe(false);
    expect(GlossaryEntryInputSchema.safeParse({ ...base, sourceLang: 'zh-cn', targetLang: 'zh-CN' }).success).toBe(false);
  });

  it('enforces the term and translation length limits and trims the values', () => {
    expect(GlossaryEntryInputSchema.safeParse({ ...base, term: 'x'.repeat(GLOSSARY_LIMITS.termChars + 1) }).success).toBe(false);
    expect(GlossaryEntryInputSchema.safeParse({ ...base, translation: '禾'.repeat(GLOSSARY_LIMITS.translationChars + 1) }).success).toBe(
      false,
    );
    expect(GlossaryEntryInputSchema.parse({ ...base, term: '  HeoPress  ', note: '  note  ' })).toMatchObject({ term: 'HeoPress', note: 'note' });
  });

  it('rejects unknown fields instead of ignoring them', () => {
    expect(GlossaryEntryInputSchema.safeParse({ ...base, siteId: 'site_b' }).success).toBe(false);
  });
});

describe('GlossaryEntryUpdateSchema', () => {
  it('accepts one field at a time: cross-field rules are checked on the merged entry by the route', () => {
    expect(GlossaryEntryUpdateSchema.safeParse({ rule: 'do-not-translate' }).success).toBe(true);
    expect(GlossaryEntryUpdateSchema.safeParse({ note: null }).success).toBe(true);
    expect(GlossaryEntryUpdateSchema.safeParse({ rule: 'sometimes' }).success).toBe(false);
    expect(GlossaryEntryUpdateSchema.safeParse({ sourceLang: 'en_US' }).success).toBe(false);
  });
});

describe('GlossaryListQuerySchema', () => {
  it('canonicalizes the pair and coerces pagination defaults', () => {
    expect(GlossaryListQuerySchema.parse({ from: 'EN', to: 'zh-cn' })).toEqual({ from: 'en', to: 'zh-CN', limit: 50, offset: 0 });
    expect(GlossaryListQuerySchema.parse({ limit: '200', offset: '10' })).toMatchObject({ limit: 200, offset: 10 });
    expect(GlossaryListQuerySchema.safeParse({ from: 'en_US' }).success).toBe(false);
    expect(GlossaryListQuerySchema.safeParse({ limit: '201' }).success).toBe(false);
  });
});

describe('glossaryRuleOf', () => {
  it('is the only coercion of a stored or requested rule', () => {
    expect(glossaryRuleOf('prefer')).toBe('prefer');
    expect(glossaryRuleOf('forbidden')).toBe('forbidden');
    expect(glossaryRuleOf('do-not-translate')).toBe('do-not-translate');
    expect(glossaryRuleOf(undefined)).toBe('prefer');
    expect(glossaryRuleOf(null)).toBe('prefer');
    expect(glossaryRuleOf('FORBIDDEN')).toBe('prefer');
  });
});
