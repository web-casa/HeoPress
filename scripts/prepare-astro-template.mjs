#!/usr/bin/env node
/**
 * Prepare a self-contained Astro template for sandboxed builds (HeoPress v1.5, spec rendering/astro-build-sandbox).
 *
 *   node scripts/prepare-astro-template.mjs --out /srv/heopress/astro-template [--skip-build]
 *
 * A build runs in a container with no network and a read-only root, mounting exactly one input directory. That directory
 * must therefore be *self-sufficient*: a workspace package resolves its dependencies through the monorepo's `.pnpm` store
 * and exports TypeScript source, neither of which survives a mount. This script produces what a deployment mounts:
 *
 *   1. `pnpm deploy --prod` — the package with a `.pnpm` store of its own inside the directory;
 *   2. the workspace's `tsconfig.base.json`, with the template's `extends` pointed at the local copy;
 *   3. `@heopress/contracts` built, with its `./page-data` export pointed at the compiled JavaScript, because Node inside
 *      the container cannot load the TypeScript source the workspace exports.
 *
 * The result is verified: the script refuses to leave a template whose entry points do not resolve. Set `--out` to the
 * directory `HEOPRESS_ASTRO_TEMPLATE_DIR` names.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const out = path.resolve(arg('out', ''));
if (!arg('out')) {
  console.error('prepare-astro-template: --out <directory> is required');
  process.exit(2);
}
if (fs.existsSync(out) && fs.readdirSync(out).length > 0) {
  console.error(`prepare-astro-template: ${out} is not empty; prepare into a new directory or empty it first`);
  process.exit(2);
}

const run = (command, args, cwd = ROOT) => execFileSync(command, args, { cwd, stdio: 'inherit' });

fs.mkdirSync(out, { recursive: true });
console.log(`[template] deploying @heopress/site-astro → ${out}`);
run('pnpm', ['--filter', '@heopress/site-astro', 'deploy', '--prod', out]);

// 2. The tsconfig the template extends lives at the repository root; a mount has no repository root.
const base = path.join(ROOT, 'tsconfig.base.json');
if (!fs.existsSync(base)) throw new Error(`missing ${base}`);
fs.copyFileSync(base, path.join(out, 'tsconfig.base.json'));
const tsconfigPath = path.join(out, 'tsconfig.json');
if (fs.existsSync(tsconfigPath)) {
  const text = fs.readFileSync(tsconfigPath, 'utf8').replace(/\.\.\/\.\.\/tsconfig\.base\.json/g, './tsconfig.base.json');
  fs.writeFileSync(tsconfigPath, text);
}

// 3. The contracts package: Node loads JavaScript, so the deployed copy exports its build output.
if (!process.argv.includes('--skip-build')) {
  console.log('[template] building @heopress/contracts');
  run('pnpm', ['--filter', '@heopress/contracts', 'build']);
}
const contractsSource = path.join(ROOT, 'packages/contracts');
const contractsDist = path.join(contractsSource, 'dist');
const contractsEntry = path.join(contractsDist, 'theme/page-data.js');
if (!fs.existsSync(contractsEntry)) {
  throw new Error(`missing ${contractsEntry}: run 'pnpm --filter @heopress/contracts build' first`);
}
const contractsTarget = path.join(out, 'node_modules/@heopress/contracts');
fs.mkdirSync(path.dirname(contractsTarget), { recursive: true });
fs.rmSync(contractsTarget, { recursive: true, force: true });
fs.cpSync(contractsSource, contractsTarget, { recursive: true, dereference: true });

const manifestPath = path.join(contractsTarget, 'package.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.exports = Object.fromEntries(
  Object.entries(manifest.exports).map(([subpath, value]) => [
    subpath,
    // The workspace exports TypeScript source for its own bundlers; a deployed copy must be JavaScript.
    typeof value === 'string' && value.endsWith('.ts') ? value.replace(/^\.\/src\//, './dist/').replace(/\.ts$/, '.js') : value,
  ]),
);
manifest.main = './dist/index.js';
manifest.types = './dist/index.d.ts';
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

// 4. Astro writes its content-layer cache to `<root>/.astro`, and the mounted template is read-only: point that at the
//    tmpfs the build plan mounts over the image's `/var/cache/astro`.
const astroCache = path.join(out, '.astro');
fs.rmSync(astroCache, { recursive: true, force: true });
fs.symlinkSync('/var/cache/astro', astroCache);

// 5. Verify what a build will need: the Astro entry, the template's own config, the contracts entry.
const required = [
  path.join(out, 'node_modules/astro/bin/astro.mjs'),
  path.join(out, 'astro.config.mjs'),
  path.join(out, 'node_modules/@heopress/contracts/dist/theme/page-data.js'),
  path.join(out, 'tsconfig.base.json'),
];
// The `.astro` symlink dangles on the host (its target is the container's tmpfs), so it is checked as a link.
let cacheLink = '';
try {
  cacheLink = fs.readlinkSync(path.join(out, '.astro'));
} catch {
  cacheLink = '';
}
if (cacheLink !== '/var/cache/astro') {
  console.error(`prepare-astro-template: .astro must link to /var/cache/astro, found ${cacheLink || 'nothing'}`);
  process.exit(1);
}
const missing = required.filter((file) => !fs.existsSync(file));
if (missing.length > 0) {
  console.error(`prepare-astro-template: the template is not self-contained, missing:\n  ${missing.join('\n  ')}`);
  process.exit(1);
}

const size = execFileSync('du', ['-sh', out], { encoding: 'utf8' }).split('\t')[0];
console.log(`[template] ready: ${out} (${size})`);
console.log('Set HEOPRESS_ASTRO_TEMPLATE_DIR to this directory, and mount it read-only into the build container.');
