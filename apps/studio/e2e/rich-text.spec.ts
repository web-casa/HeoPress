import { expect, test, type Page } from '@playwright/test';
import { ADMIN, seed, signIn, useSite } from './fixtures';

/**
 * The rich-text editor (ADR-0020: Tiptap 3, Notion-style, MIT parts only), in the article editor's body. Each test
 * edits its own new draft on the links site, whose body has two H2 and one H3.
 */

const BODY = '<h2>First part</h2><p>One.</p><h3>A detail</h3><p>Two.</p><h2>Second part</h2><p>Three.</p>';

/** Signs in, creates a draft with `BODY` and opens it in the article editor; returns its id. */
async function open(page: Page, language: 'en' | 'zh-CN' = 'en'): Promise<string> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const site = seed().links.site;
  await useSite(page, site);
  await page.addInitScript((lang) => window.localStorage.setItem('heopress.studio.language', lang), language);
  // These scenarios use the outline and inspector: the panels are shown (focus mode is the default).
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.editorFocus', '0'));
  await signIn(page, ADMIN.email, ADMIN.password);
  const token = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('heopress.session.v2|'))!;
    return (JSON.parse(localStorage.getItem(key)!) as { token: string }).token;
  });
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const res = await page.request.post('/api/v1/items/articles', {
    headers: { authorization: `Bearer ${token}`, 'x-heopress-site': site, 'content-type': 'application/json' },
    data: { data: { title: `Rich text ${stamp}`, slug: `rich-text-${stamp}`, locale: 'en', body: BODY }, status: 'draft' },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { data: { id: string } }).data.id;
  await page.goto(`${ADMIN.path}/content/articles/${id}`);
  await expect(page.getByRole('textbox', { name: 'Body' }).locator('h2').first()).toHaveText('First part');
  // The interface language is loaded (the editor's area mounts again once it is).
  await expect(page.getByRole('navigation', { name: language === 'en' ? 'Outline' : '大纲' })).toBeVisible();
  return id;
}

const body = (page: Page) => page.getByRole('textbox', { name: 'Body' });

/** Puts the caret on a new empty line at the end of the body. */
async function newLineAtEnd(page: Page): Promise<void> {
  await body(page).locator('p').last().click();
  await expect(body(page)).toBeFocused();
  await page.keyboard.press('End');
  // The editor takes up a caret moved by the browser on its next selectionchange; keys sent within the same
  // millisecond, faster than any person, would act on the old place.
  await page.waitForTimeout(50);
  await page.keyboard.press('Enter');
}

test('"/" inserts a block: a heading typed this way shows in the outline and is saved as H2', async ({ page }) => {
  await open(page);
  await newLineAtEnd(page);
  await page.keyboard.type('/head');
  const menu = page.getByRole('listbox', { name: 'Insert a block' });
  await expect(menu.getByRole('option').first()).toHaveText(/Heading/);
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await page.keyboard.type('Third part');
  await expect(page.getByRole('navigation', { name: 'Outline' }).getByRole('button', { name: 'Third part' })).toBeVisible();
  // Escape closes the menu and leaves the "/" typed.
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.keyboard.press('Backspace');

  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/items/articles/'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const answer = (await (await saved).json()) as { data: { data: { body: string } } };
  // Stored as an H2; the blocks that were there keep their IDs, the new one gets its own (spec content/block-identity).
  const stored = answer.data.data.body;
  expect(stored).toMatch(/<h2 data-block-id="[^"]+">Third part<\/h2>/);
  const ids = [...stored.matchAll(/data-block-id="([^"]+)"/g)].map((m) => m[1]);
  expect(new Set(ids).size).toBe(ids.length);
  // Saving again without edits keeps every ID.
  await body(page).click();
  await page.keyboard.type('!');
  const again = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/items/articles/'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const second = ((await (await again).json()) as { data: { data: { body: string } } }).data.data.body;
  expect([...second.matchAll(/data-block-id="([^"]+)"/g)].map((m) => m[1])).toEqual(ids);
});

test('selecting text shows the formatting bar; bold and a link are applied', async ({ page }) => {
  await open(page);
  await newLineAtEnd(page);
  await page.keyboard.type('Make this bold');
  await page.keyboard.press('Shift+Home');
  const bar = page.getByRole('toolbar', { name: 'Formatting' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: 'Bold' }).click();
  await expect(body(page).locator('strong', { hasText: 'Make this bold' })).toBeVisible();
  await expect(bar.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
  await bar.getByRole('button', { name: 'Link' }).click();
  await bar.getByLabel('Link address').fill('https://example.com/guide');
  await bar.getByRole('button', { name: 'Apply' }).click();
  await expect(body(page).locator('a[href="https://example.com/guide"]')).toHaveText('Make this bold');
});

test('an image is inserted with its alternative text', async ({ page }) => {
  await open(page);
  await newLineAtEnd(page);
  await page.keyboard.type('/image');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Insert an image' });
  await dialog.getByLabel('Image address').fill('https://example.com/kyoto.jpg');
  await dialog.getByLabel('Alternative text').fill('Kyoto at dawn');
  await dialog.getByRole('button', { name: 'Insert' }).click();
  await expect(body(page).locator('img[src="https://example.com/kyoto.jpg"]')).toHaveAttribute('alt', 'Kyoto at dawn');
});

test('Chinese and Japanese input methods: composed text arrives once, in lists and headings too', async ({ page }) => {
  await open(page, 'zh-CN');
  const cdp = await page.context().newCDPSession(page);
  /** What an input method does: a composition shown while typing, then the chosen text committed. */
  const compose = async (steps: string[], commit: string) => {
    for (const text of steps) await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    await cdp.send('Input.insertText', { text: commit });
  };
  const editor = page.getByRole('textbox', { name: 'Body' });
  await newLineAtEnd(page);
  await compose(['j', 'ji', 'jing', 'jingdu'], '京都');
  await compose(['s', 'shi', 'shir', 'shiri'], '十日');
  await expect(editor).toContainText('京都十日');
  await expect(editor.getByText('京都十日', { exact: true })).toHaveCount(1);

  // In a list item, then Enter makes the next item and keeps the text.
  await page.keyboard.press('Enter');
  await page.keyboard.type('- ');
  await compose(['ど', 'どう', 'どうぞ'], 'どうぞ');
  await page.keyboard.press('Enter');
  await compose(['h', 'he', 'hel'], '和');
  await expect(editor.locator('ul li')).toHaveText(['どうぞ', '和']);

  // In a heading made with "## ".
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('## ');
  await compose(['l', 'lu', 'lux', 'luxi', 'luxian'], '路线');
  await expect(editor.locator('h2', { hasText: '路线' })).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: '大纲' }).getByRole('button', { name: '路线' })).toBeVisible();
});

test('the drag handle shows beside the block under the pointer', async ({ page }) => {
  await open(page);
  await body(page).locator('h2').first().hover();
  await expect(page.locator('.rt-handle')).toBeVisible();
});

test('focus mode is the default: only the title and the body, on white; the choice is remembered', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useSite(page, seed().links.site);
  await page.addInitScript(() => window.localStorage.setItem('heopress.studio.language', 'en'));
  await signIn(page, ADMIN.email, ADMIN.password);
  await page.goto(`${ADMIN.path}/content/articles/${seed().links.editor}`);
  await expect(page.getByRole('textbox', { name: 'Body' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Modules' })).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Outline' })).toBeHidden();
  await expect(page.getByRole('complementary', { name: 'SEO' })).toBeHidden();
  const background = await page.getByRole('textbox', { name: 'Body' }).evaluate((el) => getComputedStyle(el.closest('.bg-panel')!).backgroundColor);
  expect(background).toBe('rgb(255, 255, 255)');

  await page.getByRole('button', { name: 'Show panels' }).click();
  await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Outline' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Outline' })).toBeVisible();
  // The shortcut switches back; leaving the editor shows the navigation again.
  await page.getByRole('textbox', { name: 'Body' }).click();
  await page.keyboard.press('ControlOrMeta+Shift+F');
  await expect(page.getByRole('navigation', { name: 'Modules' })).toBeHidden();
  await page.getByRole('link', { name: 'Back' }).click();
  await expect(page.getByRole('navigation', { name: 'Modules' })).toBeVisible();
});

/** Pastes a file into the body, as copying an image from another app does; `padTo` makes it that many bytes in the page. */
async function pasteFile(page: Page, name: string, type: string, bytes: number[], padTo = 0): Promise<void> {
  await page.getByRole('textbox', { name: 'Body' }).evaluate(
    (el, { name, type, bytes, padTo }) => {
      const content = new Uint8Array(Math.max(bytes.length, padTo));
      content.set(bytes);
      const data = new DataTransfer();
      data.items.add(new File([content], name, { type }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    },
    { name, type, bytes, padTo },
  );
}
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];

test('without object storage an upload is refused with the reason; a video by address is inserted', async ({ page }) => {
  await open(page);
  await newLineAtEnd(page);
  await pasteFile(page, 'shot.png', 'image/png', PNG);
  await expect(page.getByRole('alert').filter({ hasText: 'shot.png' })).toContainText('object storage (S3, R2 or OSS)');
  await expect(body(page).locator('img')).toHaveCount(0);

  await page.keyboard.type('/image');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Insert an image' });
  await expect(dialog.getByRole('note')).toContainText('object storage');
  await expect(dialog.getByRole('link', { name: 'Storage settings' })).toHaveAttribute('href', /\/settings\/advanced\/storage$/);
  await expect(dialog.getByLabel('Upload a file')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  // Closing the dialog puts the caret back in the body.
  await expect(body(page)).toBeFocused();
  await page.keyboard.type('/video');
  await page.keyboard.press('Enter');
  const video = page.getByRole('dialog', { name: 'Insert a video' });
  await video.getByLabel('Video address').fill('https://media.example.com/walk.mp4');
  await video.getByRole('button', { name: 'Insert' }).click();
  await expect(body(page).locator('video[src="https://media.example.com/walk.mp4"]')).toHaveAttribute('controls', '');
});

test('with object storage, a pasted image and an uploaded video go up and into the text with their keys', async ({ page }) => {
  // The site's object storage as the server reports it, and its uploads (the server side has its own tests).
  await page.route('**/api/v1/editor-media/target', (route) =>
    route.fulfill({ json: { data: { available: true, reason: null, prefix: 'editor/', types: ['image/png', 'image/jpeg', 'video/mp4'], maxBytes: 10485760, videoMaxBytes: 52428800 } } }),
  );
  const uploaded: Array<{ key: string; type: string | undefined }> = [];
  await page.route('**/api/v1/media/editor/**', async (route) => {
    const key = decodeURIComponent(new URL(route.request().url()).pathname.replace(/^.*\/api\/v1\/media\//, ''));
    uploaded.push({ key, type: route.request().headers()['content-type'] });
    await route.fulfill({ status: 201, json: { data: { key, url: `https://img.example.com/sites/s/media/${key}` } } });
  });
  await open(page);
  await newLineAtEnd(page);
  await pasteFile(page, 'kyoto.png', 'image/png', PNG);
  const img = body(page).locator('img[data-media-key]');
  await expect(img).toHaveAttribute('src', /^https:\/\/img\.example\.com\/sites\/s\/media\/editor\/\d{4}\/\d{2}\/[0-9a-z]{20}\.png$/);
  expect(uploaded[0]).toMatchObject({ key: expect.stringMatching(/^editor\//), type: 'image/png' });

  await page.keyboard.type('/video');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Insert a video' });
  await dialog.getByLabel('Upload a file').setInputFiles({ name: 'walk.mp4', mimeType: 'video/mp4', buffer: Buffer.from([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]) });
  await expect(body(page).locator('video[data-media-key]')).toHaveAttribute('src', /editor\/\d{4}\/\d{2}\/[0-9a-z]{20}\.mp4$/);
  // A file over the cap is refused before it is sent.
  await pasteFile(page, 'huge.png', 'image/png', PNG, 10485760 + PNG.length);
  await expect(page.getByRole('alert').filter({ hasText: 'huge.png' })).toContainText('larger than 10 MB');
  expect(uploaded).toHaveLength(2);
});
