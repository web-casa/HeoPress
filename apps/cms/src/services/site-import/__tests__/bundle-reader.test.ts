import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findCredentialFields, importRecordJsonSchema, isCredentialKey } from '@heopress/contracts/schemas';
import { BundleInvalidError, DEFAULT_BUNDLE_LIMITS, isSafeRelativePath, loadBundle, parseBundleRecords, sniffMatches } from '../bundle-reader';
import { prepareRichText } from '../body';

/** HeoPress P12 tasks 6.1, 6.4: the bundle format, credentials refused, paths, limits, media types, sanitising. */

const header = { type: 'header', format: 'heopress-import', version: 1, source: 'astro', sourceSite: 'blog-example' };
const item = (id: string, over: Record<string, unknown> = {}) => ({ type: 'item', externalId: id, collection: 'articles', locale: 'en', status: 'published', data: { title: id, slug: id }, ...over });
const ndjson = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function bundleDir(records: unknown[], files: Record<string, Buffer> = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'heopress-bundle-'));
  dirs.push(dir);
  await writeFile(path.join(dir, 'bundle.ndjson'), ndjson(records));
  for (const [rel, bytes] of Object.entries(files)) {
    const full = path.join(dir, 'media', rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, bytes);
  }
  return dir;
}
const problemsOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return [];
  } catch (err) {
    if (err instanceof BundleInvalidError) return err.problems;
    throw err;
  }
};

describe('bundle schema (task 6.1)', () => {
  it('accepts every record kind of a full bundle', () => {
    const { records, problems } = parseBundleRecords(
      ndjson([
        header,
        { type: 'site', settings: { defaultLocale: 'en', locales: ['en', 'zh-CN'], trailingSlash: 'always', permalinks: { articles: '/blog/:slug' } } },
        { type: 'collection', source: 'blog', collection: 'articles', fields: { heroImage: 'seo_image' } },
        item('a', { translationKey: 'a', sponsored: true, sponsorName: 'Acme', publishedAt: '2020-01-02T03:04:05Z', author: 'Jane', tags: ['x'], legacyPath: '/blog/a/' }),
        item('a-zh', { locale: 'zh-CN', translationKey: 'a', internalOnly: false }),
        { type: 'translationGroup', key: 'a', source: 'a', members: ['a', 'a-zh'] },
        { type: 'redirect', from: '/old/', to: '/blog/a/', status: 301 },
        { type: 'media', id: 'm1', path: 'a/b.png', size: 16, sha256: 'a'.repeat(64), mimeType: 'image/png' },
        { type: 'licence', subject: 'a', licence: 'own' },
        { type: 'revision', externalId: 'a', at: '2019-01-01T00:00:00Z', data: { title: 'first' } },
      ]),
    );
    expect(problems).toEqual([]);
    expect(records.map((r) => r.record.type)).toEqual(['header', 'site', 'collection', 'item', 'item', 'translationGroup', 'redirect', 'media', 'licence', 'revision']);
  });

  it('refuses a missing header, unknown fields and bad values, with the line', () => {
    expect(parseBundleRecords(ndjson([item('a')])).problems).toContainEqual(expect.objectContaining({ code: 'HEADER_MISSING' }));
    const { problems } = parseBundleRecords(ndjson([header, item('a', { status: 'scheduled' }), { ...item('b'), surprise: 1 }]));
    expect(problems.map((p) => [p.line, p.code])).toEqual([
      [2, 'SCHEMA'],
      [3, 'SCHEMA'],
    ]);
  });

  it('spec "含凭据的导入包": a site setting that looks like a secret fails and names where it is', () => {
    const { problems } = parseBundleRecords(ndjson([header, { type: 'site', settings: { defaultLocale: 'en', locales: ['en'], smtp: { password: 'x' }, apiKey: 'y' } }]));
    expect(problems.filter((p) => p.code === 'CREDENTIAL_FIELD').map((p) => [p.line, p.at])).toEqual([
      [2, 'settings.smtp.password'],
      [2, 'settings.apiKey'],
    ]);
    // The value is never echoed.
    expect(JSON.stringify(problems)).not.toContain('"y"');
  });

  it('credential keys and values, without flagging ordinary fields', () => {
    for (const k of ['apiKey', 'api_key', 'API-KEY', 'clientSecret', 'db_password', 'accessToken', 'private_key', 'credentials']) expect(isCredentialKey(k), k).toBe(true);
    for (const k of ['author', 'authors', 'keywords', 'title', 'tokenizer', 'sessionNumber']) expect(isCredentialKey(k), k).toBe(k === 'sessionNumber');
    expect(findCredentialFields({ db: ['postgres://u', 'p@db.example.com/x'].join(':'), ok: 'https://example.com/a' })).toEqual(['db']);
  });

  it('the committed JSON Schema is the one the contracts produce', async () => {
    const committed = JSON.parse(await (await import('node:fs/promises')).readFile(path.resolve(__dirname, '../../../../../../docs/schemas/heopress.import-bundle.v1.schema.json'), 'utf8'));
    expect(committed).toEqual(JSON.parse(JSON.stringify(importRecordJsonSchema())));
  });
});

describe('import safety (task 6.4)', () => {
  it('spec "路径穿越": a media path outside media/ fails the dry run and names the record', async () => {
    const records = [header, item('a'), { type: 'media', id: 'evil', path: '../../etc/passwd', size: 1, sha256: 'a'.repeat(64), mimeType: 'image/png' }];
    const problems = await problemsOf(loadBundle(await bundleDir(records)));
    expect(problems).toContainEqual(expect.objectContaining({ line: 3, at: 'path', code: 'PATH_UNSAFE' }));
    for (const p of ['../x.png', '/etc/passwd', 'a/../../x', 'a\\b.png', 'C:/x.png', './a.png', 'a//b.png']) expect(isSafeRelativePath(p), p).toBe(false);
    expect(isSafeRelativePath('blog/2021/a.png')).toBe(true);
  });

  it('a symbolic link out of media/ is refused', async () => {
    const dir = await bundleDir([header, { type: 'media', id: 'l', path: 'link.png', size: PNG.length, sha256: sha(PNG), mimeType: 'image/png' }], { 'x.png': PNG });
    const outside = path.join(dir, 'outside.png');
    await writeFile(outside, PNG);
    await symlink(outside, path.join(dir, 'media', 'link.png'));
    expect(await problemsOf(loadBundle(dir))).toContainEqual(expect.objectContaining({ code: 'MEDIA_MISSING', at: 'link.png' }));
  });

  it('size and count limits: an oversized media file, too many items, an oversized records file', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2048)]);
    const records = [header, { type: 'media', id: 'big', path: 'big.png', size: big.length, sha256: sha(big), mimeType: 'image/png' }];
    const limits = { ...DEFAULT_BUNDLE_LIMITS, mediaFileBytes: 1024, items: 2, recordsFileBytes: 10_000 };
    expect(await problemsOf(loadBundle(await bundleDir(records, { 'big.png': big }), limits))).toContainEqual(expect.objectContaining({ code: 'MEDIA_TOO_LARGE' }));
    expect(await problemsOf(loadBundle(await bundleDir([header, item('a'), item('b'), item('c')]), limits))).toContainEqual(expect.objectContaining({ code: 'TOO_MANY_ITEMS' }));
    const huge = [header, item('a', { data: { title: 'x'.repeat(20_000), slug: 'a' } })];
    expect(await problemsOf(loadBundle(await bundleDir(huge), limits))).toContainEqual(expect.objectContaining({ code: 'BUNDLE_TOO_LARGE' }));
  });

  it('media type, size and hash are checked against the file', async () => {
    const notPng = Buffer.from('<svg onload="alert(1)"></svg>');
    const records = [
      header,
      { type: 'media', id: 'fake', path: 'fake.png', size: notPng.length, sha256: sha(notPng), mimeType: 'image/png' },
      { type: 'media', id: 'hash', path: 'ok.png', size: PNG.length, sha256: 'b'.repeat(64), mimeType: 'image/png' },
      { type: 'media', id: 'svg', path: 'a.svg', size: notPng.length, sha256: sha(notPng), mimeType: 'image/svg+xml' },
    ];
    const problems = await problemsOf(loadBundle(await bundleDir(records, { 'fake.png': notPng, 'ok.png': PNG, 'a.svg': notPng })));
    expect(problems.map((p) => p.code).sort()).toEqual(['MEDIA_HASH', 'MEDIA_TYPE', 'SCHEMA']);
    expect(sniffMatches('image/png', PNG)).toBe(true);
  });

  it('a valid bundle loads, with its namespace and media readable', async () => {
    const records = [header, item('a'), { type: 'media', id: 'm', path: 'p/a.png', size: PNG.length, sha256: sha(PNG), mimeType: 'image/png' }];
    const b = await loadBundle(await bundleDir(records, { 'p/a.png': PNG }));
    expect(b.namespace).toBe('astro:blog-example');
    expect(await b.readMedia(b.media[0]!)).toEqual(PNG);
  });

  it('spec: script injection in a body is removed and reported', () => {
    const r = prepareRichText('<p onclick="x()">Hi</p><script>alert(1)</script><iframe src="https://example.com"></iframe><img src="heopress-media:m1"><div data-block-type="custom-component" data-component="ComparisonTable" data-props="{}"></div>', (id) => (id === 'm1' ? 'https://media.example.com/a.png' : null));
    expect(r.issues).toEqual(['script element', 'frame element', 'event handler attribute']);
    expect(r.html).toBe('<p>Hi</p><img src="https://media.example.com/a.png" /><div data-block-type="custom-component" data-component="ComparisonTable" data-props="{}"></div>');
  });
});
