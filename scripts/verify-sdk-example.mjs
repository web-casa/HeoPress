#!/usr/bin/env node
/**
 * Builds the color-picker example extension against the PACKED
 * @heopress/extension-sdk in a throwaway directory (P02 task 5.4), so the
 * example proves the published package works without monorepo source aliases.
 *
 *   node scripts/verify-sdk-example.mjs
 *
 * Needs network access to the npm registry for the example's own
 * dependencies (react, vite, typescript). Prints the built files on success.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'heopress-sdk-example-'));
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });

try {
  const sdk = path.join(root, 'packages/extension-sdk');
  run('pnpm', ['build'], sdk);
  run('pnpm', ['pack', '--pack-destination', work], sdk);
  const tarball = fs.readdirSync(work).find((f) => f.startsWith('heopress-extension-sdk-') && f.endsWith('.tgz'));
  if (!tarball) throw new Error('pnpm pack produced no tarball');

  const app = path.join(work, 'app');
  fs.cpSync(path.join(root, 'examples/extension-color-picker'), app, { recursive: true });
  const pkgPath = path.join(app, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.dependencies['@heopress/extension-sdk'] = `file:${path.join(work, tarball)}`;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], app);
  run('npm', ['run', 'build'], app);
  const built = fs.readdirSync(path.join(app, 'dist'));
  if (!built.includes('index.js')) throw new Error(`expected dist/index.js, got ${built.join(', ')}`);
  console.log(`[sdk-example] ok: built ${built.join(', ')} against ${tarball}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
