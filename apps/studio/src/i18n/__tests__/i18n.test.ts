// @vitest-environment jsdom
import i18n from 'i18next';
import { describe, expect, it } from 'vitest';
import { initStudioI18n, pickLanguage, setStudioLanguage, studioResources } from '..';

describe('pickLanguage (ADR-0019 §6)', () => {
  it('follows the browser: en-US → English, zh-TW and zh-CN → simplified Chinese', () => {
    expect(pickLanguage(null, ['en-US'])).toBe('en');
    expect(pickLanguage(null, ['zh-TW'])).toBe('zh-CN');
    expect(pickLanguage(null, ['zh-CN', 'en'])).toBe('zh-CN');
  });

  it('a saved choice wins over the browser; other languages fall back to English', () => {
    expect(pickLanguage('en', ['zh-CN'])).toBe('en');
    expect(pickLanguage('zh-CN', ['en-US'])).toBe('zh-CN');
    expect(pickLanguage(undefined, ['fr-FR', 'de'])).toBe('en');
    expect(pickLanguage(null, [])).toBe('en');
  });
});

describe('bundled namespaces', () => {
  it('both languages carry the same namespaces', async () => {
    const [zh, en] = await Promise.all([studioResources('zh-CN'), studioResources('en')]);
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    expect(Object.keys(en)).toContain('shell');
  });

  it('switching the language changes the strings and the document language', async () => {
    const instance = i18n.createInstance();
    await initStudioI18n(instance);
    await setStudioLanguage('zh-CN', instance);
    expect(instance.t('shell:modules.audit')).toBe('审计');
    expect(document.documentElement.lang).toBe('zh-CN');
    await setStudioLanguage('en', instance);
    expect(instance.t('shell:modules.audit')).toBe('Audit');
  });
});
