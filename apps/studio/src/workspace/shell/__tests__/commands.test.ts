// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import en from '@/i18n/en/nav.json';
import zh from '@/i18n/zh-CN/nav.json';
import { ADVANCED_NAV } from '../../routes';
import { ADVANCED_VIEWS, availableCommands } from '../commands';

/** The ⌘K palette (spec studio/workspace-shell 命令面板): every view one may enter, nothing one may not. */
const label = (dict: unknown, key: string) => key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], dict);

describe('palette commands', () => {
  const all = availableCommands(true, () => true);

  it('offer every view of Settings › Advanced, as the panel lists them', () => {
    expect([...ADVANCED_VIEWS]).toEqual(ADVANCED_NAV);
    for (const view of ADVANCED_NAV) expect(all.some((c) => c.to === `/settings/advanced/${view}`)).toBe(true);
  });

  it('reach the views the audit found missing', () => {
    const to = all.map((c) => c.to);
    for (const path of ['/content/collections', '/content/translation-memory', '/sites/list', '/seo/canonical', '/seo/content', '/monitoring/activity', '/monitoring/agents', '/settings/license']) expect(to).toContain(path);
  });

  it('do not show administrators’ views to others', () => {
    const member = availableCommands(false, () => true).map((c) => c.to);
    for (const path of ['/settings/general', '/settings/members', '/settings/api-keys', '/settings/license', '/settings/advanced/access', '/monitoring/activity']) expect(member).not.toContain(path);
    expect(member).toContain('/settings/appearance');
  });

  it('have a label in both languages', () => {
    for (const c of all.filter((x) => x.label.startsWith('nav:'))) {
      const key = c.label.slice('nav:'.length);
      expect(label(en, key), key).toEqual(expect.any(String));
      expect(label(zh, key), key).toEqual(expect.any(String));
    }
  });
});
