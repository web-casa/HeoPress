import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildEnv, type BuildRequest } from '../builder/runner';
import { writePageDataFile } from '../builder/index';
import type { PageDataSnapshot } from '@heopress/contracts/page-data';

/**
 * Page data as a file (HeoPress v1.5, spec rendering/astro-build-sandbox): a sandboxed build has no network, so the
 * snapshot is written into the build's read-only input and read from there. The two things that must hold are that the
 * build's environment names the file instead of the interface, and that what is written is the snapshot exactly.
 */
let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'heopress-page-data-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const snapshot = {
  version: 1,
  siteId: 'site_a',
  origin: 'https://example.com',
  locales: ['en'],
  defaultLocale: 'en',
  site: { name: 'Example', description: '' },
  routes: [],
  files: [],
  pages: [],
  items: {},
  generatedAt: '2026-11-15T00:00:00.000Z',
} as unknown as PageDataSnapshot;

const request = (pageData: BuildRequest['pageData']): BuildRequest => ({
  pageData,
  themeDir: join(root, 'theme'),
  outDir: join(root, 'out'),
});

describe('page data as a file', () => {
  it('names the file and drops the interface it cannot reach', () => {
    const env = buildEnv(request({ url: 'http://127.0.0.1:9/v1/page-data', token: 'tok', file: '/in/.page-data/7.json' }), '/tmp/home');
    expect(env.HEOPRESS_PAGE_DATA_FILE).toBe('/in/.page-data/7.json');
    expect(env.HEOPRESS_PAGE_DATA_URL).toBeUndefined();
    expect(env.HEOPRESS_PAGE_DATA_TOKEN).toBeUndefined();
  });

  it('keeps the loopback interface for an unsandboxed build', () => {
    const env = buildEnv(request({ url: 'http://127.0.0.1:9/v1/page-data', token: 'tok' }), '/tmp/home');
    expect(env.HEOPRESS_PAGE_DATA_URL).toBe('http://127.0.0.1:9/v1/page-data');
    expect(env.HEOPRESS_PAGE_DATA_TOKEN).toBe('tok');
    expect(env.HEOPRESS_PAGE_DATA_FILE).toBeUndefined();
  });

  it('writes the snapshot exactly, readable only by its owner, under the input directory', async () => {
    const template = join(root, 'template');
    const file = await writePageDataFile(template, snapshot, 7);
    expect(file).toBe(join(template, '.page-data', '7.json'));
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(snapshot);
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
