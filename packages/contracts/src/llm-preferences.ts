import { Type, type Static } from "@sinclair/typebox";
import { ApiErrorEnvelopeSchema } from "./common.js";
import type { RouteDefinition } from "./routes.js";

export const LlmPreferenceFeatureSchema = Type.Union([
  Type.Literal("chat"),
  Type.Literal("daily_summary"),
  Type.Literal("tips"),
  Type.Literal("record_parse"),
  Type.Literal("nutrition_parse"),
  Type.Literal("search"),
  Type.Literal("growth_ocr"),
  Type.Literal("medical_ocr"),
  Type.Literal("voice"),
]);
export type LlmPreferenceFeature = Static<typeof LlmPreferenceFeatureSchema>;

export const LlmPreferenceSourceSchema = Type.Union([
  Type.Literal("api"),
  Type.Literal("chatgpt"),
]);
export type LlmPreferenceSource = Static<typeof LlmPreferenceSourceSchema>;

/** User-selected catalogue references only; never provider credentials or endpoints. */
export const LlmPreferenceSelectionSchema = Type.Object({
  feature: LlmPreferenceFeatureSchema,
  source: LlmPreferenceSourceSchema,
  profileId: Type.String({ minLength: 1, maxLength: 100 }),
  modelId: Type.String({ minLength: 1, maxLength: 200 }),
}, { $id: "LlmPreferenceSelection", additionalProperties: false });
export type LlmPreferenceSelection = Static<typeof LlmPreferenceSelectionSchema>;

export const LlmPreferencesResponseSchema = Type.Object({
  data: Type.Object({ preferences: Type.Array(LlmPreferenceSelectionSchema) }, { additionalProperties: false }),
}, { $id: "LlmPreferencesResponse", additionalProperties: false });
export type LlmPreferencesResponse = Static<typeof LlmPreferencesResponseSchema>;

export const UpsertLlmPreferenceResponseSchema = Type.Object({
  data: LlmPreferenceSelectionSchema,
}, { $id: "UpsertLlmPreferenceResponse", additionalProperties: false });
export type UpsertLlmPreferenceResponse = Static<typeof UpsertLlmPreferenceResponseSchema>;

export const LLM_PREFERENCE_ROUTE_DEFINITIONS: RouteDefinition[] = [
  {
    method: "GET",
    path: "/api/v1/web/ai/preferences",
    operationId: "getWebAiPreferences",
    summary: "List AI feature selections for the authenticated user",
    tags: ["Web AI"],
    implementationStatus: "READY",
    responses: { 200: LlmPreferencesResponseSchema, 401: ApiErrorEnvelopeSchema },
  },
  {
    method: "PUT",
    path: "/api/v1/web/ai/preferences",
    operationId: "upsertWebAiPreference",
    summary: "Save the authenticated user's selection for one AI feature",
    tags: ["Web AI"],
    implementationStatus: "READY",
    body: LlmPreferenceSelectionSchema,
    responses: {
      200: UpsertLlmPreferenceResponseSchema,
      400: ApiErrorEnvelopeSchema,
      401: ApiErrorEnvelopeSchema,
    },
  },
];
