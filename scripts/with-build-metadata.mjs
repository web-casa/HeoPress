#!/usr/bin/env node
// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readRootVersion() {
  try {
    const pkg = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function readGitSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

const metadata = {
  HEOPRESS_VERSION: process.env.HEOPRESS_VERSION || readRootVersion(),
  HEOPRESS_GIT_SHA: process.env.HEOPRESS_GIT_SHA || readGitSha(),
  HEOPRESS_BUILD_TIME: process.env.HEOPRESS_BUILD_TIME || new Date().toISOString(),
  HEOPRESS_RELEASE_CHANNEL: process.env.HEOPRESS_RELEASE_CHANNEL || process.env.NODE_ENV || 'development',
};

const env = {
  ...process.env,
  ...metadata,
  VITE_HEOPRESS_VERSION: process.env.VITE_HEOPRESS_VERSION || metadata.HEOPRESS_VERSION,
  VITE_HEOPRESS_GIT_SHA: process.env.VITE_HEOPRESS_GIT_SHA || metadata.HEOPRESS_GIT_SHA,
  VITE_HEOPRESS_BUILD_TIME: process.env.VITE_HEOPRESS_BUILD_TIME || metadata.HEOPRESS_BUILD_TIME,
};

const [command, ...rawArgs] = process.argv.slice(2);
if (!command) {
  console.error('Usage: node scripts/with-build-metadata.mjs <command> [...args]');
  process.exit(1);
}

const args = [...rawArgs];
if (args[0] === '--') {
  args.shift();
}
if (command === 'wrangler' && args[0] === 'deploy') {
  for (const [key, value] of Object.entries(metadata)) {
    args.push('--var', `${key}:${value}`);
  }
}
// The Node bundle (Docker image) has no build-time bindings: `serve.cjs`
// reads process.env at runtime, and nothing sets HEOPRESS_VERSION there.
// Bake the metadata in so `/api/v1/system/version` reports the real build.
// Read by `apps/cms/src/routes/system.ts`; runtime env still overrides it.
if (command === 'esbuild') {
  args.push(`--define:__HEOPRESS_BUILD_METADATA__=${JSON.stringify(metadata)}`);
}

const child = spawn(command, args, {
  cwd: process.cwd(),
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
