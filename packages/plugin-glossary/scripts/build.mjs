#!/usr/bin/env node
/**
 * Build the glossary plugin.
 *
 *   node scripts/build.mjs           # dist/index.js (one self-contained ES module) + the templates into the manifest
 *   node scripts/build.mjs --check   # fail when heopress-extension.json does not carry the templates/ sources
 *
 * The bundle is what the host loads (and what a signature covers): one file, no import of anything at run time. The
 * Classic and Astro sources live in templates/ and are copied into heopress-extension.json (`templates`, `components`),
 * which is the manifest an install or the marketplace reads.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'heopress-extension.json');

/** Route templates (both engines) and components: `templates/<engine>/<name>.<ext>`. */
const TEMPLATES = ['term', 'index'];
const COMPONENTS = ['tooltip'];

/** The plugin bundle as one ES module (code only; nothing written). */
export async function bundle() {
  const out = await build({
    entryPoints: [path.join(ROOT, 'src', 'index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    write: false,
    legalComments: 'none',
    logLevel: 'silent',
  });
  const code = out.outputFiles[0].text;
  if (/^\s*import\s|\bimport\s*\(|\brequire\s*\(/m.test(code)) throw new Error('the bundle imports something at run time');
  return code;
}

/** The manifest with the template and component sources of templates/. */
export async function manifest() {
  const m = JSON.parse(await readFile(MANIFEST, 'utf8'));
  const read = (engine, name) => readFile(path.join(ROOT, 'templates', engine, `${name}.${engine === 'classic' ? 'liquid' : 'astro'}`), 'utf8');
  m.templates = { classic: {}, astro: {} };
  for (const t of TEMPLATES) {
    m.templates.classic[t] = await read('classic', t);
    m.templates.astro[t] = await read('astro', t);
  }
  m.components = {};
  for (const c of COMPONENTS) m.components[c] = { classic: await read('classic', c), astro: await read('astro', c) };
  return m;
}

const serialise = (m) => `${JSON.stringify(m, null, 2)}\n`;

/** Whether heopress-extension.json is up to date with templates/. */
export async function manifestIsCurrent() {
  return (await readFile(MANIFEST, 'utf8')) === serialise(await manifest());
}

async function main() {
  if (process.argv.includes('--check')) {
    if (!(await manifestIsCurrent())) {
      console.error('heopress-extension.json is out of date with templates/: run node scripts/build.mjs');
      process.exit(1);
    }
    return;
  }
  await writeFile(MANIFEST, serialise(await manifest()));
  await mkdir(path.join(ROOT, 'dist'), { recursive: true });
  await writeFile(path.join(ROOT, 'dist', 'index.js'), await bundle());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
