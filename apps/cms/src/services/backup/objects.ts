import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { decryptStream, encryptStream, hashingStream } from './crypto';
import type { BackupTarget } from './target';

/**
 * Writing and reading backup objects (HeoPress P13 task 1.1): every object is hashed as it is (`sha256`) and as stored
 * (`storedSha256`, after encryption), so a drill finds a corrupted object without the key and a wrong or altered one
 * with it. Reading checks both hashes at the end of the stream and fails the stream on a mismatch.
 */

export interface StoredObject {
  size: number;
  sha256: string;
  storedSize: number;
  storedSha256: string;
  parts: number;
}

export async function storeObject(target: BackupTarget, p: string, source: Readable | Buffer, key: Buffer | null): Promise<StoredObject> {
  const plain = hashingStream();
  const stored = hashingStream();
  const src = Buffer.isBuffer(source) ? Readable.from([source]) : source;
  const stages = key ? [src, plain, encryptStream(key), stored] : [src, plain, stored];
  const [, written] = await Promise.all([(pipeline as (...s: unknown[]) => Promise<void>)(...stages), target.write(p, stored)]);
  const a = plain.digest();
  const b = stored.digest();
  return { size: a.size, sha256: a.sha256, storedSize: b.size, storedSha256: b.sha256, parts: written.parts };
}

export class ObjectHashMismatch extends Error {
  constructor(
    readonly path: string,
    readonly which: 'stored' | 'content',
  ) {
    super(which === 'stored' ? `"${path}" does not match its recorded SHA-256 (as stored).` : `"${path}" does not match its recorded SHA-256.`);
    this.name = 'ObjectHashMismatch';
  }
}

/** The content of an object, checked against its recorded hashes (the stream errors on a mismatch). */
export async function openObject(
  target: BackupTarget,
  p: string,
  expect: Pick<StoredObject, 'sha256' | 'storedSha256' | 'parts'>,
  key: Buffer | null,
): Promise<Readable> {
  const raw = await target.read(p, expect.parts);
  const stored = hashingStream();
  const plain = hashingStream();
  const check = new Transform({
    transform(chunk, _enc, cb) {
      cb(null, chunk);
    },
    flush(cb) {
      if (stored.digest().sha256 !== expect.storedSha256) return cb(new ObjectHashMismatch(p, 'stored'));
      if (plain.digest().sha256 !== expect.sha256) return cb(new ObjectHashMismatch(p, 'content'));
      cb();
    },
  });
  const out = new PassThrough();
  const stages = key ? [raw, stored, decryptStream(key), plain, check, out] : [raw, stored, plain, check, out];
  (pipeline as (...s: unknown[]) => Promise<void>)(...stages).catch((err: Error) => out.destroy(err));
  return out;
}

/** Copy an object's checked content to a local file. */
export async function fetchObjectTo(target: BackupTarget, p: string, expect: Pick<StoredObject, 'sha256' | 'storedSha256' | 'parts'>, key: Buffer | null, file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await pipeline(await openObject(target, p, expect, key), createWriteStream(file, { mode: 0o600 }));
}

/** An object's checked content in memory (small objects: manifests' companions, configuration, media). */
export async function readObject(target: BackupTarget, p: string, expect: Pick<StoredObject, 'sha256' | 'storedSha256' | 'parts'>, key: Buffer | null): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of await openObject(target, p, expect, key)) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}
