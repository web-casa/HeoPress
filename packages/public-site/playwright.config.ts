import { defineConfig, devices } from '@playwright/test';

/**
 * The starter themes in a browser (HeoPress P06 task 5.1): every page type of every starter theme,
 * rendered by the engine with the sample data (and a long unbroken title), at desktop, phone and 320 px
 * widths — screenshots kept as a report artifact, no horizontal overflow, and no axe (WCAG 2 A/AA) finding.
 * No server: the test serves the rendered pages and the theme's stylesheet itself.
 *
 *   pnpm --filter @heopress/public-site e2e
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '*.e2e.ts',
  outputDir: 'e2e-results',
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'e2e-report' }]] : 'list',
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
    { name: 'narrow', use: { ...devices['Desktop Chrome'], viewport: { width: 320, height: 640 } } },
  ],
});
