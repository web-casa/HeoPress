/**
 * The mechanical gates of the two-model translation service (HeoPress v1.4, spec ai/dual-model-translation
 * "机械门禁"): each gate, and the documented heuristic boundaries (numbers, short segments, cross-script text).
 */
import { describe, expect, it } from 'vitest';
import { gateFindings, sameLocale, scriptOf } from '../translation-gates';

const en2zh = { sourceLocale: 'en', targetLocale: 'zh-CN' };
const codes = (source: string, target: string, ctx = en2zh, glossary?: Array<{ source: string; target: string }>) =>
  gateFindings(source, target, { ...ctx, glossary }).map((finding) => finding.code);

describe('mechanical gates', () => {
  it('flags an empty target before anything else', () => {
    expect(codes('Hello world', '   ')).toEqual(['empty']);
  });

  it('flags a same-locale request', () => {
    expect(codes('Hello world', 'Hello world', { sourceLocale: 'en', targetLocale: 'en-US' })).not.toContain('same_locale');
    expect(codes('Hello world', 'Hello world', { sourceLocale: 'en', targetLocale: 'EN' })).toContain('same_locale');
  });

  it('flags a substantial segment copied verbatim, but not a lone brand name', () => {
    expect(codes('Hello, this is a sentence.', 'Hello, this is a sentence.')).toContain('identical');
    // Fewer than two words and fewer than twelve letters: a brand name may legitimately stay as-is.
    expect(codes('HeoPress', 'HeoPress')).toEqual([]);
  });

  it('flags cross-script output with no target-script character, and accepts translated text', () => {
    expect(codes('Hello, this is a sentence.', 'Hello, this is a sentence.')).toContain('untranslated');
    expect(codes('Hello, this is a sentence.', '你好，这是一句话。')).toEqual([]);
    // Same-script pairs are not judged by script: only the identity check applies.
    expect(codes('Hello, this is a sentence.', 'Hallo, das ist ein Satz.', { sourceLocale: 'en', targetLocale: 'de' })).toEqual([]);
  });

  it('requires placeholders exactly', () => {
    expect(codes('Hello ⟦P0⟧ and ⟦T1⟧', '你好 ⟦P0⟧')).toEqual(['placeholder_missing']);
    expect(codes('Hello ⟦P0⟧', '你好 ⟦P0⟧ ⟦P1⟧')).toEqual(['placeholder_added']);
    expect(codes('Hello ⟦P0⟧', '你好 ⟦P0⟧')).toEqual([]);
  });

  it('requires HTML tags exactly', () => {
    expect(codes('Hello <b>world</b>', '你好 世界')).toEqual(['html_missing', 'html_missing']);
    expect(codes('Hello <b>world</b>', '你好 <b>世界</b>')).toEqual([]);
    expect(codes('Hello world', '你好 <b>世界</b>')).toEqual(['html_added', 'html_added']);
  });

  it('requires URLs exactly', () => {
    expect(codes('See https://example.com/a?b=1 for details.', '请看 https://example.com/a 了解详情。')).toEqual(['url_missing', 'url_added']);
    expect(codes('See https://example.com/a?b=1 for details.', '请看 https://example.com/a?b=1 了解详情。')).toEqual([]);
  });

  it('requires the source numbers, ignoring separators', () => {
    expect(codes('There are 2024 items.', '有 2025 项。')).toEqual(['number_missing']);
    expect(codes('There are 1,000 items.', '有 1.000 项。')).toEqual([]);
    expect(codes('Version 3.5 is out.', '版本 35 已发布。')).toEqual([]); // documented: digit sequences only
  });

  it('requires glossary renderings when the source term occurs', () => {
    const glossary = [{ source: 'HeoPress', target: '禾普' }];
    expect(codes('HeoPress is a CMS.', '禾普是一个 CMS。', en2zh, glossary)).toEqual([]);
    expect(codes('HeoPress is a CMS.', '它是一个 CMS。', en2zh, glossary)).toEqual(['glossary_missing']);
    // The source term does not occur: the rendering is not required.
    expect(codes('A CMS.', '一个 CMS。', en2zh, glossary)).toEqual([]);
    // Whole words only for Latin terms.
    expect(codes('Concatenate the strings.', '拼接字符串。', en2zh, [{ source: 'cat', target: '猫' }])).toEqual([]);
  });

  it('exempts a pure placeholder/URL segment from the identity and untranslated checks', () => {
    expect(codes('⟦P0⟧', '⟦P0⟧')).toEqual([]);
    expect(codes('https://example.com/x', 'https://example.com/x')).toEqual([]);
  });

  it('maps locales to their writing system and normalizes locale tags', () => {
    expect(scriptOf('zh-CN')).toBe('han');
    expect(scriptOf('ja')).toBe('japanese');
    expect(scriptOf('de-CH')).toBe('latin');
    expect(scriptOf('xx')).toBe('latin');
    expect(sameLocale('zh_CN', 'zh-cn')).toBe(true);
    expect(sameLocale('en', 'en-US')).toBe(false);
  });
});
