#!/usr/bin/env node
/**
 * Bundle the rendering service for its image (HeoPress P06 task 5.2): `dist/serve.mjs` (the server) and
 * `dist/render-worker.mjs` (the theme worker, started by the pool from beside the server). Everything is
 * bundled: the image ships `dist/` and nothing else.
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  logLevel: 'warning',
  // CommonJS dependencies inside an ES module bundle still call require().
  banner: { js: "import { createRequire as __heopressRequire } from 'node:module'; const require = __heopressRequire(import.meta.url);" },
};
await build({ ...common, entryPoints: [join(root, 'src/serve.ts')], outfile: join(root, 'dist/serve.mjs') });
await build({ ...common, entryPoints: [join(root, '../../packages/public-site/src/theme/render-worker.ts')], outfile: join(root, 'dist/render-worker.mjs') });
console.log('[site-classic] built dist/serve.mjs and dist/render-worker.mjs');
