import { defineConfig, devices } from '@playwright/test';

/**
 * The public sites of a running production stack in a browser (HeoPress P06 task 7.4): two sites on their
 * own host names, content published through the API shows on a refresh, and never on the other site.
 * Started by `docker/scripts/e2e-p06-sites.sh`, which builds the stack, seeds it and passes
 * `HEOPRESS_E2E_SITE_PORT`, `HEOPRESS_E2E_CMS_URL`, `HEOPRESS_E2E_TOKEN_ALPHA` / `_BETA` (an administrator's, per site) and `HEOPRESS_E2E_SUFFIX`.
 */
const suffix = process.env.HEOPRESS_E2E_SUFFIX ?? 'sites.example.test';

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.stack.ts',
  outputDir: 'e2e-results/sites',
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'e2e-report/sites' }]] : 'list',
  // The tests publish content: one at a time.
  workers: 1,
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // The sites' names resolve to the published port on this machine.
        launchOptions: { args: [`--host-resolver-rules=MAP *.${suffix} 127.0.0.1`] },
      },
    },
  ],
});
