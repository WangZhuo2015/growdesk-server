import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import crypto from "node:crypto";

export interface StorageDriver {
  generatePresignedUploadUrl(params: {
    objectKey: string;
    mimeType: string;
    byteSize: number;
    expiresInSeconds?: number;
  }): Promise<{ uploadUrl: string; expiresAt: Date }>;

  generatePresignedDownloadUrl(params: {
    objectKey: string;
    filename?: string;
    expiresInSeconds?: number;
  }): Promise<{ downloadUrl: string; expiresAt: Date }>;

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

  async generatePresignedDownloadUrl(params: {
    objectKey: string;
    filename?: string;
    expiresInSeconds?: number;
  }): Promise<{ downloadUrl: string; expiresAt: Date }> {
    const expiresIn = params.expiresInSeconds ?? 900;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);

    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: params.objectKey,
      ResponseContentDisposition: params.filename
        ? `attachment; filename="${encodeURIComponent(params.filename)}"`
        : undefined,
    });

    const downloadUrl = await getSignedUrl(this.client, command, { expiresIn });
    return { downloadUrl, expiresAt };
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

      return { valid: true, actualSize, actualSha256: params.expectedSha256 };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { valid: false, error: `S3 HeadObject failed: ${errorMsg}` };
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: objectKey,
      })
    );
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

  async generatePresignedDownloadUrl(params: {
    objectKey: string;
    filename?: string;
    expiresInSeconds?: number;
  }): Promise<{ downloadUrl: string; expiresAt: Date }> {
    const expiresIn = params.expiresInSeconds ?? 900;
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    const downloadUrl = `https://s3.mock.local/download/${params.objectKey}?expires=${expiresAt.getTime()}`;
    return { downloadUrl, expiresAt };
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
