import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { bundle, manifestIsCurrent } from '../../scripts/build.mjs';

/** The package as it ships: the manifest carries the templates, the bundle is one module, the code imports only the SDK. */
describe('the glossary plugin package', () => {
  it('heopress-extension.json carries the sources of templates/ (run node scripts/build.mjs)', async () => {
    expect(await manifestIsCurrent()).toBe(true);
  });

  it('the bundle is one ES module with no import at run time', async () => {
    const code = await bundle();
    expect(code).toMatch(/export\s*\{[^}]*\bas default\b/);
    expect(code).not.toMatch(/^\s*import\s/m);
  });

  it('the sources import nothing but the Extension SDK and themselves', async () => {
    for (const file of ['index.ts', 'linker.ts', 'citation.ts']) {
      const src = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const m of src.matchAll(/from\s+'([^']+)'/g)) expect(m[1], file).toMatch(/^(@heopress\/extension-sdk|\.\/[a-z-]+)$/);
    }
  });

  it('declares no pre-publish hook: it never blocks a publish', async () => {
    const m = JSON.parse(await readFile(new URL('../../heopress-extension.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    expect(m.prePublishHooks).toBeUndefined();
    const src = await readFile(new URL('../index.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('definePrePublishHook');
  });
});
