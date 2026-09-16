import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AiProviderUnavailableError,
  assertAiProviderConfigured,
} from "../src/services/ai-service.js";

test("AI API preflight rejects an absent provider with 503", () => {
  assert.throws(
    () => assertAiProviderConfigured({}),
    (error: unknown) => error instanceof AiProviderUnavailableError && error.statusCode === 503 && error.code === "AI_PROVIDER_NOT_CONFIGURED",
  );
});

test("AI API preflight accepts only explicit fixture responses", () => {
  assert.throws(
    () => assertAiProviderConfigured({ GROWDESK_AI_PROVIDER: "fixture" }),
    /AI provider is not configured/,
  );
  assert.doesNotThrow(() => assertAiProviderConfigured({
    GROWDESK_AI_PROVIDER: "fixture",
    GROWDESK_AI_FIXTURE_TEXT: "test answer",
  }));
});

test("AI API preflight accepts approved compatible provider configuration", () => {
  assert.doesNotThrow(() => assertAiProviderConfigured({
    GROWDESK_AI_PROVIDER: "openai-compatible",
    GROWDESK_AI_BASE_URL: "http://127.0.0.1:19090/v1",
    GROWDESK_AI_API_KEY: "test-key",
  }));
});
