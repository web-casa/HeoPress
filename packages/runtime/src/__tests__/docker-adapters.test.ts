// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock @aws-sdk/client-s3 ────────────────────────────────────────────────

const mockS3Send = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(function () {
    return { send: mockS3Send };
  }),
  PutObjectCommand: vi.fn(function (input: unknown) {
    return { _type: 'PutObject', input };
  }),
  GetObjectCommand: vi.fn(function (input: unknown) {
    return { _type: 'GetObject', input };
  }),
  DeleteObjectCommand: vi.fn(function (input: unknown) {
    return { _type: 'DeleteObject', input };
  }),
  ListObjectsV2Command: vi.fn(function (input: unknown) {
    return { _type: 'ListObjectsV2', input };
  }),
}));

// ─── Mock meilisearch ───────────────────────────────────────────────────────

const mockIndex = {
  addDocuments: vi.fn(),
  search: vi.fn(),
  deleteDocuments: vi.fn(),
  getStats: vi.fn(),
};

const mockMeiliClient = {
  index: vi.fn(() => mockIndex),
};

// meilisearch >=0.50 renamed the client export to `Meilisearch` (lowercase s).
vi.mock('meilisearch', () => ({
  Meilisearch: vi.fn(function () {
    return mockMeiliClient;
  }),
}));

// ─── Import adapters after mocks ────────────────────────────────────────────

import { S3Client } from '@aws-sdk/client-s3';
import { S3StorageProvider } from '../adapters/docker/storage';
import { MeiliSearchProvider } from '../adapters/docker/search';
// ═══════════════════════════════════════════════════════════════════════════════
// S3 Storage Provider Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('S3StorageProvider configuration (P03 task 4.1)', () => {
  const creds = { accessKeyId: 'a', secretAccessKey: 'b', bucket: 'media' };
  const clientConfig = () => (vi.mocked(S3Client).mock.calls.at(-1)![0] as Record<string, unknown>);

  it('uses path-style addressing with a custom endpoint and virtual-hosted style for AWS', () => {
    new S3StorageProvider({ ...creds, endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto' });
    expect(clientConfig()).toMatchObject({ endpoint: 'https://acc.r2.cloudflarestorage.com', region: 'auto', forcePathStyle: true });
    new S3StorageProvider({ ...creds });
    expect(clientConfig()).toMatchObject({ endpoint: undefined, forcePathStyle: false });
  });

  it('honours an explicit addressing style (OSS / COS need virtual-hosted)', () => {
    new S3StorageProvider({ ...creds, endpoint: 'https://oss-cn-hangzhou.aliyuncs.com', region: 'oss-cn-hangzhou', forcePathStyle: false });
    expect(clientConfig()).toMatchObject({ forcePathStyle: false });
  });

  it('refuses an internal endpoint unless its origin is trusted', async () => {
    const { parseTrustedEndpoints } = await import('../outbound/fetch');
    expect(() => new S3StorageProvider({ ...creds, endpoint: 'http://10.0.0.5:9000', trusted: parseTrustedEndpoints('') })).toThrow(/blocked/);
    expect(() => new S3StorageProvider({ ...creds, endpoint: 'http://169.254.169.254', trusted: parseTrustedEndpoints('http://169.254.169.254') })).toThrow(/metadata/);
    expect(() => new S3StorageProvider({ ...creds, endpoint: 'http://10.0.0.5:9000', trusted: parseTrustedEndpoints('http://10.0.0.5:9000') })).not.toThrow();
  });
});

describe('S3StorageProvider', () => {
  let provider: S3StorageProvider;

  const config = {
    endpoint: 'https://s3.example.com',
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    bucket: 'test-bucket',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new S3StorageProvider(config);
  });

  describe('put', () => {
    it('should upload a Buffer to S3', async () => {
      mockS3Send.mockResolvedValue({});
      const data = Buffer.from('hello world');

      await provider.put('test-key', data);

      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Bucket: 'test-bucket',
            Key: 'test-key',
            Body: data,
            Metadata: undefined,
          },
        }),
      );
    });

    it('should upload with metadata', async () => {
      mockS3Send.mockResolvedValue({});
      const data = Buffer.from('content');
      const metadata = { 'content-type': 'text/plain' };

      await provider.put('meta-key', data, metadata);

      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Bucket: 'test-bucket',
            Key: 'meta-key',
            Body: data,
            Metadata: metadata,
          },
        }),
      );
    });

    it('maps contentType onto the native ContentType field', async () => {
      mockS3Send.mockResolvedValue({});
      const data = Buffer.from('img');

      await provider.put('photo.png', data, { contentType: 'image/png' });

      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Bucket: 'test-bucket',
            Key: 'photo.png',
            Body: data,
            Metadata: { contentType: 'image/png' },
            ContentType: 'image/png',
          },
        }),
      );
    });
  });

  describe('get', () => {
    it('should return StorageObject when key exists', async () => {
      const bodyContent = Buffer.from('file content');
      mockS3Send.mockResolvedValue({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array(bodyContent)),
        },
        ContentType: 'text/plain',
        ContentLength: bodyContent.length,
        Metadata: { custom: 'value' },
      });

      const result = await provider.get('existing-key');

      expect(result).not.toBeNull();
      expect(result!.key).toBe('existing-key');
      expect(result!.contentType).toBe('text/plain');
      expect(result!.size).toBe(bodyContent.length);
      expect(result!.metadata).toEqual({ custom: 'value' });
      expect(Buffer.from(result!.body as Buffer)).toEqual(bodyContent);
    });

    it('should return null when response body is empty', async () => {
      mockS3Send.mockResolvedValue({
        Body: null,
      });

      const result = await provider.get('empty-body-key');

      expect(result).toBeNull();
    });

    it('should return null when key does not exist (NoSuchKey error)', async () => {
      const error = new Error('NoSuchKey');
      error.name = 'NoSuchKey';
      mockS3Send.mockRejectedValue(error);

      const result = await provider.get('nonexistent-key');

      expect(result).toBeNull();
    });

    it('should throw for non-NoSuchKey errors', async () => {
      const error = new Error('AccessDenied');
      error.name = 'AccessDenied';
      mockS3Send.mockRejectedValue(error);

      await expect(provider.get('forbidden-key')).rejects.toThrow('AccessDenied');
    });
  });

  describe('delete', () => {
    it('should send DeleteObjectCommand', async () => {
      mockS3Send.mockResolvedValue({});

      await provider.delete('key-to-delete');

      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: {
            Bucket: 'test-bucket',
            Key: 'key-to-delete',
          },
        }),
      );
    });
  });

  describe('list', () => {
    it('should return all keys with given prefix', async () => {
      mockS3Send.mockResolvedValue({
        Contents: [{ Key: 'prefix/file1.txt' }, { Key: 'prefix/file2.txt' }],
        IsTruncated: false,
      });

      const result = await provider.list('prefix/');

      expect(result.keys).toEqual(['prefix/file1.txt', 'prefix/file2.txt']);
    });

    it('should return empty array when no objects match', async () => {
      mockS3Send.mockResolvedValue({
        Contents: undefined,
        IsTruncated: false,
      });

      const result = await provider.list('empty-prefix/');

      expect(result.keys).toEqual([]);
    });

    it('should handle pagination with continuation tokens', async () => {
      mockS3Send
        .mockResolvedValueOnce({
          Contents: [{ Key: 'a/1.txt' }, { Key: 'a/2.txt' }],
          IsTruncated: true,
          NextContinuationToken: 'token-1',
        })
        .mockResolvedValueOnce({
          Contents: [{ Key: 'a/3.txt' }],
          IsTruncated: false,
        });

      const result = await provider.list('a/');

      expect(result.keys).toEqual(['a/1.txt', 'a/2.txt', 'a/3.txt']);
      expect(mockS3Send).toHaveBeenCalledTimes(2);
    });

    it('should skip objects without Key property', async () => {
      mockS3Send.mockResolvedValue({
        Contents: [{ Key: 'valid.txt' }, { Key: undefined }, { Key: 'also-valid.txt' }],
        IsTruncated: false,
      });

      const result = await provider.list();

      expect(result.keys).toEqual(['valid.txt', 'also-valid.txt']);
    });

    it('should list all objects when no prefix is provided', async () => {
      mockS3Send.mockResolvedValue({
        Contents: [{ Key: 'file1.txt' }, { Key: 'dir/file2.txt' }],
        IsTruncated: false,
      });

      const result = await provider.list();

      expect(result.keys).toEqual(['file1.txt', 'dir/file2.txt']);
      expect(mockS3Send).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            Bucket: 'test-bucket',
            Prefix: undefined,
          }),
        }),
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// MeiliSearch Provider Tests
// ═══════════════════════════════════════════════════════════════════════════════

describe('MeiliSearchProvider', () => {
  let provider: MeiliSearchProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new MeiliSearchProvider('https://search.example.com', 'test-api-key');
  });

  describe('index', () => {
    it('should add documents to the specified collection index', async () => {
      mockIndex.addDocuments.mockResolvedValue({ taskUid: 1 });
      const documents = [
        { id: '1', title: 'First' },
        { id: '2', title: 'Second' },
      ];

      await provider.index('articles', documents);

      expect(mockMeiliClient.index).toHaveBeenCalledWith('articles');
      expect(mockIndex.addDocuments).toHaveBeenCalledWith(documents);
    });

    it('should handle empty documents array', async () => {
      mockIndex.addDocuments.mockResolvedValue({ taskUid: 2 });

      await provider.index('articles', []);

      expect(mockIndex.addDocuments).toHaveBeenCalledWith([]);
    });
  });

  describe('search', () => {
    it('should search with default options', async () => {
      mockIndex.search.mockResolvedValue({
        hits: [{ id: '1', title: 'Result' }],
        estimatedTotalHits: 1,
        processingTimeMs: 5,
      });

      const result = await provider.search('articles', 'test query');

      expect(mockMeiliClient.index).toHaveBeenCalledWith('articles');
      expect(mockIndex.search).toHaveBeenCalledWith('test query', {
        filter: undefined,
        sort: undefined,
        limit: 20,
        offset: 0,
        attributesToRetrieve: undefined,
      });
      expect(result).toEqual({
        hits: [{ id: '1', title: 'Result' }],
        totalHits: 1,
        processingTimeMs: 5,
      });
    });

    it('should pass custom search options', async () => {
      mockIndex.search.mockResolvedValue({
        hits: [],
        estimatedTotalHits: 0,
        processingTimeMs: 2,
      });

      const options = {
        filter: 'status = published',
        sort: ['createdAt:desc'],
        limit: 10,
        offset: 5,
        attributesToRetrieve: ['id', 'title'],
      };

      await provider.search('articles', 'query', options);

      expect(mockIndex.search).toHaveBeenCalledWith('query', {
        filter: 'status = published',
        sort: ['createdAt:desc'],
        limit: 10,
        offset: 5,
        attributesToRetrieve: ['id', 'title'],
      });
    });

    it('should handle null estimatedTotalHits', async () => {
      mockIndex.search.mockResolvedValue({
        hits: [{ id: '1' }],
        estimatedTotalHits: undefined,
        processingTimeMs: 3,
      });

      const result = await provider.search('articles', 'query');

      expect(result.totalHits).toBe(0);
    });

    it('should return typed results', async () => {
      interface Article {
        id: string;
        title: string;
        body: string;
      }

      mockIndex.search.mockResolvedValue({
        hits: [{ id: '1', title: 'Hello', body: 'World' }],
        estimatedTotalHits: 1,
        processingTimeMs: 1,
      });

      const result = await provider.search<Article>('articles', 'hello');

      expect(result.hits[0]!.title).toBe('Hello');
      expect(result.hits[0]!.body).toBe('World');
    });
  });

  describe('delete', () => {
    it('should delete documents by IDs from the collection', async () => {
      mockIndex.deleteDocuments.mockResolvedValue({ taskUid: 3 });

      await provider.delete('articles', ['id-1', 'id-2', 'id-3']);

      expect(mockMeiliClient.index).toHaveBeenCalledWith('articles');
      expect(mockIndex.deleteDocuments).toHaveBeenCalledWith(['id-1', 'id-2', 'id-3']);
    });

    it('should handle empty documentIds array', async () => {
      mockIndex.deleteDocuments.mockResolvedValue({ taskUid: 4 });

      await provider.delete('articles', []);

      expect(mockIndex.deleteDocuments).toHaveBeenCalledWith([]);
    });
  });

  describe('getIndex', () => {
    it('should return the number of documents in the index', async () => {
      mockIndex.getStats.mockResolvedValue({ numberOfDocuments: 42 });

      const result = await provider.getIndex('articles');

      expect(mockMeiliClient.index).toHaveBeenCalledWith('articles');
      expect(result).toEqual({ numberOfDocuments: 42 });
    });

    it('should return zero when index is empty', async () => {
      mockIndex.getStats.mockResolvedValue({ numberOfDocuments: 0 });

      const result = await provider.getIndex('empty-collection');

      expect(result).toEqual({ numberOfDocuments: 0 });
    });
  });
});
