import { randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import type { StorageObject, StorageProvider } from '../../interfaces';

/**
 * Local filesystem storage (HeoPress P03 task 4.2): the default for a minimal
 * deployment, no object store needed.
 *
 *   <root>/objects/<key>   one file per object: a small header with the
 *                          metadata (content type, user metadata), then the bytes
 *
 * Metadata and bytes live in one file and are replaced by one rename, so a
 * reader can never pair one write's bytes with another write's metadata
 * (Codex review 3, #6). Writes go to a temporary file in the same directory
 * first, so a reader never sees a partial object.
 *
 * Keys are validated before any path is built: absolute paths, `..` or `.`
 * segments, empty segments, backslashes, NUL and other control characters
 * are refused, and the resolved path must stay inside `<root>/objects`.
 * The configured root may itself be a symbolic link (resolved once); below
 * it, nothing is followed: `objects`, every directory on the way and the
 * object itself must not be links, objects are opened with O_NOFOLLOW, and
 * on Linux the opened file's real path is checked again (Codex review 3, #5).
 * Someone who can rewrite the storage directory while the server runs can
 * still race these checks; the directory must be writable by the server only.
 */
const MAGIC = Buffer.from('HPSO1\n');

function encodeObject(body: Buffer, metadata: Record<string, string>): Buffer {
  const meta = Buffer.from(JSON.stringify(metadata));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(meta.length);
  return Buffer.concat([MAGIC, len, meta, body]);
}

function decodeObject(raw: Buffer): { body: Buffer; metadata: Record<string, string> } {
  if (raw.length < MAGIC.length + 4 || !raw.subarray(0, MAGIC.length).equals(MAGIC)) return { body: raw, metadata: {} };
  const len = raw.readUInt32BE(MAGIC.length);
  const start = MAGIC.length + 4;
  let metadata: Record<string, string> = {};
  try {
    metadata = JSON.parse(raw.subarray(start, start + len).toString('utf8')) as Record<string, string>;
  } catch {
    metadata = {};
  }
  return { body: raw.subarray(start + len), metadata };
}

export class InvalidStorageKeyError extends Error {
  constructor(key: string, reason: string) {
    super(`invalid storage key ${JSON.stringify(key.slice(0, 200))}: ${reason}`);
    this.name = 'InvalidStorageKeyError';
  }
}

const MAX_KEY_LENGTH = 1024;

/** Validate a storage key; returns its path segments. */
function validateStorageKey(key: string): string[] {
  if (typeof key !== 'string' || key.length === 0) throw new InvalidStorageKeyError(String(key), 'empty');
  if (key.length > MAX_KEY_LENGTH) throw new InvalidStorageKeyError(key, 'too long');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new InvalidStorageKeyError(key, 'control characters');
  if (key.includes('\\')) throw new InvalidStorageKeyError(key, 'backslash');
  if (key.startsWith('/')) throw new InvalidStorageKeyError(key, 'absolute path');
  const segments = key.split('/');
  for (const segment of segments) {
    if (segment === '') throw new InvalidStorageKeyError(key, 'empty path segment');
    if (segment === '.' || segment === '..') throw new InvalidStorageKeyError(key, 'path traversal');
  }
  return segments;
}

export class LocalFileStorageProvider implements StorageProvider {
  private readonly rootDir: string;
  private objectsDirReady: Promise<string> | null = null;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
  }

  /** `<real root>/objects`, created on first use; refused if it is a link. */
  private objectsDir(): Promise<string> {
    this.objectsDirReady ??= (async () => {
      await fs.mkdir(this.rootDir, { recursive: true });
      const real = await fs.realpath(this.rootDir);
      const dir = path.join(real, 'objects');
      await fs.mkdir(dir, { recursive: true });
      const st = await fs.lstat(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new InvalidStorageKeyError('objects', 'storage directory is a symbolic link');
      return dir;
    })().catch((err) => {
      this.objectsDirReady = null;
      throw err;
    });
    return this.objectsDirReady;
  }

  private async resolve(key: string): Promise<{ base: string; target: string }> {
    const segments = validateStorageKey(key);
    const base = await this.objectsDir();
    const target = path.resolve(base, ...segments);
    if (!target.startsWith(base + path.sep)) throw new InvalidStorageKeyError(key, 'resolves outside the storage root');
    await this.assertNoSymlinks(base, target);
    return { base, target };
  }

  /** Refuse a path that crosses a symbolic link anywhere from `objects` down. */
  private async assertNoSymlinks(base: string, target: string): Promise<void> {
    const rel = path.relative(base, target);
    for (let dir = path.dirname(target); dir.startsWith(base); dir = path.dirname(dir)) {
      const st = await fs.lstat(dir).catch(() => null);
      if (st?.isSymbolicLink()) throw new InvalidStorageKeyError(rel, 'path crosses a symbolic link');
      if (dir === base) break;
    }
    const st = await fs.lstat(target).catch(() => null);
    if (st?.isSymbolicLink()) throw new InvalidStorageKeyError(rel, 'symbolic link');
  }

  /** On Linux, confirm where an open descriptor really points. */
  private async assertOpenedInside(fd: number, base: string, key: string): Promise<void> {
    const real = await fs.readlink(`/proc/self/fd/${fd}`).catch(() => null);
    if (real !== null && !real.startsWith(base + path.sep)) throw new InvalidStorageKeyError(key, 'resolves outside the storage root');
  }

  async put(key: string, data: ReadableStream | Buffer, metadata?: Record<string, string>): Promise<void> {
    const { base, target } = await this.resolve(key);
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(await new Response(data).arrayBuffer());
    await fs.mkdir(path.dirname(target), { recursive: true });
    await this.assertNoSymlinks(base, target);
    const tmp = path.join(path.dirname(target), `.tmp-${randomUUID()}`);
    try {
      const fh = await fs.open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o644);
      try {
        await this.assertOpenedInside(fh.fd, base, key);
        await fh.writeFile(encodeObject(bytes, metadata ?? {}));
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, target);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  async get(key: string): Promise<StorageObject | null> {
    const { base, target } = await this.resolve(key);
    let raw: Buffer;
    try {
      const fh = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        await this.assertOpenedInside(fh.fd, base, key);
        if (!(await fh.stat()).isFile()) return null;
        raw = await fh.readFile();
      } finally {
        await fh.close();
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null;
      if (code === 'ELOOP') throw new InvalidStorageKeyError(key, 'symbolic link');
      throw err;
    }
    const { body, metadata } = decodeObject(raw);
    return { key, body, contentType: metadata.contentType, size: body.byteLength, metadata };
  }

  async delete(key: string): Promise<void> {
    const { target } = await this.resolve(key);
    // rm on a path whose last component is a link removes the link, never its target.
    await fs.rm(target, { force: true });
  }

  async list(prefix = ''): Promise<{ keys: string[] }> {
    const base = await this.objectsDir();
    const keys: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.tmp-')) continue;
        const full = path.join(dir, entry.name);
        // Dirent types come from lstat: links are neither, so never walked.
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          const key = path.relative(base, full).split(path.sep).join('/');
          if (key.startsWith(prefix)) keys.push(key);
        }
      }
    };
    await walk(base);
    return { keys: keys.sort() };
  }
}
