import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import {
  LLM_PREFERENCE_ROUTE_DEFINITIONS,
  type LlmPreferenceSelection,
} from "@growdesk/contracts";
import { BadRequestError } from "@growdesk/database";
import { LlmPreferencesService } from "../services/llm-preferences-service.js";

const preferenceFields = new Set(["feature", "source", "profileId", "modelId"]);

function schema(operationId: string) {
  const route = LLM_PREFERENCE_ROUTE_DEFINITIONS.find(item => item.operationId === operationId)!;
  return {
    operationId,
    body: route.body,
    params: route.params,
    querystring: route.querystring,
    response: route.responses,
  };
}

export const llmPreferencesRoutes: FastifyPluginAsync<{ pool: pg.Pool }> = async (app, { pool }) => {
  const service = new LlmPreferencesService(pool);

  app.get("/api/v1/web/ai/preferences", {
    preHandler: [app.authenticate],
    schema: schema("getWebAiPreferences"),
  }, async request => service.list(request.principal!.userId));

  app.put<{ Body: LlmPreferenceSelection }>("/api/v1/web/ai/preferences", {
    preHandler: [app.authenticate],
    // Fastify's shared AJV compiler removes additional properties by default.
    // Reject them before schema validation so this endpoint never accepts
    // caller-supplied ownership or provider credential/endpoint fields.
    preValidation: async request => {
      const body = request.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) return;
      if (Object.keys(body).some(field => !preferenceFields.has(field))) {
        throw new BadRequestError("Only AI preference selection fields are accepted", "INVALID_LLM_PREFERENCE");
      }
    },
    schema: schema("upsertWebAiPreference"),
  }, async request => service.upsert(request.principal!.userId, request.body));
};
