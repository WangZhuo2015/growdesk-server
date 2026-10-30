import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("AI API preflight accepts an official key without a base URL", () => {
  assert.doesNotThrow(() => assertAiProviderConfigured({
    GROWDESK_AI_PROVIDER: "openai",
    OPENAI_API_KEY: "test_official_key",
  }));
  assert.doesNotThrow(() => assertAiProviderConfigured({
    GROWDESK_AI_PROVIDER: "openai",
    GROWDESK_AI_API_KEY: "   ",
    OPENAI_API_KEY: "test_official_key",
    GROWDESK_AI_BASE_URL: "https://api.openai.com/v1",
  }));
});

test("AI API preflight supports an explicit private key file and rejects unusable files", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "test_openai_preflight_"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "test_key");
  const env = { GROWDESK_AI_PROVIDER: "openai", GROWDESK_AI_API_KEY_FILE: path };
  const rejected = () => assert.throws(() => assertAiProviderConfigured(env),
    (error: unknown) => error instanceof AiProviderUnavailableError && error.code === "AI_PROVIDER_NOT_CONFIGURED");
  rejected();
  writeFileSync(path, "test_virtual_official_key\n", { mode: 0o600 });
  assert.doesNotThrow(() => assertAiProviderConfigured(env));
  writeFileSync(path, "  \n");
  rejected();
  writeFileSync(path, "test_key\ntest_second_line");
  rejected();
  writeFileSync(path, "x".repeat(16_385));
  rejected();
  assert.doesNotThrow(() => assertAiProviderConfigured({ ...env, OPENAI_API_KEY: "test_inline_key" }));
});

test("AI API preflight rejects missing official keys and third-party endpoints", () => {
  for (const env of [
    { GROWDESK_AI_PROVIDER: "openai" },
    { GROWDESK_AI_PROVIDER: "openai", AI_API_KEY: "test_legacy_key" },
    ...[
      "https://test-provider.invalid/v1",
      "http://api.openai.com/v1",
      "https://api.openai.com:443/v1",
      "https://api.openai.com/v1/chat/completions",
      "https://api.openai.com/v1?test=1",
      "https://api.openai.com/v1?",
      "https://api.openai.com/v1#",
      "https://test_user@api.openai.com/v1",
    ].map((baseUrl) => ({ GROWDESK_AI_PROVIDER: "openai", OPENAI_API_KEY: "test_official_key", GROWDESK_AI_BASE_URL: baseUrl })),
  ]) {
    assert.throws(() => assertAiProviderConfigured(env),
      (error: unknown) => error instanceof AiProviderUnavailableError && error.code === "AI_PROVIDER_NOT_CONFIGURED");
  }
});
