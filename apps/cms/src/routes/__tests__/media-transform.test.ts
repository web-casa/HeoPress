import { Hono } from 'hono';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { settings, transformPresets } from '@heopress/database';
import { signTransform } from '@heopress/contracts';
import { SharpMediaProcessor } from '@heopress/runtime/docker';
import { mediaRouter } from '../media';
import { PermissionService } from '../../services/permission-service';
import type { AppEnv } from '../../env';

// Storage profiles have their own DB suite (storage-profiles.db.integration.test.ts);
// here every object lives in the runtime's default storage, as for a site
// without a profile.
vi.mock('../storage-profiles', () => ({
  storageProfileServiceFor: (c: { get(k: string): unknown }) => {
    const runtime = c.get('runtime') as { storage: unknown };
    const siteId = c.get('siteId') as string;
    const at = (key: string) => ({ storage: runtime.storage, objectKey: `sites/${siteId}/media/${key}`, profileId: null, publicBaseUrl: null });
    return {
      readLocation: async (key: string) => at(key),
      writeLocation: async (key: string) => at(key),
      recordWrite: async () => {},
      recordDelete: async () => {},
      recordedKeys: async () => [],
    };
  },
}));

/**
 * Controlled image transforms (P03 task 4.3; spec "受控的图片转换"):
 * unsigned arbitrary sizes are refused (403), presets and signed parameters
 * are served by in-process sharp, sizes are capped, and a derivative is made
 * once and then served from storage.
 */

const SITE = 'site-a';
const SECRET = 'transform-signing-secret-0123456789';
let source: Buffer;

beforeAll(async () => {
  source = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3366cc' } }).png().toBuffer();
});

function memoryStorage() {
  const objects = new Map<string, { body: Buffer; metadata: Record<string, string> }>();
  return {
    objects,
    put: vi.fn(async (key: string, body: Buffer, metadata: Record<string, string> = {}) => {
      objects.set(key, { body, metadata });
    }),
    get: vi.fn(async (key: string) => {
      const o = objects.get(key);
      return o ? { key, body: o.body, contentType: o.metadata.contentType, size: o.body.length, metadata: o.metadata } : null;
    }),
    delete: vi.fn(async (key: string) => void objects.delete(key)),
    list: vi.fn(async (prefix = '') => ({ keys: [...objects.keys()].filter((k) => k.startsWith(prefix)) })),
  };
}

/** Answers the two lookups the route makes: the signing policy and presets. */
function dbStub(policy: Record<string, unknown> | null, presets: Record<string, unknown> = {}) {
  return {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === settings) return policy ? [{ value: policy }] : [];
            if (table === transformPresets) {
              const entries = Object.entries(presets);
              return entries.length ? [{ key: entries[0]![0], dsl: entries[0]![1] }] : [];
            }
            return [];
          },
        }),
      }),
    }),
  };
}

function setup(policy: Record<string, unknown> | null, presets: Record<string, unknown> = {}) {
  vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue({
    collection: 'media', action: 'read', rule: null, fields: ['*'], presets: {}, validation: {}, sources: [],
  } as never);
  const storage = memoryStorage();
  const media = new SharpMediaProcessor({ maxDimension: 1000 });
  const transform = vi.spyOn(media, 'transform');
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('siteId', SITE);
    c.set('auth', { userId: 'u', email: 'u@example.test', roles: [], raw: {} });
    c.set('db', dbStub(policy, presets) as never);
    c.set('runtime', { storage, media, cache: undefined } as never);
    await next();
  });
  app.route('/media', mediaRouter);
  return { app, storage, transform };
}

async function seed(storage: ReturnType<typeof memoryStorage>) {
  // Same key layout as uploads: storageKey(siteId, key) = sites/<site>/media/<key>.
  await storage.put(`sites/${SITE}/media/photo.png`, source, { contentType: 'image/png' });
}

afterEach(() => vi.restoreAllMocks());

describe('media transforms', () => {
  it('refuses an unsigned arbitrary size with 403, with or without a site secret', async () => {
    for (const policy of [null, { secret: SECRET }, { enabled: false }]) {
      const { app, storage, transform } = setup(policy);
      await seed(storage);
      const res = await app.request('/media/photo.png?width=500&height=500');
      expect(res.status, JSON.stringify(policy)).toBe(403);
      expect(transform).not.toHaveBeenCalled();
    }
  });

  it('serves a signed transform, then the same derivative from storage without transforming again', async () => {
    const { app, storage, transform } = setup({ secret: SECRET });
    await seed(storage);
    const dsl = { width: 32, height: 24, format: 'webp' as const };
    const sig = await signTransform(SECRET, 'photo.png', dsl);
    const url = `/media/photo.png?width=32&height=24&format=webp&sig=${encodeURIComponent(sig)}`;

    const first = await app.request(url);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/webp');
    expect(first.headers.get('x-transform-cache')).toBe('miss');
    const meta = await sharp(Buffer.from(await first.arrayBuffer())).metadata();
    expect([meta.width, meta.height]).toEqual([32, 24]);

    const second = await app.request(url);
    expect(second.status).toBe(200);
    expect(second.headers.get('x-transform-cache')).toBe('hit');
    expect(transform).toHaveBeenCalledTimes(1);
    expect([...storage.objects.keys()].some((k) => k.startsWith('derived/'))).toBe(true);
  });

  it('serves a preset without a signature', async () => {
    const { app, storage } = setup(null, { thumb: { width: 16, height: 16, format: 'png' } });
    await seed(storage);
    const res = await app.request('/media/photo.png?preset=thumb');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
  });

  it('rejects a signed size above the configured maximum', async () => {
    const { app, storage, transform } = setup({ secret: SECRET });
    await seed(storage);
    const dsl = { width: 5000 };
    const sig = await signTransform(SECRET, 'photo.png', dsl);
    const res = await app.request(`/media/photo.png?width=5000&sig=${encodeURIComponent(sig)}`);
    expect([400, 403]).toContain(res.status);
    expect(transform).not.toHaveBeenCalled();
  });

  it('refuses a result larger than the maximum, whatever the parameters asked for (Codex review 3, #7)', async () => {
    const { app, storage, transform } = setup({ secret: SECRET });
    const tall = await sharp({ create: { width: 10, height: 3000, channels: 3, background: '#000' } }).png().toBuffer();
    const wide = await sharp({ create: { width: 1500, height: 10, channels: 3, background: '#000' } }).png().toBuffer();
    await storage.put(`sites/${SITE}/media/tall.png`, tall, { contentType: 'image/png' });
    await storage.put(`sites/${SITE}/media/wide.png`, wide, { contentType: 'image/png' });
    // width 5 on a 10×3000 image → 5×1500: the height follows from the aspect ratio.
    const byWidth = await signTransform(SECRET, 'tall.png', { width: 5 });
    expect((await app.request(`/media/tall.png?width=5&sig=${encodeURIComponent(byWidth)}`)).status).toBe(422);
    // A format-only conversion keeps the source size, here 1500 wide.
    const formatOnly = await signTransform(SECRET, 'wide.png', { format: 'webp' });
    expect((await app.request(`/media/wide.png?format=webp&sig=${encodeURIComponent(formatOnly)}`)).status).toBe(422);
    expect(transform).toHaveBeenCalledTimes(2);
    expect([...storage.objects.keys()].some((k) => k.startsWith('derived/'))).toBe(false);
  });

  it('presetOnly refuses even a correctly signed custom transform', async () => {
    const { app, storage } = setup({ secret: SECRET, presetOnly: true });
    await seed(storage);
    const sig = await signTransform(SECRET, 'photo.png', { width: 32 });
    expect((await app.request(`/media/photo.png?width=32&sig=${encodeURIComponent(sig)}`)).status).toBe(403);
  });

  it('deleting the source removes its cached derivatives', async () => {
    vi.spyOn(PermissionService.prototype, 'canAccess').mockResolvedValue({ collection: 'media', action: 'delete' } as never);
    const { app, storage } = setup({ secret: SECRET });
    await seed(storage);
    const sig = await signTransform(SECRET, 'photo.png', { width: 32 });
    await app.request(`/media/photo.png?width=32&sig=${encodeURIComponent(sig)}`);
    expect([...storage.objects.keys()].some((k) => k.startsWith('derived/'))).toBe(true);
    await app.request('/media/photo.png', { method: 'DELETE' });
    expect([...storage.objects.keys()].some((k) => k.startsWith('derived/'))).toBe(false);
  });
});
