import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Screenshots of the eight module pages (HeoPress P07a task 13.1; ADR-0019 §8): light and dark, 1440 and 390 pixels
 * wide. The API is replayed from `api.har` (see playwright.visual.config.ts); the clock is fixed to the recording's, so
 * relative times and the date windows the pages ask for are the recorded ones.
 */

const RECORD = Boolean(process.env.VISUAL_RECORD);
const HAR = path.join(import.meta.dirname, 'api.har');
/**
 * The recording's "now", kept beside the fixture: the replay runs at that moment, so the session the fixture signed in
 * with is still valid (no refresh to answer), and the date windows and relative times are the recorded ones.
 */
const NOW_FILE = path.join(import.meta.dirname, 'recorded-at.json');
const NOW = RECORD ? new Date() : new Date((JSON.parse(readFileSync(NOW_FILE, 'utf8')) as { at: string }).at);
if (RECORD) writeFileSync(NOW_FILE, `${JSON.stringify({ at: NOW.toISOString() })}\n`);
const ADMIN = { email: 'admin@e2e.example.test', password: 'E2e-Studio-Admin-1!', path: '/e2e-admin' };
/** The links site of the e2e seed (apps/cms/scripts/e2e-studio-seed.ts). */
const SITE = 'e2e_site_links';

const MODULES: Array<[string, string]> = [
  ['overview', '/overview'],
  ['content', '/content'],
  ['sites', '/sites'],
  ['seo', '/seo/crawlers'],
  ['ai-traffic', '/ai-traffic'],
  ['audit', '/audit'],
  ['monitoring', '/monitoring'],
  ['settings', '/settings/general'],
];

async function signIn(page: Page): Promise<void> {
  await page.goto(`${ADMIN.path}/login`);
  await page.getByLabel(/email/i).fill(ADMIN.email);
  await page.getByLabel(/password/i).fill(ADMIN.password);
  await page.getByRole('button', { name: /sign in|log in/i }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

// One context for every picture: the recording is one fixture, and the replay answers the same requests.
test('module pages — light and dark, 1440 and 390 pixels', async ({ page, context }) => {
  test.setTimeout(600_000);
  await context.routeFromHAR(HAR, { url: '**/api/**', update: RECORD, updateContent: 'embed', notFound: RECORD ? 'fallback' : 'abort' });
  if (!RECORD) {
    // Studio renews its session on a full page load; the recording, made in one go, never needed to. The replay answers a
    // renewal with the session the recorded sign-in handed out (registered after the fixture, so it takes precedence).
    const har = JSON.parse(readFileSync(HAR, 'utf8')) as { log: { entries: Array<{ request: { url: string }; response: { content: { text?: string } } }> } };
    const login = har.log.entries.find((e) => e.request.url.endsWith('/api/v1/auth/login'))!.response.content.text!;
    await context.route('**/api/v1/auth/refresh', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: login }));
  }
  await page.clock.setFixedTime(NOW);
  await page.addInitScript(
    ([site]) => {
      window.localStorage.setItem('heopress.example.site', site!);
      window.localStorage.setItem('heopress.studio.language', 'zh-CN');
    },
    [SITE],
  );
  await signIn(page);
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1440, 390]) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      await page.setViewportSize({ width, height: 900 });
      for (const [name, route] of MODULES) {
        await page.goto(`${ADMIN.path}${route}`);
        // Skeletons gone: the page shows its data (or its empty state); then the charts settle.
        await expect(page.locator('#main-content .animate-pulse')).toHaveCount(0, { timeout: 15_000 });
        await page.waitForTimeout(1_500);
        // The page itself, never a sign-in or "not found" screen (an expired fixture session would show one).
        await expect(page.locator('#main-content')).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Not found' })).toHaveCount(0);
        if (!RECORD) await expect.soft(page).toHaveScreenshot(`${name}-${scheme}-${width}.png`, { fullPage: true });
      }
    }
  }
});
