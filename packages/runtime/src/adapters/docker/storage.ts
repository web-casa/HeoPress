// Modified by the HeoPress project; based on LumiBase (Apache-2.0). See NOTICE.
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import http from 'node:http';
import https from 'node:https';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { StorageProvider, StorageObject } from '../../interfaces';
import { guardedLookup, serviceEndpointPolicy, type TrustedEndpoints } from '../../outbound/fetch';

export interface S3StorageConfig {
  /**
   * Service endpoint; omit for AWS S3. R2:
   * `https://<account>.r2.cloudflarestorage.com`; MinIO: `http://minio:9000`;
   * OSS: `https://oss-<region>.aliyuncs.com`; COS:
   * `https://cos.<region>.myqcloud.com` (see docs/en/deployment/object-storage.md).
   */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Default `us-east-1`; R2 uses `auto`. */
  region?: string;
  /**
   * Path-style addressing (`endpoint/bucket/key`). Default: on with a custom
   * endpoint (MinIO, R2), off for AWS. OSS and COS need it off
   * (virtual-hosted style).
   */
  forcePathStyle?: boolean;
  /** Defaults to HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS. */
  trusted?: TrustedEndpoints;
}

/**
 * S3-compatible StorageProvider — AWS S3, Cloudflare R2, Alibaba OSS, Tencent
 * COS, MinIO — selected by configuration (HeoPress P03 task 4.1).
 *
 * The endpoint is a service connection under the platform outbound boundary
 * (task 4.4): it is checked at startup, and every connection's addresses are
 * checked when connecting, so an endpoint that resolves to a private or
 * metadata address is refused unless its exact origin is listed in
 * HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS (e.g. `http://minio:9000`).
 */
export class S3StorageProvider implements StorageProvider {
  private client: S3Client;
  private bucket: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    const { allowInternal } = config.endpoint
      ? serviceEndpointPolicy(config.endpoint, config.trusted)
      : { allowInternal: false };
    const lookup = guardedLookup(allowInternal) as never;
    this.client = new S3Client({
      endpoint: config.endpoint || undefined,
      region: config.region ?? 'us-east-1',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
      requestHandler: new NodeHttpHandler({
        httpAgent: new http.Agent({ keepAlive: true, lookup }),
        httpsAgent: new https.Agent({ keepAlive: true, lookup }),
        connectionTimeout: 10_000,
        requestTimeout: 60_000,
      }),
    });
  }

  async put(key: string, data: ReadableStream | Buffer, metadata?: Record<string, string>): Promise<void> {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(await this.streamToBuffer(data as ReadableStream));

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        Metadata: metadata,
        // Map the logical content type onto S3's native `ContentType` so
        // `get()` (which reads `response.ContentType`) round-trips it. S3
        // lowercases user-metadata keys, so relying on `Metadata.contentType`
        // alone would not survive the round-trip.
        ...(metadata?.contentType ? { ContentType: metadata.contentType } : {}),
      }),
    );
  }

  async get(key: string): Promise<StorageObject | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        }),
      );

      if (!response.Body) {
        return null;
      }

      const body = Buffer.from(await response.Body.transformToByteArray());

      return {
        key,
        body,
        contentType: response.ContentType,
        size: response.ContentLength,
        metadata: response.Metadata,
      };
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'NoSuchKey') {
        return null;
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }

  async list(prefix?: string): Promise<{ keys: string[] }> {
    const keys: string[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );

      if (response.Contents) {
        for (const object of response.Contents) {
          if (object.Key) {
            keys.push(object.Key);
          }
        }
      }

      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);

    return { keys };
  }

  private async streamToBuffer(stream: ReadableStream): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }
}
