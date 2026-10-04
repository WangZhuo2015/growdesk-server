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

export const PersonalAIUsageUnavailableResponseSchema = Type.Object(
  {
    data: Type.Array(Type.Unknown(), { maxItems: 0 }),
    availability: Type.Literal("unavailable"),
    reasonCode: Type.Literal("AI_USAGE_ACCOUNTING_NOT_IMPLEMENTED"),
  },
  { $id: "PersonalAIUsageUnavailableResponse", additionalProperties: false },
);
export type PersonalAIUsageUnavailableResponse = Static<typeof PersonalAIUsageUnavailableResponseSchema>;

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
