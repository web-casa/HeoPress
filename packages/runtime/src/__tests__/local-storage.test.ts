import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { InvalidStorageKeyError, LocalFileStorageProvider } from '../adapters/local/storage';
import { runStorageContract } from './helpers/storage-contract';

/**
 * Local filesystem storage (P03 task 4.2; spec "可切换的对象存储", scenario
 * "路径穿越"): the shared contract, plus traversal attacks that must never
 * read or write outside the storage root.
 */

const roots: string[] = [];
async function freshRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'heopress-storage-'));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  for (const r of roots) await fs.rm(r, { recursive: true, force: true });
});

runStorageContract('LocalFileStorageProvider', async () => new LocalFileStorageProvider(await freshRoot()));

describe('LocalFileStorageProvider — path traversal', () => {
  it.each([
    '../escape.txt',
    'site-a/../../escape.txt',
    'site-a/./x',
    '/etc/passwd',
    'site-a\\..\\escape.txt',
    'site-a//double',
    'site-a/\u0000.txt',
    '..',
    '',
  ])('refuses %j for put, get, delete and list never escapes', async (key) => {
    const root = await freshRoot();
    const store = new LocalFileStorageProvider(path.join(root, 'store'));
    await expect(store.put(key, Buffer.from('pwned'))).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(store.get(key)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(store.delete(key)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    // Nothing was written anywhere under the parent of the store.
    const written = await fs.readdir(root, { recursive: true });
    expect(written.filter((f) => String(f).includes('escape') || String(f).includes('pwned'))).toEqual([]);
  });

  it('does not follow a symbolic link planted inside the root', async () => {
    const root = await freshRoot();
    const outside = await freshRoot();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside the store');
    const store = new LocalFileStorageProvider(root);
    await store.put('site-a/ok.txt', Buffer.from('ok'));
    await fs.symlink(outside, path.join(root, 'objects', 'site-a', 'link'));
    await expect(store.get('site-a/link/secret.txt')).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(store.put('site-a/link/new.txt', Buffer.from('x'))).rejects.toBeInstanceOf(InvalidStorageKeyError);
    expect(await fs.readdir(outside)).toEqual(['secret.txt']);
  });

  it('refuses an objects directory that is a symbolic link (Codex review 3, #5)', async () => {
    const root = await freshRoot();
    const outside = await freshRoot();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside the store');
    await fs.symlink(outside, path.join(root, 'objects'));
    const store = new LocalFileStorageProvider(root);
    await expect(store.get('secret.txt')).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(store.put('new.txt', Buffer.from('x'))).rejects.toBeInstanceOf(InvalidStorageKeyError);
    await expect(store.delete('secret.txt')).rejects.toBeInstanceOf(InvalidStorageKeyError);
    expect(await fs.readdir(outside)).toEqual(['secret.txt']);
  });

  it('accepts a root that is itself a link, and refuses an object that is a link', async () => {
    const real = await freshRoot();
    const linkParent = await freshRoot();
    const outside = await freshRoot();
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside the store');
    await fs.symlink(real, path.join(linkParent, 'store'));
    const store = new LocalFileStorageProvider(path.join(linkParent, 'store'));
    await store.put('site-a/ok.txt', Buffer.from('ok'), { contentType: 'text/plain' });
    expect((await store.get('site-a/ok.txt'))!.body.toString()).toBe('ok');
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(real, 'objects', 'site-a', 'leak.txt'));
    await expect(store.get('site-a/leak.txt')).rejects.toBeInstanceOf(InvalidStorageKeyError);
    expect((await store.list()).keys).toEqual(['site-a/ok.txt']);
  });

  it('never pairs one write\'s bytes with another write\'s metadata (Codex review 3, #6)', async () => {
    const root = await freshRoot();
    const store = new LocalFileStorageProvider(root);
    for (let round = 0; round < 20; round++) {
      await Promise.all(
        ['A', 'B', 'C'].map((v) => store.put('site-a/img', Buffer.from(v.repeat(64 * 1024)), { contentHash: v })),
      );
      const got = (await store.get('site-a/img'))!;
      expect((got.body as Buffer).subarray(0, 1).toString()).toBe(got.metadata!.contentHash);
    }
  });

  it('writes atomically: no temporary files remain and readers see whole objects', async () => {
    const root = await freshRoot();
    const store = new LocalFileStorageProvider(root);
    const big = Buffer.alloc(2 * 1024 * 1024, 7);
    await Promise.all([store.put('site-a/big.bin', big), store.put('site-a/big.bin', big)]);
    const files = (await fs.readdir(root, { recursive: true })).map(String);
    expect(files.some((f) => f.includes('.tmp-'))).toBe(false);
    expect((await store.get('site-a/big.bin'))!.size).toBe(big.length);
  });
});
