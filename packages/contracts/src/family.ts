import { Type, type Static } from "@sinclair/typebox";
import { Nullable, DateTimeString, DateString, UuidString } from "./common.js";

export const FamilySchema = Type.Object(
  {
    id: UuidString,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    timeZone: Type.String({ description: "IANA time zone identifier, e.g. Asia/Shanghai" }),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "Family", additionalProperties: false }
);

export type Family = Static<typeof FamilySchema>;

export const FamilyResponseSchema = Type.Object(
  {
    data: FamilySchema,
  },
  { $id: "FamilyResponse", additionalProperties: false }
);

export type FamilyResponse = Static<typeof FamilyResponseSchema>;

export const FamilyListResponseSchema = Type.Object(
  {
    data: Type.Array(FamilySchema),
  },
  { $id: "FamilyListResponse", additionalProperties: false }
);

export type FamilyListResponse = Static<typeof FamilyListResponseSchema>;

export const CreateFamilyRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    timeZone: Type.Optional(Type.String({ default: "Asia/Shanghai" })),
  },
  { $id: "CreateFamilyRequest", additionalProperties: false }
);

export type CreateFamilyRequest = Static<typeof CreateFamilyRequestSchema>;

export const UpdateFamilyRequestSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    timeZone: Type.Optional(Type.String()),
  },
  { $id: "UpdateFamilyRequest", additionalProperties: false }
);

export type UpdateFamilyRequest = Static<typeof UpdateFamilyRequestSchema>;

export const FamilyMemberRoleSchema = Type.Union([
  Type.Literal("admin"),
  Type.Literal("member"),
]);

export type FamilyMemberRole = Static<typeof FamilyMemberRoleSchema>;

export const FamilyMemberSchema = Type.Object(
  {
    userId: UuidString,
    familyId: UuidString,
    role: FamilyMemberRoleSchema,
    displayName: Type.String(),
    joinedAt: DateTimeString,
  },
  { $id: "FamilyMember", additionalProperties: false }
);

export type FamilyMember = Static<typeof FamilyMemberSchema>;

export const FamilyMemberListResponseSchema = Type.Object(
  {
    data: Type.Array(FamilyMemberSchema),
  },
  { $id: "FamilyMemberListResponse", additionalProperties: false }
);

export type FamilyMemberListResponse = Static<typeof FamilyMemberListResponseSchema>;

export const UpdateFamilyMemberRequestSchema = Type.Object(
  {
    role: FamilyMemberRoleSchema,
  },
  { $id: "UpdateFamilyMemberRequest", additionalProperties: false }
);

export type UpdateFamilyMemberRequest = Static<typeof UpdateFamilyMemberRequestSchema>;

export const RemoveFamilyMemberResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        removed: Type.Literal(true),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "RemoveFamilyMemberResponse", additionalProperties: false }
);

export type RemoveFamilyMemberResponse = Static<typeof RemoveFamilyMemberResponseSchema>;

export const CreateFamilyInviteRequestSchema = Type.Object(
  {
    expiresInDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, default: 7 })),
  },
  { $id: "CreateFamilyInviteRequest", additionalProperties: false }
);

export type CreateFamilyInviteRequest = Static<typeof CreateFamilyInviteRequestSchema>;

export const CreateFamilyInviteResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        inviteCode: Type.String(),
        expiresAt: DateTimeString,
      },
      { additionalProperties: false }
    ),
  },
  { $id: "CreateFamilyInviteResponse", additionalProperties: false }
);

export type CreateFamilyInviteResponse = Static<typeof CreateFamilyInviteResponseSchema>;

export const PreviewFamilyInviteQuerySchema = Type.Object(
  {
    code: Type.String(),
  },
  { $id: "PreviewFamilyInviteQuery", additionalProperties: false }
);

export type PreviewFamilyInviteQuery = Static<typeof PreviewFamilyInviteQuerySchema>;

export const PreviewFamilyInviteResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        familyName: Type.String(),
        inviterName: Type.String(),
        expiresAt: DateTimeString,
      },
      { additionalProperties: false }
    ),
  },
  { $id: "PreviewFamilyInviteResponse", additionalProperties: false }
);

export type PreviewFamilyInviteResponse = Static<typeof PreviewFamilyInviteResponseSchema>;

export const JoinFamilyRequestSchema = Type.Object(
  {
    inviteCode: Type.String(),
  },
  { $id: "JoinFamilyRequest", additionalProperties: false }
);

export type JoinFamilyRequest = Static<typeof JoinFamilyRequestSchema>;

export const JoinFamilyResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        family: FamilySchema,
        role: FamilyMemberRoleSchema,
      },
      { additionalProperties: false }
    ),
  },
  { $id: "JoinFamilyResponse", additionalProperties: false }
);

export type JoinFamilyResponse = Static<typeof JoinFamilyResponseSchema>;

export const BabyGenderSchema = Type.Union([
  Type.Literal("boy"),
  Type.Literal("girl"),
  Type.Literal("other"),
]);

export type BabyGender = Static<typeof BabyGenderSchema>;

export const BabySchema = Type.Object(
  {
    id: UuidString,
    familyId: UuidString,
    name: Type.String({ minLength: 1, maxLength: 50 }),
    birthDate: DateString,
    gender: BabyGenderSchema,
    avatarUrl: Nullable(Type.String()),
    gestationalWeeks: Nullable(Type.Integer({ minimum: 20, maximum: 45 })),
    gestationalDays: Nullable(Type.Integer({ minimum: 0, maximum: 6 })),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "Baby", additionalProperties: false }
);

export type Baby = Static<typeof BabySchema>;

export const BabyResponseSchema = Type.Object(
  {
    data: BabySchema,
  },
  { $id: "BabyResponse", additionalProperties: false }
);

export type BabyResponse = Static<typeof BabyResponseSchema>;

export const BabyListResponseSchema = Type.Object(
  {
    data: Type.Array(BabySchema),
  },
  { $id: "BabyListResponse", additionalProperties: false }
);

export type BabyListResponse = Static<typeof BabyListResponseSchema>;

export const CreateBabyRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 50 }),
    birthDate: DateString,
    gender: BabyGenderSchema,
    avatarUrl: Type.Optional(Nullable(Type.String())),
    gestationalWeeks: Type.Optional(Nullable(Type.Integer({ minimum: 20, maximum: 45 }))),
    gestationalDays: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 6 }))),
  },
  { $id: "CreateBabyRequest", additionalProperties: false }
);

export type CreateBabyRequest = Static<typeof CreateBabyRequestSchema>;

export const UpdateBabyRequestSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
    birthDate: Type.Optional(DateString),
    gender: Type.Optional(BabyGenderSchema),
    avatarUrl: Type.Optional(Nullable(Type.String())),
    gestationalWeeks: Type.Optional(Nullable(Type.Integer({ minimum: 20, maximum: 45 }))),
    gestationalDays: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 6 }))),
  },
  { $id: "UpdateBabyRequest", additionalProperties: false }
);

export type UpdateBabyRequest = Static<typeof UpdateBabyRequestSchema>;
