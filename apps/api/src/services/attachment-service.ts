import crypto from "node:crypto";
import { PrismaClient, RecordNotFoundError, FamilyAccessDeniedError, BadRequestError, BabyAccessDeniedError } from "@growdesk/database";
import { UserPrincipal } from "@growdesk/domain";
import { StorageDriver, StorageObjectDeleteError, type StorageObject } from "../storage/s3-storage-service.js";
import {
  AttachmentPurpose,
  CreateAttachmentRequest,
  CompleteAttachmentRequest,
} from "@growdesk/contracts";

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "audio/m4a",
  "audio/wav",
  "audio/mpeg",
  "audio/mp4",
  "application/pdf",
]);

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20MiB
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25MiB
const DELETE_TRANSACTION_OPTIONS = {
  // S3 is called while the attachment row is locked so a failed delete can
  // roll the database state back. Keep that lock bounded and make a slow
  // provider call retryable instead of holding it indefinitely.
  maxWait: 2_000,
  timeout: 15_000,
} as const;

class AttachmentInUseError extends Error {
  readonly statusCode = 409;
  readonly code = "ATTACHMENT_IN_USE";

  constructor() {
    super("Attachment is still referenced by family data");
    this.name = "AttachmentInUseError";
  }
}

export class AttachmentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storageDriver: StorageDriver
  ) {}

  private authorize(principal: UserPrincipal, attachment: { familyId: string; babyId: string | null; uploaderId: string }, write = false, uploaderOnly = false) {
    const family = principal.familyMemberships.find(m => m.familyId === attachment.familyId && m.status === "active");
    if (!family || (write && family.role === "viewer")) throw new FamilyAccessDeniedError(attachment.familyId);
    if (attachment.babyId) {
      const baby = principal.babyMemberships?.find(m => m.babyId === attachment.babyId && m.familyId === attachment.familyId && m.status === "active");
      if (!baby || (write && baby.role === "viewer")) throw new BabyAccessDeniedError(attachment.babyId, "ACCESS_DENIED");
    }
    if (uploaderOnly && attachment.uploaderId !== principal.userId) throw new FamilyAccessDeniedError(attachment.familyId);
  }

  async getContent(principal: UserPrincipal, attachmentId: string): Promise<StorageObject & { mimeType: string; byteSize: number }> {
    const attachment = await this.getAttachment(principal, attachmentId);
    if (attachment.status !== "ready") throw new BadRequestError("Attachment is not ready");
    const object = await this.storageDriver.getObject(attachment.objectKey);
    return {
      ...object,
      // The attachment row is the authorized application metadata. The
      // storage content type is advisory and is never allowed to override it.
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
    };
  }

  async createAttachment(
    principal: UserPrincipal,
    input: CreateAttachmentRequest
  ) {
    // 1. Resolve family and baby scope
    let familyId = input.ownerScope?.familyId;
    if (!familyId) {
      const activeMem = principal.familyMemberships.find((m) => m.status === "active");
      if (!activeMem) {
        throw new Error("No active family found for user");
      }
      familyId = activeMem.familyId;
    }

    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasFamily) {
      throw new Error(`User has no access to family ${familyId}`);
    }

    const babyId = input.ownerScope?.babyId ?? null;
    if (babyId) {
      const hasBaby = principal.babyMemberships?.some(
        (m) => m.familyId === familyId && m.babyId === babyId && m.status === "active"
      );
      if (!hasBaby) {
        throw new Error(`User has no access to baby ${babyId}`);
      }
    }

    this.authorize(principal, { familyId, babyId, uploaderId: principal.userId }, true);

    // 2. Validate MIME type
    if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
      throw new Error(`Unsupported mimeType: ${input.mimeType}`);
    }

    // 3. Validate size limit
    const isAudio = input.mimeType.startsWith("audio/");
    const maxSize = isAudio ? MAX_AUDIO_BYTES : MAX_IMAGE_BYTES;
    if (input.byteSize > maxSize) {
      throw new Error(`File size ${input.byteSize} exceeds maximum allowed (${maxSize} bytes)`);
    }

    const attachmentId = crypto.randomUUID();
    const datePrefix = new Date().toISOString().slice(0, 10);
    const ext = input.mimeType.split("/")[1] || "bin";
    const objectKey = `families/${familyId}/attachments/${input.purpose}/${datePrefix}/${attachmentId}.${ext}`;

    const { uploadUrl, expiresAt } = await this.storageDriver.generatePresignedUploadUrl({
      objectKey,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      expiresInSeconds: 900,
    });

    const attachment = await this.prisma.attachment.create({
      data: {
        id: attachmentId,
        familyId,
        babyId,
        uploaderId: principal.userId,
        purpose: input.purpose,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        sha256: input.sha256.toLowerCase(),
        objectKey,
        status: "pending",
        expiresAt,
      },
    });

    return {
      id: attachment.id,
      uploadUrl,
      objectKey: attachment.objectKey,
      status: "pending" as const,
      expiresAt: attachment.expiresAt.toISOString(),
    };
  }

  async completeAttachment(
    principal: UserPrincipal,
    attachmentId: string,
    input: CompleteAttachmentRequest
  ) {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
    });

    if (!attachment || attachment.deletedAt) {
      throw new RecordNotFoundError("Attachment", attachmentId);
    }

    this.authorize(principal, attachment, true, true);

    if (attachment.status === "ready") {
      return { data: { success: true } };
    }

    const sha256 = input.sha256.toLowerCase();
    if (sha256 !== attachment.sha256) {
      await this.prisma.attachment.update({
        where: { id: attachmentId },
        data: { status: "failed" },
      });
      throw new BadRequestError(`Checksum mismatch: expected ${attachment.sha256}, got ${sha256}`);
    }

    if (input.byteSize !== attachment.byteSize) {
      await this.prisma.attachment.update({
        where: { id: attachmentId },
        data: { status: "failed" },
      });
      throw new BadRequestError(`Size mismatch: expected ${attachment.byteSize}, got ${input.byteSize}`);
    }

    const verification = await this.storageDriver.verifyUploadedObject({
      objectKey: attachment.objectKey,
      expectedSha256: sha256,
      expectedByteSize: input.byteSize,
    });

    if (!verification.valid) {
      await this.prisma.attachment.update({
        where: { id: attachmentId },
        data: { status: "failed" },
      });
      throw new BadRequestError(verification.error || "Storage object verification failed");
    }

    await this.prisma.attachment.update({
      where: { id: attachmentId },
      data: { status: "ready" },
    });

    return { data: { success: true } };
  }

  async getUploadUrl(principal: UserPrincipal, attachmentId: string) {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
    });

    if (!attachment || attachment.deletedAt) {
      throw new RecordNotFoundError("Attachment", attachmentId);
    }

    this.authorize(principal, attachment, true, true);

    if (attachment.status !== "pending") {
      throw new BadRequestError(`Cannot renew upload URL for attachment with status: ${attachment.status}`);
    }

    const uploadUrl = await this.storageDriver.generatePresignedUploadUrl({
      objectKey: attachment.objectKey,
      mimeType: attachment.mimeType,
      byteSize: attachment.byteSize,
      expiresInSeconds: 3600,
    });

    const expiresAt = new Date(Date.now() + 3600 * 1000);
    await this.prisma.attachment.update({
      where: { id: attachmentId },
      data: { expiresAt },
    });

    return {
      uploadUrl: uploadUrl.uploadUrl,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async getAttachment(principal: UserPrincipal, attachmentId: string) {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
    });

    if (!attachment || attachment.deletedAt) {
      throw new RecordNotFoundError("Attachment", attachmentId);
    }

    this.authorize(principal, attachment, false);

    return attachment;
  }

  async deleteAttachment(principal: UserPrincipal, attachmentId: string) {
    return this.prisma.$transaction(async (tx) => {
      // Keep the reference check and the soft-delete under one row lock. The
      // storage call is intentionally inside this transaction so a failed
      // delete rolls back without hiding the attachment from a retry.
      await tx.$queryRaw`SELECT id FROM public.attachments WHERE id = ${attachmentId} FOR UPDATE`;
      const attachment = await tx.attachment.findUnique({
        where: { id: attachmentId },
      });

      if (!attachment || attachment.deletedAt) {
        throw new RecordNotFoundError("Attachment", attachmentId);
      }

      this.authorize(principal, attachment, true);

      const medicalReferences = await tx.medicalReportAttachment.count({
        where: { attachmentId },
      });
      const avatarReferences = await tx.baby.count({
        where: {
          avatarUrl: `/api/attachments/${attachmentId}`,
          deletedAt: null,
        },
      });
      const growthReferences = await tx.growthMeasurement.count({
        where: { attachmentId },
      });
      const aiMessageReferences = await tx.aiChatMessage.count({
        where: { image: `/api/attachments/${attachmentId}` },
      });
      if (medicalReferences > 0 || avatarReferences > 0 || growthReferences > 0 || aiMessageReferences > 0) {
        throw new AttachmentInUseError();
      }

      try {
        await this.storageDriver.deleteObject(attachment.objectKey);
      } catch (error) {
        if (error instanceof StorageObjectDeleteError) throw error;
        throw new StorageObjectDeleteError();
      }

      await tx.attachment.update({
        where: { id: attachmentId },
        data: { deletedAt: new Date() },
      });

      return { data: { success: true } };
    }, DELETE_TRANSACTION_OPTIONS);
  }
}
