import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { S3StorageProvider } from '../adapters/docker/storage';
import { parseTrustedEndpoints } from '../outbound/fetch';
import { runStorageContract } from './helpers/storage-contract';

/**
 * S3 adapter against a real S3-compatible store (P03 task 4.1). Runs when
 * HEOPRESS_TEST_S3_ENDPOINT is set: CI starts SeaweedFS with an identity file
 * (MinIO images are no longer freely pullable; the file name stayed). The
 * credentials default to MinIO's minioadmin. The endpoint is internal, so it
 * must be listed as a trusted internal endpoint — the same rule as
 * production. HEOPRESS_TEST_S3_REQUIRE_AUTH=1 also checks that the store
 * refuses a wrong secret (SeaweedFS without an identity file accepts any).
 */

const ENDPOINT = process.env.HEOPRESS_TEST_S3_ENDPOINT?.trim() || undefined;
const ACCESS = process.env.HEOPRESS_TEST_S3_ACCESS_KEY ?? 'minioadmin';
const SECRET = process.env.HEOPRESS_TEST_S3_SECRET_KEY ?? 'minioadmin';
const REQUIRE_AUTH = process.env.HEOPRESS_TEST_S3_REQUIRE_AUTH === '1';
const BUCKET = `heopress-test-${randomUUID().slice(0, 8)}`;

describe.skipIf(!ENDPOINT)('S3StorageProvider against an S3-compatible store', () => {
  const trusted = parseTrustedEndpoints(ENDPOINT ? new URL(ENDPOINT).origin : '');

  beforeAll(async () => {
    const admin = new S3Client({ endpoint: ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId: ACCESS, secretAccessKey: SECRET } });
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
  });

  let n = 0;
  runStorageContract('S3StorageProvider (MinIO)', async () => {
    // A fresh prefix per case keeps cases independent in one bucket.
    const store = new S3StorageProvider({ endpoint: ENDPOINT, accessKeyId: ACCESS, secretAccessKey: SECRET, bucket: BUCKET, trusted });
    const prefix = `case-${++n}/`;
    return {
      put: (k, d, m) => store.put(prefix + k, d, m),
      get: async (k) => {
        const o = await store.get(prefix + k);
        return o && { ...o, key: k };
      },
      delete: (k) => store.delete(prefix + k),
      list: async (p) => ({ keys: (await store.list(prefix + (p ?? ''))).keys.map((k) => k.slice(prefix.length)) }),
    };
  });

  it('refuses the same MinIO when its origin is not trusted', async () => {
    expect(
      () => new S3StorageProvider({ endpoint: ENDPOINT, accessKeyId: ACCESS, secretAccessKey: SECRET, bucket: BUCKET, trusted: parseTrustedEndpoints('') }),
    ).toThrow(/blocked/);
  });

  it.skipIf(!REQUIRE_AUTH)('the store refuses a wrong secret', async () => {
    const store = new S3StorageProvider({ endpoint: ENDPOINT, accessKeyId: ACCESS, secretAccessKey: `${SECRET}-wrong`, bucket: BUCKET, trusted });
    await expect(store.put('refused.txt', Buffer.from('x'))).rejects.toThrow();
  });
});
