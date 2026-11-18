/**
 * Object storage client wrapper for lab result files (Phase 5, issue #16).
 * Provider decision: docs/adr/0014-lab-result-object-storage.md — a private
 * AWS S3 bucket (any S3-compatible endpoint works through the same client),
 * server-side encrypted, never public. Business code only sees the
 * `ObjectStorage` interface below; nothing outside this file imports the SDK.
 *
 * Keys are opaque and server-generated. They are not URLs and must never be
 * returned to a client: a file is only read back through the API, which
 * re-checks access on every request.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { config } from '../config';
import { HttpError } from '../http-error';

export interface StoredObject {
  body: Buffer;
  contentType: string | undefined;
}

export interface ObjectStorage {
  putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void>;
  /** Null when no object exists under `key`. */
  getObject(key: string): Promise<StoredObject | null>;
  deleteObject(key: string): Promise<void>;
}

export class S3ObjectStorage implements ObjectStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void> {
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: input.key,
      Body: input.body,
      ContentType: input.contentType,
      ContentLength: input.body.length,
      // Encrypted at rest with S3-managed keys. No ACL is sent: the bucket's
      // own "block public access" setting is what keeps it private.
      ServerSideEncryption: 'AES256',
    }));
  }

  async getObject(key: string): Promise<StoredObject | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return null;
      return { body: Buffer.from(await result.Body.transformToByteArray()), contentType: result.ContentType };
    } catch (error) {
      if (error instanceof NoSuchKey) return null;
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Process-local store for tests (OBJECT_STORAGE_DRIVER=memory). The config
 * parser refuses this driver in production. */
export class MemoryObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, StoredObject>();

  async putObject(input: { key: string; body: Buffer; contentType: string }): Promise<void> {
    this.objects.set(input.key, { body: Buffer.from(input.body), contentType: input.contentType });
  }

  async getObject(key: string): Promise<StoredObject | null> {
    return this.objects.get(key) ?? null;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

let instance: ObjectStorage | null = null;

/** The configured store, built on first use. With no storage configured
 * (driver `none`) this throws 503 so a deployment without a bucket fails the
 * request loudly instead of silently dropping a clinical file. */
export function getObjectStorage(): ObjectStorage {
  if (instance) return instance;
  const settings = config.objectStorage;
  if (settings.driver === 'memory') {
    instance = new MemoryObjectStorage();
  } else if (settings.driver === 's3') {
    instance = new S3ObjectStorage(
      new S3Client({
        region: settings.region,
        endpoint: settings.endpoint,
        forcePathStyle: settings.forcePathStyle,
      }),
      settings.bucket,
    );
  } else {
    throw new HttpError(503, 'Result file storage is not configured on this server.', 'OBJECT_STORAGE_NOT_CONFIGURED');
  }
  return instance;
}
