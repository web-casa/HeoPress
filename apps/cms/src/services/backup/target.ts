import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { StorageProvider } from '@heopress/runtime';

/**
 * Where backups go (HeoPress P13 task 1.1; spec ops/backup-restore "一致备份与隔离恢复": local or object storage).
 *
 * Paths are plain relative paths (`backups/<id>/database/base/1/1259`): no `..`, no absolute path, no backslash.
 *   - `LocalDirTarget`: a directory; each path is a file, written to a temporary name first and renamed into place.
 *   - `ObjectStoreTarget`: any `StorageProvider` (S3, R2, OSS, COS, MinIO, SeaweedFS) under a prefix. A file larger
 *     than one part is stored as numbered parts (`<path>.part-00001`, …), so nothing larger than a part is ever held in
 *     memory; the manifest records how many.
 */
export interface BackupTarget {
  /** Where, without credentials: `local:/var/lib/heopress/backups`, `s3:bucket/prefix`. */
  readonly description: string;
  /** The local directory, for a local target (a key must not be kept inside it). */
  readonly localRoot: string | null;
  write(p: string, data: Readable | Buffer): Promise<{ parts: number }>;
  /** Read a file written with `parts` parts (1 when unknown). Rejects with `BackupObjectMissing` when absent. */
  read(p: string, parts?: number): Promise<Readable>;
  /** Every file under `prefix` (paths as written, parts folded). */
  list(prefix: string): Promise<string[]>;
  /** Remove everything under `prefix` (a directory-like prefix ending in `/`) or one file. */
  remove(prefixOrPath: string): Promise<void>;
}

export class BackupObjectMissing extends Error {
  constructor(readonly path: string) {
    super(`Backup object "${path}" is missing.`);
    this.name = 'BackupObjectMissing';
  }
}

export function isSafeTargetPath(p: string): boolean {
  if (!p || p.length > 2000 || p.includes('\\') || p.includes('\0') || p.startsWith('/')) return false;
  const segs = p.replace(/\/$/, '').split('/');
  return segs.every((s) => s !== '' && s !== '.' && s !== '..');
}

function assertPath(p: string): void {
  if (!isSafeTargetPath(p)) throw new Error(`Unsafe backup path "${p.slice(0, 200)}".`);
}

export class LocalDirTarget implements BackupTarget {
  readonly description: string;
  readonly localRoot: string;

  constructor(root: string) {
    this.localRoot = path.resolve(root);
    this.description = `local:${this.localRoot}`;
  }

  private full(p: string): string {
    assertPath(p);
    const f = path.resolve(this.localRoot, ...p.replace(/\/$/, '').split('/'));
    if (!f.startsWith(this.localRoot + path.sep)) throw new Error(`Unsafe backup path "${p.slice(0, 200)}".`);
    return f;
  }

  async write(p: string, data: Readable | Buffer): Promise<{ parts: number }> {
    const f = this.full(p);
    await mkdir(path.dirname(f), { recursive: true });
    const tmp = path.join(path.dirname(f), `.tmp-${randomUUID()}`);
    try {
      await pipeline(Buffer.isBuffer(data) ? Readable.from([data]) : data, createWriteStream(tmp, { mode: 0o600 }));
      await rename(tmp, f);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
    return { parts: 1 };
  }

  async read(p: string): Promise<Readable> {
    const f = this.full(p);
    const st = await stat(f).catch(() => null);
    if (!st?.isFile()) throw new BackupObjectMissing(p);
    return createReadStream(f);
  }

  async list(prefix: string): Promise<string[]> {
    const base = prefix ? this.full(prefix) : this.localRoot;
    const out: string[] = [];
    const walk = async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.name.startsWith('.tmp-')) continue;
        const f = path.join(dir, e.name);
        if (e.isDirectory()) await walk(f);
        else if (e.isFile()) out.push(path.relative(this.localRoot, f).split(path.sep).join('/'));
      }
    };
    const st = await stat(base).catch(() => null);
    if (st?.isFile()) return [path.relative(this.localRoot, base).split(path.sep).join('/')];
    if (st?.isDirectory()) await walk(base);
    return out.sort();
  }

  async remove(prefixOrPath: string): Promise<void> {
    await rm(this.full(prefixOrPath), { recursive: true, force: true });
  }
}

/** Default part size of an object-store target. */
const OBJECT_PART_BYTES = 32 * 1024 * 1024;
const PART = /\.part-(\d{5})$/;

export class ObjectStoreTarget implements BackupTarget {
  readonly description: string;
  readonly localRoot = null;
  private readonly prefix: string;

  constructor(
    private readonly storage: StorageProvider,
    opts: { description: string; prefix?: string; partBytes?: number },
  ) {
    this.prefix = (opts.prefix ?? '').replace(/^\/+|\/+$/g, '');
    if (this.prefix) assertPath(this.prefix);
    this.description = opts.description;
    this.partBytes = opts.partBytes ?? OBJECT_PART_BYTES;
  }

  private readonly partBytes: number;

  private key(p: string): string {
    assertPath(p);
    return this.prefix ? `${this.prefix}/${p}` : p;
  }

  async write(p: string, data: Readable | Buffer): Promise<{ parts: number }> {
    const key = this.key(p);
    const source = Buffer.isBuffer(data) ? Readable.from([data]) : data;
    const parts: Buffer[] = [];
    let partSize = 0;
    let written = 0;
    const flush = async (final: boolean) => {
      if (!final && partSize < this.partBytes) return;
      const all = Buffer.concat(parts);
      parts.length = 0;
      partSize = 0;
      let offset = 0;
      while (all.length - offset >= this.partBytes || (final && offset < all.length)) {
        const piece = all.subarray(offset, offset + this.partBytes);
        written++;
        await this.storage.put(`${key}.part-${String(written).padStart(5, '0')}`, Buffer.from(piece));
        offset += piece.length;
      }
      if (offset < all.length) {
        parts.push(all.subarray(offset));
        partSize = all.length - offset;
      }
    };
    for await (const chunk of source) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      parts.push(b);
      partSize += b.length;
      await flush(false);
    }
    // One part: stored under its own name. Several: numbered parts (the first already written as part 1).
    if (written === 0) {
      await this.storage.put(key, Buffer.concat(parts));
      return { parts: 1 };
    }
    await flush(true);
    return { parts: written };
  }

  async read(p: string, parts = 1): Promise<Readable> {
    const key = this.key(p);
    const get = async (k: string): Promise<Buffer> => {
      const obj = await this.storage.get(k);
      if (!obj) throw new BackupObjectMissing(p);
      return Buffer.isBuffer(obj.body) ? obj.body : Buffer.from(await new Response(obj.body).arrayBuffer());
    };
    // A file exactly one part long was written as part 1.
    if (parts <= 1) return Readable.from([await get(key).catch(async (err) => ((await this.storage.get(`${key}.part-00001`)) ? get(`${key}.part-00001`) : Promise.reject(err)))]);
    const out = new PassThrough();
    void (async () => {
      try {
        for (let i = 1; i <= parts; i++) {
          if (!out.write(await get(`${key}.part-${String(i).padStart(5, '0')}`))) await new Promise((r) => out.once('drain', r));
        }
        out.end();
      } catch (err) {
        out.destroy(err as Error);
      }
    })();
    return out;
  }

  async list(prefix: string): Promise<string[]> {
    const full = prefix ? this.key(prefix) : this.prefix;
    const { keys } = await this.storage.list(full);
    const strip = this.prefix ? this.prefix.length + 1 : 0;
    return [...new Set(keys.map((k) => k.slice(strip).replace(PART, '')))].sort();
  }

  async remove(prefixOrPath: string): Promise<void> {
    const full = this.key(prefixOrPath);
    const { keys } = await this.storage.list(full);
    for (const k of keys) {
      const rest = k.slice(full.length);
      // The path itself, its parts, or (for a prefix ending in "/") anything below it.
      if (rest === '' || PART.test(rest) || prefixOrPath.endsWith('/')) await this.storage.delete(k);
    }
  }
}

/** Read a whole (small) file. */
export async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}
