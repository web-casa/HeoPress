import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { createThemeEngine, renderTemplate, type ThemeAsset } from '../src/theme/engine.ts';
import { postprocess } from '../src/theme/postprocess.ts';
import { sampleSystemContent, sampleViewModels } from '../src/theme/samples.ts';
import { STARTER_THEMES } from '../src/theme/starters.ts';

const ORIGIN = 'http://starter.test';
const axeSource = createRequire(import.meta.url).resolve('axe-core/axe.min.js');

for (const theme of Object.values(STARTER_THEMES)) {
  const css = theme.assets[0]!;
  const asset: ThemeAsset = { path: css.path, contentType: css.contentType, size: Buffer.byteLength(css.text), sha256: createHash('sha256').update(css.text).digest('hex') };
  const engine = createThemeEngine(theme.templates, { id: theme.name, assets: [asset] });

  // A long unbroken word in titles and the site name: it must wrap, not widen the page.
  const LONG = 'Supercalifragilisticexpialidocious'.repeat(4);
  const pages = Object.entries(sampleViewModels()).map(([type, vm]) => {
    const long = structuredClone(vm);
    long.site.name = `${long.site.name} ${LONG}`;
    long.list = long.list.map((c) => ({ ...c, title: `${c.title} ${LONG}` }));
    if (long.item) long.item.title = `${long.item.title} ${LONG}`;
    return [type, long] as const;
  });
  for (const [type, vm] of pages) {
    test(`${theme.name} / ${type}: fits the screen, no accessibility finding`, async ({ page }, info) => {
      const out = await renderTemplate(engine, type, vm);
      const html = postprocess(out.html, out.slots, vm, sampleSystemContent(true));
      await page.route(`${ORIGIN}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === `/_theme/${theme.name}/${asset.sha256}.css`) return route.fulfill({ contentType: 'text/css', body: css.text });
        if (path === '/page') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
        return route.fulfill({ status: 404, body: '' });
      });
      // Links and images of the sample data point elsewhere: never fetched.
      await page.route(/^https?:\/\/(?!starter\.test)/, (route) => route.abort());
      await page.goto(`${ORIGIN}/page`);
      // The stylesheet applied (its custom properties are on :root).
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--measure').trim())).not.toBe('');

      // Links are not told apart by colour alone (WCAG 1.4.1): links in content and in lists are underlined.
      // (The site name in the header is a heading-like logo link, outside any text block.)
      const linksWithoutUnderline = await page.evaluate(() =>
        [...document.querySelectorAll('main a[href], footer a[href]')]
          .filter((a) => !getComputedStyle(a).textDecorationLine.includes('underline'))
          .map((a) => a.outerHTML.slice(0, 80)),
      );
      expect(linksWithoutUnderline).toEqual([]);
      // Every theme shows its site navigation.
      await expect(page.locator('nav.site-nav')).toBeVisible();

      await page.screenshot({ path: info.outputPath(`${theme.name}-${type}.png`), fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'horizontal overflow (px)').toBeLessThanOrEqual(0);

      await page.addScriptTag({ path: axeSource });
      const violations = await page.evaluate(async () => {
        const axe = (window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: Array<{ id: string; impact: string | null; nodes: Array<{ target: unknown }> }> }> } }).axe;
        const result = await axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
        return result.violations.map((v) => ({ id: v.id, impact: v.impact, targets: v.nodes.map((n) => n.target) }));
      });
      expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
    });
  }
}
