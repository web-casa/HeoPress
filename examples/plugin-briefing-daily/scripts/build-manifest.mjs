#!/usr/bin/env node
/**
 * Build the daily-briefing plugin's manifest and bundle.
 *
 *   node scripts/build-manifest.mjs           # inline templates/ into heopress-extension.json
 *   node scripts/build-manifest.mjs --check   # fail when the manifest does not carry templates/ sources
 *
 * The manifest is what an install or the marketplace reads; the Classic (Liquid) and Astro sources live in
 * `templates/` so they can be reviewed as templates, and this script copies them into `templates` in the manifest.
 * It is the same arrangement as `packages/plugin-glossary/scripts/build.mjs`, without a bundle step: this plugin is
 * a plain `tsc` module and the host loads `dist/index.js` as shipped.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'heopress-extension.json');

/** Route templates, by their local name: `templates/<engine>/<name>.<liquid|astro>`. */
const TEMPLATES = ['briefing', 'index'];

const read = (engine, name) => readFile(path.join(ROOT, 'templates', engine, `${name}.${engine === 'classic' ? 'liquid' : 'astro'}`), 'utf8');
const serialise = (m) => `${JSON.stringify(m, null, 2)}\n`;

/** The manifest with the template sources of templates/. */
export async function manifest() {
  const m = JSON.parse(await readFile(MANIFEST, 'utf8'));
  m.templates = { classic: {}, astro: {} };
  for (const t of TEMPLATES) {
    m.templates.classic[t] = await read('classic', t);
    m.templates.astro[t] = await read('astro', t);
  }
  return m;
}

/** Whether heopress-extension.json is up to date with templates/. */
export async function manifestIsCurrent() {
  return (await readFile(MANIFEST, 'utf8')) === serialise(await manifest());
}

async function main() {
  if (process.argv.includes('--check')) {
    if (!(await manifestIsCurrent())) {
      console.error('heopress-extension.json is out of date with templates/: run node scripts/build-manifest.mjs');
      process.exit(1);
    }
    return;
  }
  await writeFile(MANIFEST, serialise(await manifest()));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
