import { describe, expect, it } from 'vitest';
import { BUILTIN_THEME } from '../theme/builtin.ts';
import { runThemeChecks, THEME_CHECKS_VERSION } from '../theme/smoke.ts';

/** Pre-publication checks (HeoPress P06 tasks 2.4, 2.7): static checks, then smoke rendering, disclosure off and on. */
describe('runThemeChecks', () => {
  const top = BUILTIN_THEME['partials/top']!;
  it('the built-in theme passes with disclosure off and on', async () => {
    expect(await runThemeChecks(BUILTIN_THEME)).toEqual({ validator: THEME_CHECKS_VERSION, ok: true, disclosureOk: true, issues: [] });
  });

  it('a theme without disclosure slots is publishable only while disclosure is off, and the missing slot is named', async () => {
    const slotless = {
      ...BUILTIN_THEME,
      item: "{% include 'partials/top' %}<h1>{{ item.title }}</h1>{% item_body %}{% include 'partials/bottom' %}",
      'partials/list': '{% for c in list %}{% card c %}<a href="{{ c.url | url }}">{{ c.title }}</a>{% endcard %}{% endfor %}',
    };
    const r = await runThemeChecks(slotless);
    expect(r).toMatchObject({ ok: true, disclosureOk: false });
    expect(r.issues.map((i) => `${i.template}: ${i.message}`)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^item: with sponsor disclosure on: .*sponsor_disclosure item/), expect.stringMatching(/^home: with sponsor disclosure on: sponsored card two/)]),
    );
  });

  it('spec "含语法错误的主题发布被拒绝": a syntax error or a runtime failure on the samples fails the version', async () => {
    expect((await runThemeChecks({ ...BUILTIN_THEME, home: '{% if %}' })).ok).toBe(false);
    // Passes the static checks but fails when rendered (a link to a sponsored card outside it).
    const r = await runThemeChecks({ ...BUILTIN_THEME, 'partials/list': '{% for c in list %}<a href="{{ c.url | url }}">{{ c.title }}</a>{% endfor %}' });
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /outside its/.test(i.message))).toBe(true);
  });

  it('assets: referenced ones must exist in the version', async () => {
    const withCss = { ...BUILTIN_THEME, 'partials/top': top.replace('{% seo_head %}', "{% seo_head %}<link rel=\"stylesheet\" href=\"{{ 'css/a.css' | asset_url }}\">") };
    expect((await runThemeChecks(withCss)).ok).toBe(false);
    expect((await runThemeChecks(withCss, [{ path: 'css/a.css', sha256: 'a'.repeat(64), contentType: 'text/css', size: 1 }])).ok).toBe(true);
  });
});
