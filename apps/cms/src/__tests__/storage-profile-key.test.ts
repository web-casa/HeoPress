import { describe, expect, it } from 'vitest';
import type { Database } from '@heopress/database';
import type { KeyProvider, StorageProvider } from '@heopress/runtime';
import { StorageProfileError, StorageProfileService } from '../services/storage/storage-profile-service';

/**
 * Without the instance encryption key a storage secret can be neither
 * sealed nor opened: creating or changing it and testing the profile answer
 * what to configure (503 ENCRYPTION_NOT_CONFIGURED) — not an internal error,
 * and not a "connection failed" result (HeoPress P04 task 6.3; Codex review
 * P04-15 #1).
 */
describe('storage profile secrets without the encryption key', () => {
  const missing = async (): Promise<never> => {
    throw new Error("KeyProvider: no encryption key configured for keyId 'v0'");
  };
  const noKey = { getActiveKey: missing, getKey: missing, listKeys: async () => [] } as unknown as KeyProvider;
  const s3Row = {
    id: 'sp_1',
    siteId: 'site_a',
    name: 'S3',
    driver: 's3',
    bucket: 'media',
    endpoint: null,
    region: null,
    forcePathStyle: null,
    accessKeyId: 'AKIA',
    secretCiphertext: 'v0:c2VhbGVk',
    publicBaseUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const service = () => {
    const svc = new StorageProfileService({
      db: {} as Database, // never reached before the key is needed
      siteId: 'site_a',
      keys: noKey,
      defaultStorage: {} as StorageProvider,
    });
    (svc as unknown as { row: () => Promise<typeof s3Row> }).row = async () => s3Row;
    return svc;
  };
  const expectKeyError = (err: unknown) => {
    expect(err).toBeInstanceOf(StorageProfileError);
    expect(err).toMatchObject({ code: 'ENCRYPTION_NOT_CONFIGURED', status: 503 });
    expect((err as Error).message).toMatch(/ENCRYPTION_KEY/);
  };

  it('creating an S3 profile', async () => {
    expectKeyError(
      await service()
        .create({ name: 'S3', driver: 's3', bucket: 'media', accessKeyId: 'AKIA', secretAccessKey: 'secret' })
        .catch((e: unknown) => e),
    );
  });

  it('changing its secret', async () => {
    expectKeyError(await service().update('sp_1', { secretAccessKey: 'new-secret' }).catch((e: unknown) => e));
  });

  it('testing its connection: the setting is reported, not a failed connection', async () => {
    expectKeyError(await service().test('sp_1').catch((e: unknown) => e));
  });
});
