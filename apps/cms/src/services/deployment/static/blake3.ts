/**
 * BLAKE3 (hash mode, 32-byte output), for Cloudflare Pages Direct Upload's asset keys (HeoPress P11 task 4.1): Wrangler
 * keys an asset by `blake3(base64(content) + extension)` in hex, first 32 characters. Node's crypto has no BLAKE3, and a
 * dependency for one function was not worth it; this is the reference algorithm (https://github.com/BLAKE3-team/BLAKE3,
 * CC0 / Apache-2.0 spec), checked against the official test vectors.
 */

const IV = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
const PERM = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const CHUNK_START = 1;
const CHUNK_END = 2;
const PARENT = 4;
const ROOT = 8;
const BLOCK = 64;
const CHUNK = 1024;

function g(s: Uint32Array, a: number, b: number, c: number, d: number, x: number, y: number): void {
  s[a] = (s[a]! + s[b]! + x) | 0;
  s[d] = rotr(s[d]! ^ s[a]!, 16);
  s[c] = (s[c]! + s[d]!) | 0;
  s[b] = rotr(s[b]! ^ s[c]!, 12);
  s[a] = (s[a]! + s[b]! + y) | 0;
  s[d] = rotr(s[d]! ^ s[a]!, 8);
  s[c] = (s[c]! + s[d]!) | 0;
  s[b] = rotr(s[b]! ^ s[c]!, 7);
}

const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

function compress(cv: Uint32Array, block: Uint32Array, counter: number, blockLen: number, flags: number): Uint32Array {
  const s = new Uint32Array(16);
  s.set(cv, 0);
  s.set(IV.subarray(0, 4), 8);
  s[12] = counter >>> 0;
  s[13] = Math.floor(counter / 0x100000000) >>> 0;
  s[14] = blockLen;
  s[15] = flags;
  let m = Uint32Array.from(block);
  for (let r = 0; r < 7; r++) {
    g(s, 0, 4, 8, 12, m[0]!, m[1]!);
    g(s, 1, 5, 9, 13, m[2]!, m[3]!);
    g(s, 2, 6, 10, 14, m[4]!, m[5]!);
    g(s, 3, 7, 11, 15, m[6]!, m[7]!);
    g(s, 0, 5, 10, 15, m[8]!, m[9]!);
    g(s, 1, 6, 11, 12, m[10]!, m[11]!);
    g(s, 2, 7, 8, 13, m[12]!, m[13]!);
    g(s, 3, 4, 9, 14, m[14]!, m[15]!);
    if (r < 6) m = Uint32Array.from(PERM, (p) => m[p]!);
  }
  for (let i = 0; i < 8; i++) {
    s[i] = (s[i]! ^ s[i + 8]!) >>> 0;
    s[i + 8] = (s[i + 8]! ^ cv[i]!) >>> 0;
  }
  return s;
}

function words(bytes: Uint8Array, off: number, len: number): Uint32Array {
  const buf = new Uint8Array(BLOCK);
  buf.set(bytes.subarray(off, off + len));
  const w = new Uint32Array(16);
  for (let i = 0; i < 16; i++) w[i] = (buf[i * 4]! | (buf[i * 4 + 1]! << 8) | (buf[i * 4 + 2]! << 16) | (buf[i * 4 + 3]! << 24)) >>> 0;
  return w;
}

interface Output {
  cv: Uint32Array;
  block: Uint32Array;
  counter: number;
  blockLen: number;
  flags: number;
}

/** The last block of a chunk, not yet compressed (it may be the root). */
function chunkOutput(input: Uint8Array, start: number, end: number, counter: number): Output {
  let cv: Uint32Array = IV;
  const len = end - start;
  const blocks = Math.max(1, Math.ceil(len / BLOCK));
  for (let i = 0; i < blocks - 1; i++) {
    cv = compress(cv, words(input, start + i * BLOCK, BLOCK), counter, BLOCK, i === 0 ? CHUNK_START : 0).subarray(0, 8);
  }
  const lastOff = (blocks - 1) * BLOCK;
  return { cv, block: words(input, start + lastOff, len - lastOff), counter, blockLen: len - lastOff, flags: (blocks === 1 ? CHUNK_START : 0) | CHUNK_END };
}

const chainOf = (o: Output) => compress(o.cv, o.block, o.counter, o.blockLen, o.flags).subarray(0, 8);

function parentOutput(left: Uint32Array, right: Uint32Array): Output {
  const block = new Uint32Array(16);
  block.set(left, 0);
  block.set(right, 8);
  return { cv: IV, block, counter: 0, blockLen: BLOCK, flags: PARENT };
}

function blake3(input: Uint8Array): Uint8Array {
  const chunks = Math.max(1, Math.ceil(input.length / CHUNK));
  let root: Output;
  if (chunks === 1) {
    root = chunkOutput(input, 0, input.length, 0);
  } else {
    // The chunk chaining values merged as the reference implementation's stack does (a left-complete tree).
    const stack: Uint32Array[] = [];
    for (let i = 0; i < chunks - 1; i++) {
      let cv = chainOf(chunkOutput(input, i * CHUNK, (i + 1) * CHUNK, i));
      let total = i + 1;
      while ((total & 1) === 0) {
        cv = chainOf(parentOutput(stack.pop()!, cv));
        total >>= 1;
      }
      stack.push(cv);
    }
    root = chunkOutput(input, (chunks - 1) * CHUNK, input.length, chunks - 1);
    while (stack.length) root = parentOutput(stack.pop()!, chainOf(root));
  }
  const out = compress(root.cv, root.block, 0, root.blockLen, root.flags | ROOT);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    bytes[i * 4] = out[i]! & 0xff;
    bytes[i * 4 + 1] = (out[i]! >>> 8) & 0xff;
    bytes[i * 4 + 2] = (out[i]! >>> 16) & 0xff;
    bytes[i * 4 + 3] = (out[i]! >>> 24) & 0xff;
  }
  return bytes;
}

export function blake3Hex(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return Buffer.from(blake3(bytes)).toString('hex');
}
