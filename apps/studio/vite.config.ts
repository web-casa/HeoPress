// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { assertNoAdminPathEnv } from './src/lib/build-assertions';
import { devExtensionsPlugin } from './vite-plugins/dev-extensions';

// Fail the build (or dev server startup) if any env var starts with
// `VITE_ADMIN_PATH`. Vite would otherwise inline such a var into the
// client bundle, leaking the custom Admin Path that the "Hide Login"
// pattern depends on (admin-setup-wizard requirements §4.7;
// design.md §7.3 — Secret handling).
assertNoAdminPathEnv();

const repoRoot = path.resolve(__dirname, '../..');
const cmsProxyTarget = process.env.HEOPRESS_CMS_PROXY_TARGET ?? 'http://127.0.0.1:1989';

function readRootVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function readGitSha(): string {
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

const viteBuildMetadata = {
  VITE_HEOPRESS_VERSION: process.env.VITE_HEOPRESS_VERSION || process.env.HEOPRESS_VERSION || readRootVersion(),
  VITE_HEOPRESS_GIT_SHA: process.env.VITE_HEOPRESS_GIT_SHA || process.env.HEOPRESS_GIT_SHA || readGitSha(),
  VITE_HEOPRESS_BUILD_TIME: process.env.VITE_HEOPRESS_BUILD_TIME || process.env.HEOPRESS_BUILD_TIME || new Date().toISOString(),
  VITE_HEOPRESS_RELEASE_CHANNEL: process.env.VITE_HEOPRESS_RELEASE_CHANNEL || process.env.HEOPRESS_RELEASE_CHANNEL || process.env.NODE_ENV || 'development',
};

Object.assign(process.env, viteBuildMetadata);

export default defineConfig({
  plugins: [
    react(),
    // Dev-only: auto-detect UI extensions from the source `extensions/` folder
    // (the heopress-ai/extensions submodule). No-op in production builds.
    devExtensionsPlugin({ extensionsRoot: path.resolve(repoRoot, 'extensions') }),
  ],
  define: {
    'import.meta.env.VITE_HEOPRESS_VERSION': JSON.stringify(viteBuildMetadata.VITE_HEOPRESS_VERSION),
    'import.meta.env.VITE_HEOPRESS_GIT_SHA': JSON.stringify(viteBuildMetadata.VITE_HEOPRESS_GIT_SHA),
    'import.meta.env.VITE_HEOPRESS_BUILD_TIME': JSON.stringify(viteBuildMetadata.VITE_HEOPRESS_BUILD_TIME),
    'import.meta.env.VITE_HEOPRESS_RELEASE_CHANNEL': JSON.stringify(viteBuildMetadata.VITE_HEOPRESS_RELEASE_CHANNEL),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 2026,
    proxy: {
      // Proxy API calls to the local CMS so the SPA can use same-origin cookies.
      '/api': {
        target: cmsProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
