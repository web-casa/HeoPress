import { describe, expect, it } from 'vitest';
import type { StorageProvider } from '../../interfaces/storage';

/**
 * StorageProvider contract shared by every backend (P03 tasks 4.1–4.2):
 * local filesystem in local-storage.test.ts, MinIO in s3-storage.minio.test.ts.
 * `make` returns a fresh, empty store for each case.
 */
export function runStorageContract(name: string, make: () => Promise<StorageProvider>): void {
  const text = async (body: ReadableStream | Buffer) => Buffer.isBuffer(body) ? body.toString('utf8') : await new Response(body).text();

  describe(`StorageProvider contract — ${name}`, () => {
    it('round-trips bytes, content type and metadata', async () => {
      const store = await make();
      await store.put('site-a/media/hello.txt', Buffer.from('hello'), { contentType: 'text/plain', owner: 'site-a' });
      const obj = await store.get('site-a/media/hello.txt');
      expect(obj).not.toBeNull();
      expect(await text(obj!.body)).toBe('hello');
      expect(obj!.contentType).toBe('text/plain');
      expect(obj!.metadata?.owner).toBe('site-a');
    });

    it('accepts a stream', async () => {
      const store = await make();
      await store.put('site-a/media/stream.bin', new Blob(['from a stream']).stream() as never);
      expect(await text((await store.get('site-a/media/stream.bin'))!.body)).toBe('from a stream');
    });

    it('returns null for a missing key, and after delete', async () => {
      const store = await make();
      expect(await store.get('site-a/nothing-here')).toBeNull();
      await store.put('site-a/media/gone.txt', Buffer.from('x'));
      await store.delete('site-a/media/gone.txt');
      expect(await store.get('site-a/media/gone.txt')).toBeNull();
      await store.delete('site-a/media/never-existed.txt'); // idempotent
    });

    it('overwrites an existing key', async () => {
      const store = await make();
      await store.put('site-a/media/v.txt', Buffer.from('one'));
      await store.put('site-a/media/v.txt', Buffer.from('two'));
      expect(await text((await store.get('site-a/media/v.txt'))!.body)).toBe('two');
    });

    it('lists by prefix', async () => {
      const store = await make();
      for (const k of ['site-a/media/1.jpg', 'site-a/media/2.jpg', 'site-b/media/1.jpg']) await store.put(k, Buffer.from(k));
      expect((await store.list('site-a/')).keys.sort()).toEqual(['site-a/media/1.jpg', 'site-a/media/2.jpg']);
      expect((await store.list('site-b/')).keys).toEqual(['site-b/media/1.jpg']);
    });
  });
}
