import { Type, type Static } from "@sinclair/typebox";
import { DateTimeString, UuidString, SuccessStatusResponseSchema } from "./common.js";

export const AttachmentPurposeSchema = Type.Union([
  Type.Literal("avatar"),
  Type.Literal("medical_report"),
  Type.Literal("voice_note"),
  Type.Literal("growth_photo"),
  Type.Literal("ai_input"),
]);

export type AttachmentPurpose = Static<typeof AttachmentPurposeSchema>;

export const AttachmentStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("ready"),
  Type.Literal("failed"),
]);

export type AttachmentStatus = Static<typeof AttachmentStatusSchema>;

export const CreateAttachmentRequestSchema = Type.Object(
  {
    purpose: AttachmentPurposeSchema,
    mimeType: Type.String(),
    byteSize: Type.Integer({ minimum: 1, maximum: 26214400 }), // 25MiB max
    sha256: Type.String({ minLength: 64, maxLength: 64 }),
    ownerScope: Type.Optional(
      Type.Object(
        {
          familyId: Type.Optional(UuidString),
          babyId: Type.Optional(UuidString),
        },
        { additionalProperties: false }
      )
    ),
  },
  { $id: "CreateAttachmentRequest", additionalProperties: false }
);

export type CreateAttachmentRequest = Static<typeof CreateAttachmentRequestSchema>;

export const AttachmentSchema = Type.Object(
  {
    id: UuidString,
    uploadUrl: Type.String(),
    objectKey: Type.String(),
    status: AttachmentStatusSchema,
    expiresAt: DateTimeString,
  },
  { $id: "Attachment", additionalProperties: false }
);

export type Attachment = Static<typeof AttachmentSchema>;

export const AttachmentResponseSchema = Type.Object(
  {
    data: AttachmentSchema,
  },
  { $id: "AttachmentResponse", additionalProperties: false }
);

export type AttachmentResponse = Static<typeof AttachmentResponseSchema>;

export const CompleteAttachmentRequestSchema = Type.Object(
  {
    sha256: Type.String({ minLength: 64, maxLength: 64 }),
    byteSize: Type.Integer({ minimum: 1 }),
  },
  { $id: "CompleteAttachmentRequest", additionalProperties: false }
);

export type CompleteAttachmentRequest = Static<typeof CompleteAttachmentRequestSchema>;

export const UploadUrlResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        uploadUrl: Type.String(),
        expiresAt: DateTimeString,
      },
      { additionalProperties: false }
    ),
  },
  { $id: "UploadUrlResponse", additionalProperties: false }
);

export type UploadUrlResponse = Static<typeof UploadUrlResponseSchema>;

export const DeleteAttachmentResponseSchema = SuccessStatusResponseSchema;
export type DeleteAttachmentResponse = Static<typeof DeleteAttachmentResponseSchema>;

/** Binary content is streamed by the authenticated API, never returned as a signed read URL. */
export const AttachmentContentResponseSchema = Type.String({
  format: "binary",
  description: "Authorized attachment bytes streamed from private object storage",
});
