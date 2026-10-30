import assert from "node:assert/strict";
import { test } from "node:test";
import { messageModelInfoFromToolsJson, publicModelInfo } from "../src/services/ai-model-info.js";

test("message history extracts model provenance without exposing the trace marker as a tool", () => {
  const result = messageModelInfoFromToolsJson(JSON.stringify([
    { type: "llm_model", llm: { source: "api", provider: "test.provider", model: "test_actual_model", modelBasis: "provider_response" } },
    { actionId: "test_action", entityType: "feeding" },
  ]));
  assert.deepEqual(result, {
    source: "api", provider: "test.provider", model: "test_actual_model", modelBasis: "provider_response",
  });
});

test("legacy and malformed toolsJson produce null model metadata", () => {
  assert.equal(messageModelInfoFromToolsJson(null), null);
  assert.equal(messageModelInfoFromToolsJson("not-json"), null);
  assert.equal(messageModelInfoFromToolsJson(JSON.stringify([{ actionId: "test_old_action" }])), null);
});

test("public model metadata rejects URL, control and overlong labels", () => {
  for (const model of ["https://test.provider/model", "https:test.provider/model", "mailto:test@test.provider", "custom+scheme://test.provider/model", "test.provider/path/model", "test_model\nInjected", "x".repeat(201)]) {
    assert.equal(publicModelInfo({ source: "api", provider: "test.provider", model }), null);
  }
  for (const model of ["org/test-model", "gpt-4o:latest", "vendor/path/model:preview"]) {
    assert.deepEqual(publicModelInfo({ source: "api", provider: "test.provider", model }), {
      source: "api", provider: "test.provider", model,
    });
  }
});
