import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createThemeEngine, renderTemplate, type ThemeAsset } from '../theme/engine.ts';
import { postprocess } from '../theme/postprocess.ts';
import { sampleSystemContent, sampleViewModels } from '../theme/samples.ts';
import { runThemeChecks } from '../theme/smoke.ts';
import { STARTER_THEMES } from '../theme/starters.ts';

/** The starter themes (HeoPress P06 task 5.1): ordinary themes that pass every publication check. */

const manifest = (assets: Array<{ path: string; contentType: string; text: string }>): ThemeAsset[] =>
  assets.map((a) => ({ path: a.path, contentType: a.contentType, size: Buffer.byteLength(a.text), sha256: createHash('sha256').update(a.text).digest('hex') }));

describe('starter themes', () => {
  for (const theme of Object.values(STARTER_THEMES)) {
    it(`${theme.name}: passes the static checks and the smoke renders, with explicit disclosure on and off`, async () => {
      const result = await runThemeChecks(theme.templates, manifest(theme.assets), `starter-${theme.name}`);
      expect(result.issues).toEqual([]);
      expect(result).toMatchObject({ ok: true, disclosureOk: true });
    });

    it(`${theme.name}: every page type renders with a skip link, landmarks, its stylesheet and a labelled search`, async () => {
      const assets = manifest(theme.assets);
      const engine = createThemeEngine(theme.templates, { id: 'v1', assets });
      for (const [type, vm] of Object.entries(sampleViewModels())) {
        const out = await renderTemplate(engine, type, vm);
        const html = postprocess(out.html, out.slots, vm, sampleSystemContent(true));
        expect(html, type).toMatch(/^<!DOCTYPE html><html lang="en">/);
        expect(html, type).toContain('<a class="skip" href="#main">');
        expect(html, type).toContain('<main id="main"');
        expect(html, type).toContain(`href="/_theme/v1/${assets[0]!.sha256}.css"`);
        expect(html, type).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
        if (type === 'search') expect(html).toContain('<label for="q">Search terms</label><input id="q" type="search" name="q"');
      }
    });
  }
});
