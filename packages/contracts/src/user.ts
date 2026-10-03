import { Type, type Static } from "@sinclair/typebox";
import { UserProfileSchema } from "./auth.js";
import { DateTimeString, UuidString, SuccessStatusResponseSchema } from "./common.js";

export const CurrentUserResponseSchema = Type.Object(
  {
    data: UserProfileSchema,
  },
  { $id: "CurrentUserResponse", additionalProperties: false }
);

export type CurrentUserResponse = Static<typeof CurrentUserResponseSchema>;

export const UpdateUserProfileRequestSchema = Type.Object(
  {
    displayName: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
  },
  { $id: "UpdateUserProfileRequest", additionalProperties: false }
);

export type UpdateUserProfileRequest = Static<typeof UpdateUserProfileRequestSchema>;

export const ExportUserDataResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        taskId: UuidString,
        status: Type.Literal("queued"),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "ExportUserDataResponse", additionalProperties: false }
);

export type ExportUserDataResponse = Static<typeof ExportUserDataResponseSchema>;

const UserExportSnapshotPageSchema = Type.Object(
  {
    entityType: Type.String({ minLength: 1, maxLength: 64 }),
    data: Type.Array(Type.Unknown()),
  },
  { additionalProperties: false }
);

const UserExportFamilySchema = Type.Object(
  {
    familyId: UuidString,
    epoch: UuidString,
    highWater: Type.String({ pattern: "^\\d+$" }),
    pages: Type.Array(UserExportSnapshotPageSchema),
  },
  { additionalProperties: false }
);

/** Versioned, user-scoped JSON file returned by GET /me/exports/:id. */
export const UserExportFileSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    user: UserProfileSchema,
    families: Type.Array(UserExportFamilySchema, { maxItems: 32 }),
    generatedAt: DateTimeString,
  },
  { $id: "UserExportFile", additionalProperties: false }
);

export type UserExportFile = Static<typeof UserExportFileSchema>;

export const UserExportTaskStatusResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        taskId: UuidString,
        status: Type.Union([
          Type.Literal("queued"),
          Type.Literal("running"),
          Type.Literal("succeeded"),
          Type.Literal("failed"),
          Type.Literal("cancelling"),
          Type.Literal("cancelled"),
          Type.Literal("awaiting_confirmation"),
        ]),
        attempt: Type.Integer({ minimum: 0 }),
        errorCode: Type.Optional(Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,63}$" })),
        createdAt: DateTimeString,
        updatedAt: DateTimeString,
        expiresAt: Type.Optional(DateTimeString),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "UserExportTaskStatusResponse", additionalProperties: false }
);

export type UserExportTaskStatusResponse = Static<typeof UserExportTaskStatusResponseSchema>;

export const DeleteUserResponseSchema = SuccessStatusResponseSchema;
export type DeleteUserResponse = Static<typeof DeleteUserResponseSchema>;
