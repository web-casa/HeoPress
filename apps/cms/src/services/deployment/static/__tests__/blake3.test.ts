import { describe, expect, it } from 'vitest';
import { blake3Hex } from '../blake3';

/** The official BLAKE3 test vectors (input byte i is i % 251), hash mode, 32 bytes. */
const VECTORS: Array<[number, string]> = [
  [0, 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'],
  [1, '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213'],
  [1023, '10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11'],
  [1024, '42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7'],
  [1025, 'd00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444'],
  [2048, 'e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a'],
  [3073, '7124b49501012f81cc7f11ca069ec9226cecb8a2c850cfe644e327d22d3e1cd3'],
  [102400, 'bc3e3d41a1146b069abffad3c0d44860cf664390afce4d9661f7902e7943e085'],
];

describe('BLAKE3 (Cloudflare Pages asset keys, P11 task 4.1)', () => {
  it.each(VECTORS)('input of %i bytes', (n, hex) => {
    expect(blake3Hex(Uint8Array.from({ length: n }, (_, i) => i % 251))).toBe(hex);
  });
});
