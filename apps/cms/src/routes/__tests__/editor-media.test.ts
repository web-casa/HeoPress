import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../env';
import { PermissionService, type CompiledPermission } from '../../services/permission-service';
import { editorMediaRouter } from '../editor-media';
import { mediaRouter } from '../media';

/**
 * Uploads into articles (ADR-0020; maintainer decision 2026-10-25): only to object storage — an S3-compatible
 * profile (S3, R2, OSS) with a public base URL — so the address in the article is one readers can load.
 */

const where = vi.hoisted(() => ({ driver: null as 'local' | 's3' | null, publicBaseUrl: null as string | null }));
vi.mock('../storage-profiles', () => ({
  storageProfileServiceFor: (c: { get(k: string): unknown }) => {
    const runtime = c.get('runtime') as { storage: unknown };
    const at = (key: string) => ({ storage: runtime.storage, objectKey: `sites/site-a/media/${key}`, profileId: where.driver ? 'p1' : null, publicBaseUrl: where.publicBaseUrl, driver: where.driver });
    return { readLocation: async (key: string) => at(key), writeLocation: async (key: string) => at(key), recordWrite: async () => {} };
  },
}));
vi.mock('../../services/upload-policy-service', () => ({
  resolveUploadPolicy: async () => ({ maxBytes: 10 * 1024 * 1024, allowedMimeTypes: ['image/png', 'image/jpeg', 'image/svg+xml', 'video/mp4', 'application/pdf'] }),
}));

const allow = { collection: 'media', action: 'create', rule: null, fields: ['*'], presets: {}, validation: {}, sources: [] } satisfies CompiledPermission;

function app() {
  const storage = { put: vi.fn(async () => undefined), get: vi.fn(), list: vi.fn(), delete: vi.fn() };
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('siteId', 'site-a');
    c.set('auth', { userId: 'u', email: 'u@example.test', roles: [], raw: {} });
    c.set('db', {} as never);
    c.set('runtime', { storage, cache: undefined, queue: undefined } as never);
    await next();
  });
  a.route('/media', mediaRouter);
  a.route('/editor-media', editorMediaRouter);
  return { a, storage };
}
const upload = (a: Hono<AppEnv>, key: string) => a.request(`/media/${key}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array([1, 2, 3]) });

describe('uploads into articles', () => {
  afterEach(() => vi.restoreAllMocks());

  it('are refused without object storage, and the editor is told so first', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allow);
    for (const [driver, url, code] of [
      [null, null, 'OBJECT_STORAGE_REQUIRED'],
      ['local', 'https://img.example.com', 'OBJECT_STORAGE_REQUIRED'],
      ['s3', null, 'PUBLIC_URL_REQUIRED'],
    ] as const) {
      Object.assign(where, { driver, publicBaseUrl: url });
      const { a, storage } = app();
      const res = await upload(a, 'editor/2026/10/abc.png');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ errors: [{ code }] });
      expect(storage.put).not.toHaveBeenCalled();
      const target = (await (await a.request('/editor-media/target')).json()) as { data: { available: boolean; reason: string } };
      expect(target.data).toMatchObject({ available: false, reason: code });
    }
  });

  it('go to S3-compatible storage with a public base URL, which gives the address', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allow);
    Object.assign(where, { driver: 's3', publicBaseUrl: 'https://img.example.com' });
    const { a, storage } = app();
    const res = await upload(a, 'editor/2026/10/abc.png');
    expect(res.status).toBe(201);
    expect(((await res.json()) as { data: { url: string } }).data.url).toBe('https://img.example.com/sites/site-a/media/editor/2026/10/abc.png');
    expect(storage.put).toHaveBeenCalledOnce();
    const target = (await (await a.request('/editor-media/target')).json()) as { data: Record<string, unknown> };
    // Images and videos the site accepts, without SVG (served as a download, never inline) or documents.
    expect(target.data).toMatchObject({ available: true, reason: null, prefix: 'editor/', types: ['image/png', 'image/jpeg', 'video/mp4'], maxBytes: 10 * 1024 * 1024, videoMaxBytes: 50 * 1024 * 1024 });
  });

  it('other media keys are not held to it (the media library keeps its storage)', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(allow);
    Object.assign(where, { driver: null, publicBaseUrl: null });
    const { a } = app();
    expect((await upload(a, 'library/logo.png')).status).toBe(201);
  });

  it('the target needs permission to create media', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue(null);
    expect((await app().a.request('/editor-media/target')).status).toBe(403);
  });
});
