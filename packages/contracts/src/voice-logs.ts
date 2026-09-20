import { Type, type Static } from "@sinclair/typebox";
import {
  DateTimeString,
  Nullable,
  PaginatedEnvelope,
  SuccessStatusResponseSchema,
  UuidString,
} from "./common.js";

export const VoiceLogBabySchema = Type.Object(
  {
    id: UuidString,
    nickname: Type.String(),
    gender: Type.String(),
  },
  { $id: "VoiceLogBaby", additionalProperties: false },
);

export type VoiceLogBaby = Static<typeof VoiceLogBabySchema>;

/** The durable result history shown by the legacy voice-history UI. */
export const VoiceLogSchema = Type.Object(
  {
    id: UuidString,
    userId: UuidString,
    familyId: UuidString,
    babyId: UuidString,
    prompt: Type.String(),
    reply: Type.String(),
    isAsync: Type.Boolean(),
    isFastPath: Type.Boolean(),
    acknowledged: Type.Boolean(),
    createdAt: DateTimeString,
    baby: Nullable(VoiceLogBabySchema),
  },
  { $id: "VoiceLog", additionalProperties: false },
);

export type VoiceLog = Static<typeof VoiceLogSchema>;

export const CreateVoiceLogRequestSchema = Type.Object(
  {
    babyId: UuidString,
    prompt: Type.String({ minLength: 1, maxLength: 4_000 }),
    reply: Type.String({ minLength: 1, maxLength: 100_000 }),
    isAsync: Type.Optional(Type.Boolean()),
    isFastPath: Type.Optional(Type.Boolean()),
    acknowledged: Type.Optional(Type.Boolean()),
  },
  { $id: "CreateVoiceLogRequest", additionalProperties: false },
);

export type CreateVoiceLogRequest = Static<typeof CreateVoiceLogRequestSchema>;

export const VoiceLogResponseSchema = Type.Object(
  { data: Type.Ref(VoiceLogSchema) },
  { $id: "VoiceLogResponse", additionalProperties: false },
);

export type VoiceLogResponse = Static<typeof VoiceLogResponseSchema>;

export const VoiceLogListResponseSchema = PaginatedEnvelope(Type.Ref(VoiceLogSchema), {
  $id: "VoiceLogListResponse",
});

export type VoiceLogListResponse = Static<typeof VoiceLogListResponseSchema>;

export const VoiceLogUnreadResponseSchema = Type.Object(
  { data: Nullable(Type.Ref(VoiceLogSchema)) },
  { $id: "VoiceLogUnreadResponse", additionalProperties: false },
);

export type VoiceLogUnreadResponse = Static<typeof VoiceLogUnreadResponseSchema>;

export const VoiceLogQueryResponseSchema = Type.Union(
  [Type.Ref(VoiceLogListResponseSchema), Type.Ref(VoiceLogUnreadResponseSchema)],
  { $id: "VoiceLogQueryResponse" },
);

export type VoiceLogQueryResponse = Static<typeof VoiceLogQueryResponseSchema>;

export const VoiceLogListQuerySchema = Type.Object(
  {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    unreadAsync: Type.Optional(Type.Boolean()),
  },
  { $id: "VoiceLogListQuery", additionalProperties: false },
);

export type VoiceLogListQuery = Static<typeof VoiceLogListQuerySchema>;

export const AcknowledgeVoiceLogRequestSchema = Type.Object(
  { acknowledged: Type.Boolean() },
  { $id: "AcknowledgeVoiceLogRequest", additionalProperties: false },
);

export type AcknowledgeVoiceLogRequest = Static<typeof AcknowledgeVoiceLogRequestSchema>;

export const VoiceLogAckResponseSchema = SuccessStatusResponseSchema;
export type VoiceLogAckResponse = Static<typeof VoiceLogAckResponseSchema>;
