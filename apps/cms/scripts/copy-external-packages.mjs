#!/usr/bin/env node
// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
/**
 * Ship the packages esbuild leaves external next to dist/serve.cjs, with their
 * runtime dependencies, so the slim runtime image (which copies only dist/)
 * resolves them:
 *   - node-cron@4 evaluates `import.meta.url` at module load; bundled into CJS
 *     that URL is undefined and Docker/Node startup crashes;
 *   - sharp (HeoPress P03 image transforms) loads native binaries from its
 *     platform packages (@img/sharp-<platform>, @img/sharp-libvips-<platform>),
 *     which only the installed copies for this machine provide.
 *
 * Dependencies and optional dependencies are followed recursively from where
 * pnpm installed each package; optional ones that are not installed (other
 * platforms) are skipped. Symlinks are dereferenced.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXTERNAL = ['node-cron', 'sharp'];

const here = dirname(fileURLToPath(import.meta.url));
const cmsRoot = join(here, '..');
const outDir = join(cmsRoot, 'dist', 'node_modules');

/** Directory of `name` as resolved from `fromDir`, or null when not installed. */
function packageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

rmSync(outDir, { recursive: true, force: true });
const copied = new Set();
const queue = EXTERNAL.map((name) => ({ name, from: cmsRoot, required: true }));
// Packages resolved through @heopress/runtime (sharp lives there).
const runtimeDir = realpathSync(join(cmsRoot, 'node_modules', '@heopress', 'runtime'));

while (queue.length > 0) {
  const { name, from, required } = queue.shift();
  if (copied.has(name)) continue;
  const dir = packageDir(name, from) ?? packageDir(name, runtimeDir);
  if (!dir) {
    if (required) throw new Error(`[copy-external-packages] ${name} is not installed`);
    continue;
  }
  const dest = join(outDir, name);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(dir, dest, { recursive: true, dereference: true });
  copied.add(name);
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push({ name: dep, from: dir, required: true });
  for (const dep of Object.keys(pkg.optionalDependencies ?? {})) queue.push({ name: dep, from: dir, required: false });
}
console.log(`[copy-external-packages] ${[...copied].sort().join(', ')} -> ${outDir}`);
