import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  isInsideDirectory,
  mountReservedReason,
  parseStaticRequestPath,
  parseStaticUrls,
  resolveMountDirectory,
  resolveStaticFile,
  staticCacheControl,
  staticContentType,
  staticNotModified,
  staticUrlsOn,
  staticValidators,
} from '../static-mount';

/**
 * The static directory mount's rules (v1.5, spec `rendering/static-directory-mount`): the request path is decoded twice
 * before anything touches the file system, traversal in any encoding is refused, symbolic links are never followed, and
 * the type, cache policy and validators of a served file come from its name and metadata — never from its content.
 */

describe('request paths', () => {
  it('decodes segments and keeps the trailing-slash fact', () => {
    expect(parseStaticRequestPath('/legacy/about.html')).toEqual({ ok: true, segments: ['legacy', 'about.html'], trailingSlash: false });
    expect(parseStaticRequestPath('/legacy/')).toEqual({ ok: true, segments: ['legacy'], trailingSlash: true });
    expect(parseStaticRequestPath('/')).toEqual({ ok: true, segments: [], trailingSlash: true });
    expect(parseStaticRequestPath('/caf%C3%A9/index.html')).toEqual({ ok: true, segments: ['café', 'index.html'], trailingSlash: false });
  });

  it('refuses traversal in plain, encoded and double-encoded form', () => {
    for (const path of ['/../etc/passwd', '/legacy/../../etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/%252e%252e/%252e%252e/etc/passwd', '/.%2e/etc/passwd']) {
      const parsed = parseStaticRequestPath(path);
      expect(parsed.ok, path).toBe(false);
      expect(parsed.ok === false && parsed.reason).toBe('traversal');
    }
  });

  it('refuses backslashes, NUL, control characters and encoded slashes', () => {
    expect(parseStaticRequestPath('/a%5Cb')).toMatchObject({ ok: false, reason: 'backslash' });
    expect(parseStaticRequestPath('/a\\b')).toMatchObject({ ok: false, reason: 'backslash' });
    expect(parseStaticRequestPath('/a%00b')).toMatchObject({ ok: false, reason: 'nul' });
    expect(parseStaticRequestPath('/a%0Ab')).toMatchObject({ ok: false, reason: 'control' });
    expect(parseStaticRequestPath('/a%2Fb')).toMatchObject({ ok: false, reason: 'traversal' });
  });

  it('refuses hidden entries and the metadata file, so an archive’s .git or .env is never public', async () => {
    expect(parseStaticRequestPath('/.git/config')).toMatchObject({ ok: false, reason: 'hidden' });
    expect(parseStaticRequestPath('/.env')).toMatchObject({ ok: false, reason: 'hidden' });
    const mount = await mkdtemp(join(tmpdir(), 'heopress-hidden-'));
    try {
      const { mkdir: makeDir } = await import('node:fs/promises');
      await makeDir(join(mount, '.git'), { recursive: true });
      await writeFile(join(mount, '.git', 'config'), 'secret');
      await writeFile(join(mount, 'static-urls.txt'), '/x');
      expect(await resolveStaticFile(mount, '/.git/config')).toMatchObject({ kind: 'missing', reason: 'hidden' });
      expect(await resolveStaticFile(mount, '/static-urls.txt')).toMatchObject({ kind: 'missing', reason: 'metadata' });
    } finally {
      await rm(mount, { recursive: true, force: true });
    }
  });

  it('refuses empty segments, bad escapes, non-absolute paths and over-long input', () => {
    expect(parseStaticRequestPath('/a//b')).toMatchObject({ ok: false, reason: 'empty_segment' });
    expect(parseStaticRequestPath('/a%zz')).toMatchObject({ ok: false, reason: 'bad_encoding' });
    expect(parseStaticRequestPath('legacy/about.html')).toMatchObject({ ok: false, reason: 'not_absolute' });
    expect(parseStaticRequestPath(`/${'a'.repeat(300)}`)).toMatchObject({ ok: false, reason: 'segment_too_long' });
    expect(parseStaticRequestPath(`/${'a/'.repeat(70)}x`)).toMatchObject({ ok: false, reason: 'too_many_segments' });
  });
});

describe('resolving a file under the mount', () => {
  let base: string;
  let root: string;
  let mount: string;
  let outside: string;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'heopress-mount-'));
    root = join(base, 'root');
    mount = join(root, 'site');
    outside = join(base, 'outside');
    await mkdir(join(mount, 'legacy'), { recursive: true });
    await mkdir(join(mount, 'docs'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(mount, 'legacy', 'about.html'), '<link rel="canonical" href="/about"><p>old</p>');
    await writeFile(join(mount, 'docs', 'index.html'), '<p>docs</p>');
    await writeFile(join(mount, 'index.html'), '<p>home</p>');
    await writeFile(join(outside, 'secret.txt'), 'do not serve');
    await symlink(join(outside, 'secret.txt'), join(mount, 'escape.txt'));
    await symlink(outside, join(mount, 'escape-dir'));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it('serves a regular file with its metadata', async () => {
    const found = await resolveStaticFile(mount, '/legacy/about.html');
    expect(found.kind).toBe('file');
    if (found.kind !== 'file') return;
    expect(found.file).toBe(join(mount, 'legacy', 'about.html'));
    expect(found.size).toBeGreaterThan(0);
  });

  it('answers a directory through its index, redirecting a request without the trailing slash', async () => {
    expect(await resolveStaticFile(mount, '/docs/')).toMatchObject({ kind: 'file', file: join(mount, 'docs', 'index.html') });
    expect(await resolveStaticFile(mount, '/docs')).toEqual({ kind: 'redirect', location: '/docs/' });
    expect(await resolveStaticFile(mount, '/')).toMatchObject({ kind: 'file', file: join(mount, 'index.html') });
  });

  it('never follows a symbolic link, so a link out of the directory cannot escape it', async () => {
    expect(await resolveStaticFile(mount, '/escape.txt')).toMatchObject({ kind: 'missing', reason: 'symlink' });
    expect(await resolveStaticFile(mount, '/escape-dir/secret.txt')).toMatchObject({ kind: 'missing', reason: 'symlink' });
  });

  it('does not let a traversal reach a file outside the directory', async () => {
    for (const path of ['/../outside/secret.txt', '/%2e%2e/outside/secret.txt', '/%252e%252e/outside/secret.txt']) {
      expect(await resolveStaticFile(mount, path), path).toMatchObject({ kind: 'missing' });
    }
  });

  it('reports a missing file as missing, never as an error', async () => {
    expect(await resolveStaticFile(mount, '/nope.html')).toMatchObject({ kind: 'missing' });
    expect(await resolveStaticFile(mount, '/legacy/missing/index.html')).toMatchObject({ kind: 'missing' });
  });

  it('bounds a stored directory to the operator root and resolves it', async () => {
    expect(await resolveMountDirectory(root, mount)).toBe(mount);
    expect(await resolveMountDirectory(root, outside)).toBeNull();
    expect(await resolveMountDirectory(join(root, 'site'), mount)).toBe(mount);
    expect(await resolveMountDirectory(mount, mount)).toBe(mount);
    expect(await resolveMountDirectory(root, '/etc')).toBeNull();
    expect(await resolveMountDirectory(null, mount)).toBeNull();
    expect(await resolveMountDirectory(root, join(root, 'gone'))).toBeNull();
    expect(isInsideDirectory(root, join(root, 'a', 'b'))).toBe(true);
    expect(isInsideDirectory(root, `${root}-other`)).toBe(false);
  });
});

describe('response headers', () => {
  it('maps extensions to types without sniffing', () => {
    expect(staticContentType('/legacy/about.html')).toBe('text/html; charset=utf-8');
    expect(staticContentType('page.HTM')).toBe('text/html; charset=utf-8');
    expect(staticContentType('app.css')).toBe('text/css; charset=utf-8');
    expect(staticContentType('app.mjs')).toBe('text/javascript; charset=utf-8');
    expect(staticContentType('logo.svg')).toBe('image/svg+xml');
    expect(staticContentType('font.woff2')).toBe('font/woff2');
    expect(staticContentType('archive.tar.gz')).toBe('application/gzip');
    expect(staticContentType('no-extension')).toBe('application/octet-stream');
    expect(staticContentType('dotfile.')).toBe('application/octet-stream');
  });

  it('gives documents a short cache, loaded resources a long immutable one, and the rest a short one', () => {
    expect(staticCacheControl('about.html')).toBe('public, max-age=0, must-revalidate');
    expect(staticCacheControl('app.css')).toBe('public, max-age=31536000, immutable');
    expect(staticCacheControl('photo.webp')).toBe('public, max-age=31536000, immutable');
    expect(staticCacheControl('feed.xml')).toBe('public, max-age=300');
    expect(staticCacheControl('notes.md')).toBe('public, max-age=300');
  });

  it('answers conditional requests from the validators, If-None-Match first', () => {
    const info = { size: 12, mtimeMs: 1_700_000_000_000 };
    const { etag, lastModified } = staticValidators(info);
    expect(etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(lastModified).toBe(new Date(1_700_000_000_000).toUTCString());
    expect(staticNotModified({ ifNoneMatch: etag }, info)).toBe(true);
    expect(staticNotModified({ ifNoneMatch: etag.replace(/^W\//, '') }, info)).toBe(true);
    expect(staticNotModified({ ifNoneMatch: '"other"' }, info)).toBe(false);
    expect(staticNotModified({ ifNoneMatch: '"other"', ifModifiedSince: lastModified }, info)).toBe(false);
    expect(staticNotModified({ ifModifiedSince: lastModified }, info)).toBe(true);
    expect(staticNotModified({ ifModifiedSince: new Date(1_600_000_000_000).toUTCString() }, info)).toBe(false);
    expect(staticNotModified({}, info)).toBe(false);
  });
});

describe('reserved segments', () => {
  it('keeps administration, engine, health and system paths away from the mount', () => {
    for (const segment of ['admin', 'api', 'internal', '_theme', '_ext', '_astro', 'health', 'healthz', 'metrics', 'studio', 'setup', 'scim', 'ADMIN']) {
      expect(mountReservedReason(segment), segment).toBe('reserved');
    }
    for (const segment of ['robots.txt', 'sitemap.xml', 'sitemap-1.xml', 'sitemap.txt', 'news-sitemap.xml', '.well-known', 'well-known', 'feed.xml', 'atom', 'llms.txt', 'llms-full.txt']) {
      expect(mountReservedReason(segment), segment).toBe('system');
    }
    // A one-segment root-file name is the mount's when the site has no such root file (the engine decides that); the
    // system's own file still wins there.
    for (const segment of ['legacy', 'about', 'old-docs', '_private', 'about.html', 'favicon.ico']) expect(mountReservedReason(segment), segment).toBeNull();
  });
});

describe('static-urls.txt', () => {
  it('keeps absolute paths, skips blanks and comments, reports invalid lines with their numbers', () => {
    const text = ['/legacy/a.html', '', '# a note', '/legacy/b.html', 'relative/path', '/has?query=1', '/../escape', '/has#fragment', '/a%00b', '/legacy/c/'].join('\n');
    const { paths, invalid } = parseStaticUrls(text);
    expect(paths).toEqual(['/legacy/a.html', '/legacy/b.html', '/legacy/c/']);
    expect(invalid).toEqual([
      { line: 5, reason: 'not_absolute' },
      { line: 6, reason: 'query_or_fragment' },
      { line: 7, reason: 'traversal' },
      { line: 8, reason: 'query_or_fragment' },
      { line: 9, reason: 'nul' },
    ]);
  });

  it('makes absolute URLs on one host, de-duplicated in order', () => {
    const { urls, invalid } = staticUrlsOn('a.example.com', ['/legacy/a.html', '/legacy/a.html', '/legacy/b.html', 'nope'].join('\n'));
    expect(urls).toEqual(['https://a.example.com/legacy/a.html', 'https://a.example.com/legacy/b.html']);
    expect(invalid).toHaveLength(1);
  });

  it('accepts an empty file', () => {
    expect(parseStaticUrls('')).toEqual({ paths: [], invalid: [] });
  });
});
