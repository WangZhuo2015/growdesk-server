import { Type, type Static } from "@sinclair/typebox";
import { Nullable, DateTimeString, UuidString } from "./common.js";

export const UserProfileSchema = Type.Object(
  {
    id: UuidString,
    username: Type.String({ minLength: 3, maxLength: 50 }),
    displayName: Type.String({ minLength: 1, maxLength: 50 }),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "UserProfile", additionalProperties: false }
);

export type UserProfile = Static<typeof UserProfileSchema>;

export const SessionSummarySchema = Type.Object(
  {
    id: UuidString,
    deviceLabel: Nullable(Type.String({ maxLength: 100 })),
    createdAt: DateTimeString,
    lastSeenAt: DateTimeString,
    expiresAt: DateTimeString,
  },
  { $id: "SessionSummary", additionalProperties: false }
);

export type SessionSummary = Static<typeof SessionSummarySchema>;

export const RegisterRequestSchema = Type.Object(
  {
    username: Type.String({ minLength: 3, maxLength: 50 }),
    password: Type.String({ minLength: 8, maxLength: 100 }),
    displayName: Type.String({ minLength: 1, maxLength: 50 }),
    deviceLabel: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
  },
  { $id: "RegisterRequest", additionalProperties: false }
);

export type RegisterRequest = Static<typeof RegisterRequestSchema>;

export const AuthTokenPairSchema = Type.Object(
  {
    accessToken: Type.String(),
    refreshToken: Type.String(),
    expiresIn: Type.Integer({ description: "Access token lifetime in seconds" }),
    sessionId: UuidString,
    user: UserProfileSchema,
  },
  { $id: "AuthTokenPair", additionalProperties: false }
);

export type AuthTokenPair = Static<typeof AuthTokenPairSchema>;

export const RegisterResponseSchema = Type.Object(
  {
    data: AuthTokenPairSchema,
  },
  { $id: "RegisterResponse", additionalProperties: false }
);

export type RegisterResponse = Static<typeof RegisterResponseSchema>;

export const LoginRequestSchema = Type.Object(
  {
    username: Type.String({ minLength: 1 }),
    password: Type.String({ minLength: 1 }),
    deviceLabel: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
  },
  { $id: "LoginRequest", additionalProperties: false }
);

export type LoginRequest = Static<typeof LoginRequestSchema>;

export const LoginResponseSchema = Type.Object(
  {
    data: AuthTokenPairSchema,
  },
  { $id: "LoginResponse", additionalProperties: false }
);

export type LoginResponse = Static<typeof LoginResponseSchema>;

export const RefreshTokenRequestSchema = Type.Object(
  {
    refreshToken: Type.String(),
    rotationId: UuidString,
  },
  { $id: "RefreshTokenRequest", additionalProperties: false }
);

export type RefreshTokenRequest = Static<typeof RefreshTokenRequestSchema>;

export const RefreshTokenResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        accessToken: Type.String(),
        refreshToken: Type.String(),
        expiresIn: Type.Integer(),
        rotationId: UuidString,
      },
      { additionalProperties: false }
    ),
  },
  { $id: "RefreshTokenResponse", additionalProperties: false }
);

export type RefreshTokenResponse = Static<typeof RefreshTokenResponseSchema>;

export const SessionListResponseSchema = Type.Object(
  {
    data: Type.Array(SessionSummarySchema),
  },
  { $id: "SessionListResponse", additionalProperties: false }
);

export type SessionListResponse = Static<typeof SessionListResponseSchema>;

export const RevokeSessionResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        revoked: Type.Literal(true),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "RevokeSessionResponse", additionalProperties: false }
);

export type RevokeSessionResponse = Static<typeof RevokeSessionResponseSchema>;

export const ChangePasswordRequestSchema = Type.Object(
  {
    oldPassword: Type.String({ minLength: 1 }),
    newPassword: Type.String({ minLength: 8, maxLength: 100 }),
  },
  { $id: "ChangePasswordRequest", additionalProperties: false }
);

export type ChangePasswordRequest = Static<typeof ChangePasswordRequestSchema>;

export const RegenerateRecoveryCodesRequestSchema = Type.Object(
  {
    password: Type.String({ minLength: 1 }),
  },
  { $id: "RegenerateRecoveryCodesRequest", additionalProperties: false }
);

export type RegenerateRecoveryCodesRequest = Static<typeof RegenerateRecoveryCodesRequestSchema>;

export const RegenerateRecoveryCodesResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        codes: Type.Array(Type.String(), { minItems: 10, maxItems: 10 }),
        batchId: UuidString,
      },
      { additionalProperties: false }
    ),
  },
  { $id: "RegenerateRecoveryCodesResponse", additionalProperties: false }
);

export type RegenerateRecoveryCodesResponse = Static<typeof RegenerateRecoveryCodesResponseSchema>;

export const RecoverPasswordRequestSchema = Type.Object(
  {
    username: Type.String(),
    recoveryCode: Type.String(),
    newPassword: Type.String({ minLength: 8, maxLength: 100 }),
  },
  { $id: "RecoverPasswordRequest", additionalProperties: false }
);

export type RecoverPasswordRequest = Static<typeof RecoverPasswordRequestSchema>;

export const BffSessionExchangeRequestSchema = Type.Object(
  {
    sessionSecretHash: Type.String({ minLength: 64, maxLength: 64 }),
    userId: Type.Optional(UuidString),
    username: Type.Optional(Type.String({ minLength: 1 })),
    password: Type.Optional(Type.String({ minLength: 1 })),
    deviceLabel: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
  },
  { $id: "BffSessionExchangeRequest", additionalProperties: false }
);

export type BffSessionExchangeRequest = Static<typeof BffSessionExchangeRequestSchema>;

export const BffSessionRevokeRequestSchema = Type.Object(
  {
    sessionSecretHash: Type.String({ minLength: 64, maxLength: 64 }),
  },
  { $id: "BffSessionRevokeRequest", additionalProperties: false }
);

export type BffSessionRevokeRequest = Static<typeof BffSessionRevokeRequestSchema>;

export const BffSessionExchangeResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        accessToken: Type.String(),
        expiresIn: Type.Integer(),
        user: UserProfileSchema,
      },
      { additionalProperties: false }
    ),
  },
  { $id: "BffSessionExchangeResponse", additionalProperties: false }
);

export type BffSessionExchangeResponse = Static<typeof BffSessionExchangeResponseSchema>;
