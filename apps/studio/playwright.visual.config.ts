import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

/**
 * Studio screenshot tests (HeoPress P07a task 13.1): the eight module pages, light and dark, at 1440 and 390 pixels wide.
 * Every API answer comes from a recorded fixture (`e2e-visual/api.har`, replayed by Playwright's routing), so the run needs
 * only the built Studio — no CMS, no database — and the pictures do not move with the data.
 *
 *   pnpm --filter @heopress/studio build
 *   pnpm --filter @heopress/studio visual                 # compare with the committed baselines
 *   pnpm --filter @heopress/studio visual --update-snapshots
 *
 * Re-record the fixture after an API change (needs the e2e stack of playwright.config.ts):
 *
 *   VISUAL_RECORD=1 DATABASE_URL=<disposable db> HEOPRESS_E2E_DISPOSABLE_DB=true pnpm --filter @heopress/studio visual
 *
 * Baselines are made in the Playwright image (`mcr.microsoft.com/playwright:v1.63.0-noble`), as CI runs them, so fonts and
 * anti-aliasing match.
 */
const RECORD = Boolean(process.env.VISUAL_RECORD);
// The recording's origin (playwright.config.ts): recorded answers are matched by their full address.
const PORT = 1991;

export default RECORD
  ? defineConfig({ ...base, testDir: './e2e-visual', snapshotPathTemplate: '{testDir}/baseline/{arg}{ext}' })
  : defineConfig({
      testDir: './e2e-visual',
      workers: 1,
      forbidOnly: Boolean(process.env.CI),
      reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'e2e-visual-report' }]] : 'list',
      outputDir: 'e2e-visual-results',
      snapshotPathTemplate: '{testDir}/baseline/{arg}{ext}',
      expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled', caret: 'hide' } },
      use: { baseURL: `http://127.0.0.1:${PORT}`, trace: 'retain-on-failure' },
      projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
      webServer: {
        command: `node ${path.join(import.meta.dirname, 'e2e-visual/serve.mjs')} ${PORT}`,
        url: `http://127.0.0.1:${PORT}/`,
        reuseExistingServer: false,
      },
    });
