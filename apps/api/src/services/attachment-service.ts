import crypto from "node:crypto";
import { PrismaClient, RecordNotFoundError, FamilyAccessDeniedError, BadRequestError } from "@growdesk/database";
import { UserPrincipal } from "@growdesk/domain";
import { StorageDriver } from "../storage/s3-storage-service.js";
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

export class AttachmentService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly storageDriver: StorageDriver
  ) {}

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

    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === attachment.familyId && m.status === "active"
    );
    if (!hasFamily) {
      throw new FamilyAccessDeniedError(attachment.familyId);
    }

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

    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === attachment.familyId && m.status === "active"
    );
    if (!hasFamily) {
      throw new FamilyAccessDeniedError(attachment.familyId);
    }

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
      uploadUrl,
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

    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === attachment.familyId && m.status === "active"
    );
    if (!hasFamily) {
      throw new FamilyAccessDeniedError(attachment.familyId);
    }

    return attachment;
  }

  async deleteAttachment(principal: UserPrincipal, attachmentId: string) {
    const attachment = await this.prisma.attachment.findUnique({
      where: { id: attachmentId },
    });

    if (!attachment || attachment.deletedAt) {
      throw new RecordNotFoundError("Attachment", attachmentId);
    }

    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === attachment.familyId && m.status === "active"
    );
    if (!hasFamily) {
      throw new FamilyAccessDeniedError(attachment.familyId);
    }

    await this.prisma.attachment.update({
      where: { id: attachmentId },
      data: { deletedAt: new Date() },
    });

    await this.storageDriver.deleteObject(attachment.objectKey).catch(() => {});

    return { data: { success: true } };
  }
}
