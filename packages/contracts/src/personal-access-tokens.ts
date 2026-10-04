import { Type, type Static } from "@sinclair/typebox";
import { DateTimeString, Nullable, SuccessEnvelope, SuccessStatusResponseSchema, UuidString } from "./common.js";
import { AiRunSchema } from "./ai.js";
import { OAuthConnectionListResponseSchema } from "./mcp.js";

export const PersonalAccessTokenScopeSchema = Type.Literal("voice:submit");
export type PersonalAccessTokenScope = Static<typeof PersonalAccessTokenScopeSchema>;

export const PersonalAccessTokenSummarySchema = Type.Object(
  {
    id: UuidString,
    name: Type.String({ minLength: 1, maxLength: 100 }),
    tokenHint: Type.String({ minLength: 1, maxLength: 64 }),
    scopes: Type.Array(PersonalAccessTokenScopeSchema, { minItems: 1, maxItems: 1 }),
    createdAt: DateTimeString,
    lastUsedAt: Nullable(DateTimeString),
    expiresAt: Nullable(DateTimeString),
  },
  { $id: "PersonalAccessTokenSummary", additionalProperties: false },
);
export type PersonalAccessTokenSummary = Static<typeof PersonalAccessTokenSummarySchema>;

export const ListPersonalAccessTokensResponseSchema = SuccessEnvelope(
  Type.Array(PersonalAccessTokenSummarySchema, { maxItems: 10 }),
  { $id: "ListPersonalAccessTokensResponse" },
);
export type ListPersonalAccessTokensResponse = Static<typeof ListPersonalAccessTokensResponseSchema>;

export const CreatePersonalAccessTokenRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 100 }),
    expiresAt: Type.Optional(DateTimeString),
  },
  { $id: "CreatePersonalAccessTokenRequest", additionalProperties: false },
);
export type CreatePersonalAccessTokenRequest = Static<typeof CreatePersonalAccessTokenRequestSchema>;

export const CreatePersonalAccessTokenResponseSchema = SuccessEnvelope(
  Type.Object(
    {
      id: UuidString,
      name: Type.String({ minLength: 1, maxLength: 100 }),
      tokenHint: Type.String({ minLength: 1, maxLength: 64 }),
      scopes: Type.Array(PersonalAccessTokenScopeSchema, { minItems: 1, maxItems: 1 }),
      createdAt: DateTimeString,
      lastUsedAt: Nullable(DateTimeString),
      expiresAt: Nullable(DateTimeString),
      token: Type.String({ minLength: 1, maxLength: 128 }),
    },
    { additionalProperties: false },
  ),
  { $id: "CreatePersonalAccessTokenResponse" },
);
export type CreatePersonalAccessTokenResponse = Static<typeof CreatePersonalAccessTokenResponseSchema>;

export const ListPersonalConnectionsResponseSchema = OAuthConnectionListResponseSchema;
export type ListPersonalConnectionsResponse = Static<typeof ListPersonalConnectionsResponseSchema>;

const AIUsageCountSchema = Type.Integer({ minimum: 0 });
const NullableAIUsageCountSchema = Nullable(AIUsageCountSchema);

export const PersonalAIUsageQuerySchema = Type.Object(
  { babyId: Type.Optional(UuidString) },
  { $id: "PersonalAIUsageQuery", additionalProperties: false },
);

export const PersonalAIUsageResponseSchema = Type.Object(
  {
    availability: Type.Literal("partial"),
    generatedAt: DateTimeString,
    timezone: Type.Literal("UTC"),
    baby: Type.Union([
      Type.Object({ id: UuidString, nickname: Type.String(), familyId: UuidString, familyName: Type.String() }, { additionalProperties: false }),
      Type.Null(),
    ]),
    coverage: Type.Object(
      {
        mcpCalls: Type.Literal("native_go_dispatch_only"),
        providerAttempts: Type.Literal("native_go_attempt_ledger_only"),
        unsupportedMetrics: Type.Array(Type.String(), { maxItems: 12 }),
      },
      { additionalProperties: false },
    ),
    overview: Type.Object(
      {
        totalCalls: AIUsageCountSchema,
        todayCalls: AIUsageCountSchema,
        last7DaysCalls: AIUsageCountSchema,
        connectedAgentsCount: AIUsageCountSchema,
        successRate: Nullable(Type.Number({ minimum: 0, maximum: 100 })),
        avgDurationMs: NullableAIUsageCountSchema,
        readCallsCount: AIUsageCountSchema,
        writeCallsCount: AIUsageCountSchema,
        manageCallsCount: AIUsageCountSchema,
        totalRecordsCreatedByAi: NullableAIUsageCountSchema,
      },
      { additionalProperties: false },
    ),
    connectedAgents: Type.Array(
      Type.Object(
        {
          clientId: Type.String(),
          agentName: Type.String(),
          clientName: Type.String(),
          status: Type.Union([Type.Literal("active"), Type.Literal("idle"), Type.Literal("authorized")]),
          totalCalls: AIUsageCountSchema,
          todayCalls: AIUsageCountSchema,
          successCount: AIUsageCountSchema,
          errorCount: AIUsageCountSchema,
          firstSeen: Nullable(DateTimeString),
          lastSeen: Nullable(DateTimeString),
          topTool: Type.Union([
            Type.Object({ toolName: Type.String(), label: Type.String(), count: AIUsageCountSchema }, { additionalProperties: false }),
            Type.Null(),
          ]),
          recordsWritten: NullableAIUsageCountSchema,
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
    toolUsageRanking: Type.Array(
      Type.Object(
        {
          toolName: Type.String(),
          label: Type.String(),
          count: AIUsageCountSchema,
          percentage: Type.Number({ minimum: 0, maximum: 100 }),
          category: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("manage")]),
        },
        { additionalProperties: false },
      ),
      { maxItems: 10 },
    ),
    dailyActivityTrend: Type.Array(
      Type.Object(
        { date: Type.String({ pattern: "^\\d{2}-\\d{2}$" }), fullDate: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }), total: AIUsageCountSchema, success: AIUsageCountSchema, error: AIUsageCountSchema },
        { additionalProperties: false },
      ),
      { minItems: 14, maxItems: 14 },
    ),
    recentAuditLogs: Type.Array(
      Type.Object(
        {
          id: UuidString,
          agentName: Type.String(),
          toolName: Nullable(Type.String()),
          toolLabel: Type.String(),
          action: Type.String(),
          category: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("manage")]),
          authResult: Type.Union([Type.Literal("pending"), Type.Literal("success"), Type.Literal("denied"), Type.Literal("error")]),
          createdAt: DateTimeString,
          durationMs: NullableAIUsageCountSchema,
          userName: Type.String(),
          userRelation: Type.String(),
          ip: Nullable(Type.String()),
          errorMessage: Nullable(Type.String()),
        },
        { additionalProperties: false },
      ),
      { maxItems: 100 },
    ),
    aiRuns: Type.Object(
      { total: AIUsageCountSchema, queued: AIUsageCountSchema, running: AIUsageCountSchema, succeeded: AIUsageCountSchema, failed: AIUsageCountSchema, cancelled: AIUsageCountSchema },
      { additionalProperties: false },
    ),
    providerUsage: Type.Object(
      {
        totalAttempts: AIUsageCountSchema,
        modelCalls: AIUsageCountSchema,
        asrCalls: AIUsageCountSchema,
        reportedAttempts: AIUsageCountSchema,
        unknownAttempts: AIUsageCountSchema,
        inputTokens: NullableAIUsageCountSchema,
        outputTokens: NullableAIUsageCountSchema,
        totalTokens: NullableAIUsageCountSchema,
        tokenUsageState: Type.Union([Type.Literal("no_calls"), Type.Literal("reported"), Type.Literal("partial"), Type.Literal("unknown")]),
        costMicros: NullableAIUsageCountSchema,
        currency: Nullable(Type.String({ pattern: "^[A-Z]{3}$" })),
        costState: Type.Union([Type.Literal("no_calls"), Type.Literal("unpriced")]),
      },
      { additionalProperties: false },
    ),
    budget: Type.Object(
      {
        availability: Type.Union([Type.Literal("configured"), Type.Literal("not_configured")]),
        unit: Type.Literal("ai_run_attempt"),
        period: Type.Literal("utc_day"),
        periodStart: DateTimeString,
        limit: NullableAIUsageCountSchema,
        reservedUnits: NullableAIUsageCountSchema,
        settledUnits: NullableAIUsageCountSchema,
        remainingUnits: NullableAIUsageCountSchema,
      },
      { additionalProperties: false },
    ),
  },
  { $id: "PersonalAIUsageResponse", additionalProperties: false },
);
export type PersonalAIUsageResponse = Static<typeof PersonalAIUsageResponseSchema>;

export const PersonalVoiceTextRunRequestSchema = Type.Object(
  {
    babyId: UuidString,
    message: Type.String({ minLength: 1, maxLength: 4000 }),
    clientRequestId: UuidString,
  },
  { $id: "PersonalVoiceTextRunRequest", additionalProperties: false },
);
export type PersonalVoiceTextRunRequest = Static<typeof PersonalVoiceTextRunRequestSchema>;

export const PersonalVoiceTextRunResponseSchema = Type.Object(
  {
    data: AiRunSchema,
  },
  { $id: "PersonalVoiceTextRunResponse", additionalProperties: false },
);
export type PersonalVoiceTextRunResponse = Static<typeof PersonalVoiceTextRunResponseSchema>;

export const RevokePersonalAccessTokenResponseSchema = SuccessStatusResponseSchema;
