import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * Backup encryption (HeoPress P13 task 1.1; spec ops/backup-restore "带清单的定时备份", "一致备份与隔离恢复").
 *
 * AES-256-GCM in a chunked stream, so a file of any size (a 1 GB table segment) is encrypted without holding it in
 * memory. Each file gets its own key, derived with HKDF from the backup key and a random 32-byte salt kept in the file
 * header, so nonces (the chunk counter) never repeat under one key. Every chunk is authenticated with the header, its
 * index and whether it is the last: a reordered, dropped or truncated chunk fails, as does a wrong key.
 *
 *   header  "HPBK" | version 1 | chunk size (u32 BE) | salt (32 bytes)
 *   chunk   ciphertext (chunk size, the last one shorter or empty) | tag (16 bytes)
 *
 * The backup key is a file the operator keeps apart from the backups (`HEOPRESS_BACKUP_ENCRYPTION_KEY_FILE`): 32 bytes,
 * raw or as hex or base64 text. It is never written to the backup target; a manifest names it only by its key id.
 */

const MAGIC = Buffer.from('HPBK');
const VERSION = 1;
const HEADER_BYTES = MAGIC.length + 1 + 4 + 32;
const TAG_BYTES = 16;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;

export class BackupKeyError extends Error {
  constructor(
    readonly code: 'KEY_UNREADABLE' | 'KEY_INVALID' | 'KEY_BESIDE_BACKUPS' | 'KEY_REQUIRED' | 'KEY_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'BackupKeyError';
  }
}

/** Parse a key file's contents: 32 raw bytes, 64 hex characters or 32 bytes in base64. */
export function parseBackupKey(raw: Buffer): Buffer {
  const text = raw.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(text)) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(text)) {
    const b = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) return b;
  }
  if (raw.length === 32) return Buffer.from(raw);
  throw new BackupKeyError('KEY_INVALID', 'The backup key must be 32 bytes: raw, 64 hex characters, or base64.');
}

/**
 * Read the backup key from its file. With `notInside`, refuse a key file inside that directory (the local backup
 * target): the key must not be stored where the backups are.
 */
export async function loadBackupKey(file: string, notInside?: string | null): Promise<Buffer> {
  const abs = path.resolve(file);
  if (notInside) {
    const dir = path.resolve(notInside);
    if (abs === dir || abs.startsWith(dir + path.sep)) {
      throw new BackupKeyError('KEY_BESIDE_BACKUPS', 'The backup key file is inside the backup directory; keep it somewhere else.');
    }
  }
  const st = await stat(abs).catch(() => null);
  if (!st?.isFile()) throw new BackupKeyError('KEY_UNREADABLE', 'The backup key file cannot be read.');
  return parseBackupKey(await readFile(abs));
}

/** The key's public name: recorded in manifests, so a restore can tell a wrong key before decrypting anything. */
export function backupKeyId(key: Buffer): string {
  return createHash('sha256').update('heopress-backup-key-id\0').update(key).digest('hex').slice(0, 16);
}

/** The name a media blob is stored under: its content hash, keyed when encrypted (no plaintext hash in the target). */
export function blobName(sha256: string, key: Buffer | null): string {
  return key ? createHmac('sha256', key).update(`media-blob\0${sha256}`).digest('hex') : sha256;
}

/** MAC of a manifest's bytes under the backup key. */
export function manifestMac(key: Buffer, bytes: Buffer): string {
  return createHmac('sha256', key).update('heopress-backup-manifest\0').update(bytes).digest('hex');
}

export function macMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(actual, 'hex');
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function fileKey(key: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', key, salt, 'heopress-backup-file-v1', 32));
}

function nonceOf(index: number): Buffer {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(index), 4);
  return n;
}

function aadOf(header: Buffer, index: number, last: boolean): Buffer {
  const b = Buffer.alloc(9);
  b.writeBigUInt64BE(BigInt(index), 0);
  b[8] = last ? 1 : 0;
  return Buffer.concat([header, b]);
}

/** A stream that encrypts what passes through it. */
export function encryptStream(key: Buffer, chunkBytes = DEFAULT_CHUNK_BYTES): Transform {
  const salt = randomBytes(32);
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header, 0);
  header[4] = VERSION;
  header.writeUInt32BE(chunkBytes, 5);
  salt.copy(header, 9);
  const k = fileKey(key, salt);
  let index = 0;
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let headerSent = false;
  const seal = (plain: Buffer, last: boolean): Buffer => {
    const c = createCipheriv('aes-256-gcm', k, nonceOf(index));
    c.setAAD(aadOf(header, index, last));
    const out = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    index++;
    return out;
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      if (!headerSent) {
        this.push(header);
        headerSent = true;
      }
      pending.push(chunk);
      pendingBytes += chunk.length;
      // Keep at least one byte back: the last chunk is only known at the end.
      while (pendingBytes > chunkBytes) {
        const all = Buffer.concat(pending);
        this.push(seal(all.subarray(0, chunkBytes), false));
        const rest = all.subarray(chunkBytes);
        pending = [rest];
        pendingBytes = rest.length;
      }
      cb();
    },
    flush(cb: TransformCallback) {
      if (!headerSent) this.push(header);
      this.push(seal(Buffer.concat(pending), true));
      cb();
    },
  });
}

/** A stream that decrypts (and authenticates) what `encryptStream` wrote; fails on a wrong key or altered bytes. */
export function decryptStream(key: Buffer): Transform {
  let header: Buffer | null = null;
  let k: Buffer | null = null;
  let chunkBytes = 0;
  let index = 0;
  let buf: Buffer = Buffer.alloc(0);
  const open = (sealed: Buffer, last: boolean): Buffer => {
    if (sealed.length < TAG_BYTES) throw new Error('The encrypted file is truncated.');
    const d = createDecipheriv('aes-256-gcm', k!, nonceOf(index));
    d.setAAD(aadOf(header!, index, last));
    d.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const out = Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG_BYTES)), d.final()]);
    index++;
    return out;
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        if (!header) {
          if (buf.length < HEADER_BYTES) return cb();
          header = Buffer.from(buf.subarray(0, HEADER_BYTES));
          if (!header.subarray(0, 4).equals(MAGIC) || header[4] !== VERSION) throw new Error('Not an encrypted backup file.');
          chunkBytes = header.readUInt32BE(5);
          if (chunkBytes < 1 || chunkBytes > 64 * 1024 * 1024) throw new Error('Not an encrypted backup file.');
          k = fileKey(key, header.subarray(9, 41));
          buf = buf.subarray(HEADER_BYTES);
        }
        const sealedBytes = chunkBytes + TAG_BYTES;
        while (buf.length > sealedBytes) {
          this.push(open(buf.subarray(0, sealedBytes), false));
          buf = buf.subarray(sealedBytes);
        }
        cb();
      } catch {
        cb(new BackupKeyError('KEY_MISMATCH', 'The file could not be decrypted: wrong key, or the file was altered.'));
      }
    },
    flush(cb: TransformCallback) {
      try {
        if (!header) throw new Error('truncated');
        this.push(open(buf, true));
        cb();
      } catch {
        cb(new BackupKeyError('KEY_MISMATCH', 'The file could not be decrypted: wrong key, or the file was altered.'));
      }
    },
  });
}

/** A pass-through that counts bytes and hashes them. */
export function hashingStream(): Transform & { digest(): { sha256: string; size: number } } {
  const h = createHash('sha256');
  let size = 0;
  let done: string | null = null;
  const t = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      h.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  }) as Transform & { digest(): { sha256: string; size: number } };
  t.digest = () => {
    done ??= h.digest('hex');
    return { sha256: done, size };
  };
  return t;
}
