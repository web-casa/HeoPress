import { describe, expect, it } from 'vitest';
import { scramVerifier } from '../scram';

/** The verifier PostgreSQL 18 stored for this password (`password_encryption = scram-sha-256`), recomputed with its salt. */
const FROM_POSTGRES =
  'SCRAM-SHA-256$4096:HiHRuLQzajR+8jJDpm/GeQ==$EgJZKM1TqPeqSkR5ao6cj7driWhAZt1q8JuqA+WnO2U=:Ue9owQFMi86rKxOIX6YMYb+k8EpVAoWTTjLNnRaMjbM=';

describe('scramVerifier', () => {
  it('matches what PostgreSQL computes for the same password and salt', () => {
    expect(scramVerifier('correct horse battery staple', { salt: Buffer.from('HiHRuLQzajR+8jJDpm/GeQ==', 'base64') })).toBe(FROM_POSTGRES);
  });

  it('never contains the password, and a fresh salt each time', () => {
    const a = scramVerifier('s3cret-value');
    expect(a).not.toContain('s3cret');
    expect(a).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(scramVerifier('s3cret-value')).not.toBe(a);
  });

  it('refuses what the server would normalise first: non-ASCII or empty passwords', () => {
    expect(() => scramVerifier('pässwort')).toThrow(/printable ASCII/);
    expect(() => scramVerifier('')).toThrow(/printable ASCII/);
  });
});
