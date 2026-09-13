import { Type, type Static } from "@sinclair/typebox";
import { UserProfileSchema } from "./auth.js";
import { UuidString, SuccessStatusResponseSchema } from "./common.js";

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

export const DeleteUserResponseSchema = SuccessStatusResponseSchema;
export type DeleteUserResponse = Static<typeof DeleteUserResponseSchema>;
