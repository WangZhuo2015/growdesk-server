import { Type, Static } from "@sinclair/typebox";

// Standard Error Envelope
export const ApiErrorSchema = Type.Object({
  error: Type.Object({
    code: Type.String(),
    message: Type.String(),
    details: Type.Optional(Type.Unknown()),
    requestId: Type.String(),
  }),
});
export type ApiError = Static<typeof ApiErrorSchema>;

// Standard Success Single Object Envelope
export const DataEnvelope = <T extends ReturnType<typeof Type.Object>>(schema: T) =>
  Type.Object({
    data: schema,
  });

// Auth Contracts
export const LoginRequestSchema = Type.Object({
  username: Type.String({ minLength: 3, maxLength: 50 }),
  password: Type.String({ minLength: 6 }),
  deviceLabel: Type.Optional(Type.String({ maxLength: 100 })),
});
export type LoginRequest = Static<typeof LoginRequestSchema>;

export const AuthTokensResponseSchema = Type.Object({
  accessToken: Type.String(),
  refreshToken: Type.String(),
  sessionId: Type.String(),
  expiresIn: Type.Number(),
});
export type AuthTokensResponse = Static<typeof AuthTokensResponseSchema>;

// Desk Hardware / Table Feature Contracts
export const DeskStatusSchema = Type.Object({
  deviceId: Type.String(),
  currentHeightMm: Type.Number({ minimum: 450, maximum: 900 }),
  isSitting: Type.Boolean(),
  lightBrightness: Type.Number({ minimum: 0, maximum: 100 }),
  lightColorTempK: Type.Number({ minimum: 2700, maximum: 6500 }),
  postureAlertEnabled: Type.Boolean(),
  lastActiveAt: Type.String({ format: "date-time" }),
});
export type DeskStatus = Static<typeof DeskStatusSchema>;

// Growth & Activity Record Contracts
export const GrowthRecordSchema = Type.Object({
  id: Type.String({ format: "uuid" }),
  babyId: Type.String(),
  familyId: Type.String(),
  heightCm: Type.Number({ minimum: 30, maximum: 200 }),
  weightKg: Type.Number({ minimum: 1, maximum: 100 }),
  headCircumferenceCm: Type.Optional(Type.Number()),
  recordedAt: Type.String({ format: "date-time" }),
  version: Type.String(),
});
export type GrowthRecord = Static<typeof GrowthRecordSchema>;

// Sync Feed Contracts
export const SyncPullRequestSchema = Type.Object({
  familyId: Type.String(),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200, default: 50 })),
});
export type SyncPullRequest = Static<typeof SyncPullRequestSchema>;

export const SyncChangeItemSchema = Type.Object({
  cursor: Type.String(),
  entityType: Type.String(),
  entityId: Type.String(),
  operation: Type.Union([Type.Literal("INSERT"), Type.Literal("UPDATE"), Type.Literal("DELETE")]),
  payload: Type.Optional(Type.Unknown()),
  timestamp: Type.String({ format: "date-time" }),
});
export type SyncChangeItem = Static<typeof SyncChangeItemSchema>;
