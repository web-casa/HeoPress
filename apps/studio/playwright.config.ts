import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/**
 * Studio browser scenarios (HeoPress P04 task 9.4, ADR-0017).
 *
 * They run on the build output, never a dev server: the CMS bundle
 * (`apps/cms/dist/serve.cjs`) serves the built Studio (`apps/studio/dist`,
 * HEOPRESS_STUDIO_DIST) on one origin, as Docker does. Build both first:
 *
 *   pnpm --filter @heopress/studio build && pnpm --filter @heopress/cms build
 *   DATABASE_URL=<disposable db> HEOPRESS_E2E_DISPOSABLE_DB=true pnpm --filter @heopress/studio e2e
 *
 * The database is reset and seeded (e2e/global-setup.ts), so it must be a
 * disposable one.
 */
const PORT = Number(process.env.E2E_PORT ?? 1991);
/** The stand-in model service (e2e/mock-model-server.mjs). */
const MODEL_PORT = Number(process.env.E2E_MODEL_PORT ?? 1993);
const root = path.resolve(import.meta.dirname, '../..');

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]] : 'list',
  outputDir: 'e2e-results',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  globalSetup: './e2e/global-setup.ts',
  webServer: [
    {
      command: `node ${path.join(root, 'apps/studio/e2e/mock-model-server.mjs')}`,
      url: `http://127.0.0.1:${MODEL_PORT}/health`,
      reuseExistingServer: false,
      env: { E2E_MODEL_PORT: String(MODEL_PORT) },
    },
    {
      command: `node ${path.join(root, 'apps/cms/dist/serve.cjs')}`,
      url: `http://127.0.0.1:${PORT}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        PORT: String(PORT),
        DATABASE_URL: process.env.DATABASE_URL ?? '',
        HEOPRESS_RUNTIME: 'docker',
        HEOPRESS_ENV: 'development',
        JWT_SECRET: process.env.JWT_SECRET ?? 'e2e-studio-jwt-secret',
        // A fixed test key (storage profile secrets are sealed with it).
        ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 9).toString('base64'),
        HEOPRESS_STUDIO_DIST: path.join(root, 'apps/studio/dist'),
        // Local storage profiles (and the default local storage) inside the ignored output folder.
        HEOPRESS_STORAGE_DIR: path.join(root, 'apps/studio/e2e-results/storage'),
        // The stand-in model service: an internal address the model gateway may reach.
        // Studio asks the setup state on every page load; the whole suite runs from one IP.
        HEOPRESS_SETUP_STATE_RATE_LIMIT: '1000',
        // Every scenario signs in as the same administrator on the same few sites: the per-principal API budget
        // (600 a minute) is reached on a fast runner.
        HEOPRESS_API_RATE_LIMIT: '6000',
        HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS: `http://127.0.0.1:${MODEL_PORT}`,
      },
    },
  ],
});
