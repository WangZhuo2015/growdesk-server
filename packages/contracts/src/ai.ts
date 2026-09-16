import { Type, type Static } from "@sinclair/typebox";
import {
  Nullable,
  DateTimeString,
  DateString,
  BigIntString,
  UuidString,
  PaginatedEnvelope,
  SuccessStatusResponseSchema,
} from "./common.js";

// ==========================================
// 1. AI Sessions & Messages
// ==========================================

export const AiSessionSchema = Type.Object(
  {
    id: UuidString,
    userId: UuidString,
    babyId: Nullable(UuidString),
    title: Type.String({ minLength: 1, maxLength: 100 }),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "AiSession", additionalProperties: false }
);

export type AiSession = Static<typeof AiSessionSchema>;

export const CreateAiSessionRequestSchema = Type.Object(
  {
    babyId: Type.Optional(Nullable(UuidString)),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { $id: "CreateAiSessionRequest", additionalProperties: false }
);

export type CreateAiSessionRequest = Static<typeof CreateAiSessionRequestSchema>;

export const AiSessionResponseSchema = Type.Object(
  {
    data: AiSessionSchema,
  },
  { $id: "AiSessionResponse", additionalProperties: false }
);

export type AiSessionResponse = Static<typeof AiSessionResponseSchema>;

export const AiSessionListResponseSchema = PaginatedEnvelope(AiSessionSchema, {
  $id: "AiSessionListResponse",
});

export type AiSessionListResponse = Static<typeof AiSessionListResponseSchema>;

export const AiMessageRoleSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("assistant"),
  Type.Literal("system"),
]);

export type AiMessageRole = Static<typeof AiMessageRoleSchema>;

export const AiMessageSchema = Type.Object(
  {
    id: UuidString,
    sessionId: UuidString,
    role: AiMessageRoleSchema,
    content: Type.String(),
    attachmentIds: Type.Array(Type.String()),
    createdAt: DateTimeString,
  },
  { $id: "AiMessage", additionalProperties: false }
);

export type AiMessage = Static<typeof AiMessageSchema>;

export const AiMessageListResponseSchema = PaginatedEnvelope(AiMessageSchema, {
  $id: "AiMessageListResponse",
});

export type AiMessageListResponse = Static<typeof AiMessageListResponseSchema>;

// ==========================================
// 2. AI Runs & Execution Lifecycle
// ==========================================

export const AiRunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("awaiting_confirmation"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("cancelling"),
  Type.Literal("cancelled"),
]);

export type AiRunStatus = Static<typeof AiRunStatusSchema>;

/** Durable event names emitted by the worker and replayed through the SSE cursor. */
export const AiRunEventTypeSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("run_started"),
  Type.Literal("text_delta"),
  Type.Literal("tool_proposed"),
  Type.Literal("tool_started"),
  Type.Literal("tool_succeeded"),
  Type.Literal("awaiting_confirmation"),
  Type.Literal("attempt_restarted"),
  Type.Literal("run_failed"),
  Type.Literal("run_cancelled"),
  Type.Literal("run_succeeded"),
  Type.Literal("confirmed"),
]);

export type AiRunEventType = Static<typeof AiRunEventTypeSchema>;

export const AiRunEventSchema = Type.Object(
  {
    runId: UuidString,
    seq: BigIntString,
    attempt: Type.Integer({ minimum: 1 }),
    type: AiRunEventTypeSchema,
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { $id: "AiRunEvent", additionalProperties: false },
);

export type AiRunEvent = Static<typeof AiRunEventSchema>;

export const AiRunEventsQuerySchema = Type.Object(
  {
    after: Type.Optional(BigIntString),
  },
  { $id: "AiRunEventsQuery", additionalProperties: false },
);

export type AiRunEventsQuery = Static<typeof AiRunEventsQuerySchema>;

export const CreateAiRunRequestSchema = Type.Object(
  {
    clientMessageId: UuidString,
    message: Type.String({ minLength: 1, maxLength: 4000 }),
    attachmentIds: Type.Optional(Type.Array(Type.String())),
  },
  { $id: "CreateAiRunRequest", additionalProperties: false }
);

export type CreateAiRunRequest = Static<typeof CreateAiRunRequestSchema>;

export const ProposedActionSchema = Type.Object(
  {
    actionId: UuidString,
    entityType: Type.String(),
    operation: Type.String(),
    summary: Type.String(),
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { additionalProperties: false }
);

export const AiRunSchema = Type.Object(
  {
    id: UuidString,
    sessionId: UuidString,
    userId: UuidString,
    babyId: Nullable(UuidString),
    status: AiRunStatusSchema,
    attempt: Type.Integer({ minimum: 1 }),
    lastEventSeq: BigIntString,
    resultSummary: Nullable(Type.String()),
    proposedPlan: Nullable(
      Type.Object(
        {
          planHash: Type.String(),
          actions: Type.Array(ProposedActionSchema),
          expiresAt: DateTimeString,
        },
        { additionalProperties: false }
      )
    ),
    errorCode: Nullable(Type.String()),
    errorMessage: Nullable(Type.String()),
    createdAt: DateTimeString,
    startedAt: Nullable(DateTimeString),
    finishedAt: Nullable(DateTimeString),
  },
  { $id: "AiRun", additionalProperties: false }
);

export type AiRun = Static<typeof AiRunSchema>;

export const AiRunResponseSchema = Type.Object(
  {
    data: AiRunSchema,
  },
  { $id: "AiRunResponse", additionalProperties: false }
);

export type AiRunResponse = Static<typeof AiRunResponseSchema>;

export const AiRunConfirmRequestSchema = Type.Object(
  {
    planHash: Type.String(),
    actionIds: Type.Array(UuidString, { minItems: 1 }),
  },
  { $id: "AiRunConfirmRequest", additionalProperties: false }
);

export type AiRunConfirmRequest = Static<typeof AiRunConfirmRequestSchema>;

export const AiRunConfirmResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        runId: UuidString,
        status: AiRunStatusSchema,
        appliedActionCount: Type.Integer(),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "AiRunConfirmResponse", additionalProperties: false }
);

export type AiRunConfirmResponse = Static<typeof AiRunConfirmResponseSchema>;

export const AiRunCancelResponseSchema = SuccessStatusResponseSchema;
export type AiRunCancelResponse = Static<typeof AiRunCancelResponseSchema>;

export const AiRunRetryResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        runId: UuidString,
        newAttempt: Type.Integer(),
        status: Type.Literal("queued"),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "AiRunRetryResponse", additionalProperties: false }
);

export type AiRunRetryResponse = Static<typeof AiRunRetryResponseSchema>;

// ==========================================
// 3. Voice Runs & Daily Summaries
// ==========================================

export const CreateVoiceRunRequestSchema = Type.Object(
  {
    babyId: UuidString,
    attachmentId: UuidString,
    clientRequestId: UuidString,
  },
  { $id: "CreateVoiceRunRequest", additionalProperties: false }
);

export type CreateVoiceRunRequest = Static<typeof CreateVoiceRunRequestSchema>;

export const VoiceRunResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        runId: UuidString,
        status: Type.Literal("queued"),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "VoiceRunResponse", additionalProperties: false }
);

export type VoiceRunResponse = Static<typeof VoiceRunResponseSchema>;

export const CreateDailySummaryRunRequestSchema = Type.Object(
  {
    targetDate: DateString,
  },
  { $id: "CreateDailySummaryRunRequest", additionalProperties: false }
);

export type CreateDailySummaryRunRequest = Static<typeof CreateDailySummaryRunRequestSchema>;

export const DailySummaryRunResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        runId: UuidString,
        status: Type.Literal("queued"),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "DailySummaryRunResponse", additionalProperties: false }
);

export type DailySummaryRunResponse = Static<typeof DailySummaryRunResponseSchema>;

export const DailySummaryItemSchema = Type.Object(
  {
    id: UuidString,
    babyId: UuidString,
    familyId: UuidString,
    targetDate: DateString,
    content: Type.String(),
    version: BigIntString,
    createdAt: DateTimeString,
  },
  { $id: "DailySummaryItem", additionalProperties: false }
);

export type DailySummaryItem = Static<typeof DailySummaryItemSchema>;

export const DailySummaryListResponseSchema = PaginatedEnvelope(DailySummaryItemSchema, {
  $id: "DailySummaryListResponse",
});

export type DailySummaryListResponse = Static<typeof DailySummaryListResponseSchema>;
