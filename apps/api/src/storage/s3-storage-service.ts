import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";

export interface StorageObject {
  /**
   * The object body is deliberately exposed as an async iterable so callers
   * can forward it without buffering the complete object in application
   * memory.
   */
  body: AsyncIterable<Uint8Array>;
  contentType?: string;
  contentLength?: number;
}

export class StorageObjectUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "ATTACHMENT_STORAGE_UNAVAILABLE";

  constructor() {
    super("Attachment storage is temporarily unavailable");
    this.name = "StorageObjectUnavailableError";
  }
}

export class StorageObjectDeleteError extends Error {
  readonly statusCode = 503;
  readonly code = "ATTACHMENT_STORAGE_DELETE_FAILED";

  constructor() {
    super("Attachment storage deletion is temporarily unavailable");
    this.name = "StorageObjectDeleteError";
  }
}

const STORAGE_DELETE_TIMEOUT_MS = 10_000;

export interface StorageDriver {
  generatePresignedUploadUrl(params: {
    objectKey: string;
    mimeType: string;
    byteSize: number;
    expiresInSeconds?: number;
  }): Promise<{ uploadUrl: string; expiresAt: Date }>;

  getObject(objectKey: string): Promise<StorageObject>;

  verifyUploadedObject(params: {
    objectKey: string;
    expectedSha256: string;
    expectedByteSize: number;
  }): Promise<{ valid: boolean; actualSize?: number; actualSha256?: string; error?: string }>;

  deleteObject(objectKey: string): Promise<void>;
}

export interface S3Config {
  endpoint?: string;
  region?: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle?: boolean;
}

export class AwsS3StorageDriver implements StorageDriver {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region || "us-east-1",
      credentials: config.accessKeyId && config.secretAccessKey
        ? {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey,
          }
        : undefined,
      forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
    });
  }

  async generatePresignedUploadUrl(params: {
    objectKey: string;
    mimeType: string;
    byteSize: number;
    expiresInSeconds?: number;
  }): Promise<{ uploadUrl: string; expiresAt: Date }> {
    const expiresIn = params.expiresInSeconds ?? 900; // 15 min default
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.objectKey,
      ContentType: params.mimeType,
      ContentLength: params.byteSize,
    });

    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn });
    return { uploadUrl, expiresAt };
  }

  async getObject(objectKey: string): Promise<StorageObject> {
    try {
      const object = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      }));
      if (!object.Body) throw new StorageObjectUnavailableError();

      return {
        // The Node.js AWS SDK handler returns an IncomingMessage/Readable body,
        // both of which implement AsyncIterable<Uint8Array>.
        body: object.Body as unknown as AsyncIterable<Uint8Array>,
        contentType: object.ContentType,
        contentLength: object.ContentLength,
      };
    } catch (error) {
      if (error instanceof StorageObjectUnavailableError) throw error;
      throw new StorageObjectUnavailableError();
    }
  }

  async verifyUploadedObject(params: {
    objectKey: string;
    expectedSha256: string;
    expectedByteSize: number;
  }): Promise<{ valid: boolean; actualSize?: number; actualSha256?: string; error?: string }> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: params.objectKey,
        })
      );

      const actualSize = head.ContentLength ?? 0;
      if (actualSize !== params.expectedByteSize) {
        return {
          valid: false,
          actualSize,
          error: `Size mismatch: expected ${params.expectedByteSize}, got ${actualSize}`,
        };
      }

      const object = await this.client.send(new GetObjectCommand({
        Bucket: this.bucket, Key: params.objectKey,
      }));
      if (!object.Body) return { valid: false, error: "Object body is missing" };
      const hash = crypto.createHash("sha256");
      let bytes = 0;
      for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
        bytes += chunk.length;
        if (bytes > params.expectedByteSize) return { valid: false, error: "Object exceeds declared size" };
        hash.update(chunk);
      }
      const actualSha256 = hash.digest("hex");
      return {
        valid: bytes === params.expectedByteSize && actualSha256 === params.expectedSha256,
        actualSize: bytes, actualSha256,
        ...(actualSha256 !== params.expectedSha256 ? { error: "Object checksum mismatch" } : {}),
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: `S3 HeadObject failed: ${errorMsg}` };
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), STORAGE_DELETE_TIMEOUT_MS);
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
        }),
        { abortSignal: abortController.signal },
      );
    } catch {
      // Do not expose provider errors or credentials. The caller must keep the
      // database row retryable and return a non-success response.
      throw new StorageObjectDeleteError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * In-memory Mock Storage Driver for automated unit/integration tests without external S3.
 */
export class MockStorageDriver implements StorageDriver {
  private readonly objects = new Map<string, { buffer?: Buffer; sha256: string; byteSize: number; mimeType: string }>();

  async generatePresignedUploadUrl(params: {
    objectKey: string;
    mimeType: string;
    byteSize: number;
    expiresInSeconds?: number;
  }): Promise<{ uploadUrl: string; expiresAt: Date }> {
    const expiresIn = params.expiresInSeconds ?? 900;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const uploadUrl = `https://s3.mock.local/upload/${params.objectKey}?expires=${expiresAt.getTime()}`;
    return { uploadUrl, expiresAt };
  }

  async getObject(objectKey: string): Promise<StorageObject> {
    const existing = this.objects.get(objectKey);
    if (!existing?.buffer) throw new StorageObjectUnavailableError();
    return {
      body: (async function* () { yield existing.buffer!; })(),
      contentType: existing.mimeType,
      contentLength: existing.byteSize,
    };
  }

  async verifyUploadedObject(params: {
    objectKey: string;
    expectedSha256: string;
    expectedByteSize: number;
  }): Promise<{ valid: boolean; actualSize?: number; actualSha256?: string; error?: string }> {
    // In mock driver, simulate matching metadata if test registered or allow matching payload
    const existing = this.objects.get(params.objectKey);
    if (existing) {
      if (existing.byteSize !== params.expectedByteSize) {
        return {
          valid: false,
          actualSize: existing.byteSize,
          error: `Size mismatch: expected ${params.expectedByteSize}, got ${existing.byteSize}`,
        };
      }
      if (existing.sha256 !== params.expectedSha256) {
        return {
          valid: false,
          actualSha256: existing.sha256,
          error: `Hash mismatch: expected ${params.expectedSha256}, got ${existing.sha256}`,
        };
      }
      return { valid: true, actualSize: existing.byteSize, actualSha256: existing.sha256 };
    }

    // Default mock behavior: accept expected parameters
    return { valid: true, actualSize: params.expectedByteSize, actualSha256: params.expectedSha256 };
  }

  simulateUpload(objectKey: string, payload: Buffer, mimeType = "application/octet-stream") {
    const sha256 = crypto.createHash("sha256").update(payload).digest("hex");
    this.objects.set(objectKey, {
      buffer: payload,
      sha256,
      byteSize: payload.byteLength,
      mimeType,
    });
  }

  async deleteObject(objectKey: string): Promise<void> {
    this.objects.delete(objectKey);
  }
}
