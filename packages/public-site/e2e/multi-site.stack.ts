import { expect, test, type Page } from '@playwright/test';

/**
 * Two public sites of a running production stack (HeoPress P06 task 7.4; see playwright.sites.config.ts):
 * each host shows its own site; an article published or edited through the API shows on the next refresh,
 * on its site only; another site's paths and unknown hosts are 404.
 */
const port = process.env.HEOPRESS_E2E_SITE_PORT;
const cms = process.env.HEOPRESS_E2E_CMS_URL;
const tokens: Record<string, string | undefined> = { 'e2e-alpha': process.env.HEOPRESS_E2E_TOKEN_ALPHA, 'e2e-beta': process.env.HEOPRESS_E2E_TOKEN_BETA };
const suffix = process.env.HEOPRESS_E2E_SUFFIX ?? 'sites.example.test';
const configured = Boolean(port && cms && tokens['e2e-alpha'] && tokens['e2e-beta']);
// In CI a missing stack is a failure, never a green run of skipped tests.
if (!configured && process.env.CI) throw new Error('multi-site e2e: the stack is not configured (run docker/scripts/e2e-p06-sites.sh)');
test.skip(!configured, 'needs the stack started by docker/scripts/e2e-p06-sites.sh');

const site = (name: string) => `http://${name}.${suffix}:${port}`;
const ALPHA = site('e2e-alpha');
const BETA = site('e2e-beta');

async function api(siteId: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${cms}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokens[siteId]}`, 'x-heopress-site': siteId, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(res.ok, `${method} ${path}: ${res.status}`).toBe(true);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}
const publish = (siteId: string, slug: string, title: string) =>
  api(siteId, 'POST', '/api/v1/items/articles', { data: { title, slug, locale: 'en', excerpt: `About ${title}.`, body: `<p>${title} body.</p>` }, status: 'published' });

/** The path of the article whose link has this text on the home page. */
async function articlePath(page: Page, base: string, title: string): Promise<string> {
  await page.goto(`${base}/`);
  const href = await page.getByRole('link', { name: title }).first().getAttribute('href');
  expect(href, title).toBeTruthy();
  return new URL(href!, base).pathname;
}

test('each host shows its own site and articles', async ({ page }) => {
  const a = await page.goto(`${ALPHA}/`);
  expect(a?.status()).toBe(200);
  await expect(page.getByRole('link', { name: 'Alpha first' })).toBeVisible();
  await expect(page.getByText('Beta first')).toHaveCount(0);
  const b = await page.goto(`${BETA}/`);
  expect(b?.status()).toBe(200);
  await expect(page.getByRole('link', { name: 'Beta first' })).toBeVisible();
  await expect(page.getByText('Alpha first')).toHaveCount(0);
  // Each site's theme: its own stylesheet, served from its own host, loaded (its rules are readable).
  for (const base of [ALPHA, BETA]) {
    await page.goto(`${base}/`);
    const sheets = await page.evaluate(() => [...document.styleSheets].filter((s) => s.href).map((s) => ({ href: s.href!, rules: s.cssRules.length })));
    expect(sheets.length, base).toBeGreaterThan(0);
    for (const sheet of sheets) {
      expect(new URL(sheet.href).host, base).toBe(new URL(base).host);
      expect(sheet.rules, sheet.href).toBeGreaterThan(0);
    }
  }
});

test('an article page: 200 on its site, 404 at the same path on the other site and on an unknown host', async ({ page }) => {
  const path = await articlePath(page, ALPHA, 'Alpha first');
  const own = await page.goto(`${ALPHA}${path}`);
  expect(own?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Alpha first' })).toBeVisible();
  // Beta's article lives at its own path (`beta-first`): Alpha's path is nothing on Beta.
  expect(await articlePath(page, BETA, 'Beta first')).not.toBe(path);
  const other = await page.goto(`${BETA}${path}`);
  expect(other?.status()).toBe(404);
  await expect(page.getByText('Alpha first')).toHaveCount(0);
  const unknown = await page.goto(`${site('nobody')}${path}`);
  expect(unknown?.status()).toBe(404);
  await expect(page.getByText('Alpha first')).toHaveCount(0);
});

for (const [siteId, base, other] of [
  ['e2e-alpha', ALPHA, BETA],
  ['e2e-beta', BETA, ALPHA],
] as const) {
  test(`${siteId}: published through the API shows on the next refresh, on its own site only; an edit and an unpublish too`, async ({ page }) => {
    const stamp = Date.now().toString(36);
    const title = `${siteId} fresh ${stamp}`;
    // Both homes rendered and cached first.
    await page.goto(`${base}/`);
    await expect(page.getByText(title)).toHaveCount(0);
    await page.goto(`${other}/`);
    const created = await publish(siteId, `fresh-${stamp}`, title);
    await page.goto(`${base}/`);
    await page.reload();
    await expect(page.getByRole('link', { name: title })).toBeVisible();
    await page.goto(`${other}/`);
    await expect(page.getByText(title)).toHaveCount(0);
    // The article page, then an edit of its title: the next refresh shows it.
    const path = await articlePath(page, base, title);
    await page.goto(`${base}${path}`);
    await expect(page.getByRole('heading', { name: title })).toBeVisible();
    const edited = `${title} edited`;
    const updated = await api(siteId, 'PATCH', `/api/v1/items/articles/${String(created.id)}`, { data: { title: edited }, expectedVersion: created.version });
    await page.reload();
    await expect(page.getByRole('heading', { name: edited })).toBeVisible();
    // Unpublished: the next refresh is a 404 or 410, and the home no longer lists it.
    await api(siteId, 'PATCH', `/api/v1/items/articles/${String(created.id)}`, { status: 'draft', expectedVersion: updated.version });
    const after = await page.reload();
    expect(after, 'a navigation').not.toBeNull();
    expect([404, 410]).toContain(after!.status());
    await expect(page.getByText(edited)).toHaveCount(0);
    await page.goto(`${base}/`);
    await expect(page.getByText(edited)).toHaveCount(0);
  });
}
