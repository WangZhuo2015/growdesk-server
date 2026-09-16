import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import {
  AiProviderError,
  createAiProvider,
  resolveAiProviderConfig,
} from "../src/ai-provider.js";

test("AI provider fails explicitly when no provider is configured", async () => {
  const provider = createAiProvider({});
  await assert.rejects(
    provider.generate({ sessionId: "session", babyId: null, message: "hello", attachmentIds: [] }),
    (error: unknown) => error instanceof AiProviderError && error.code === "AI_PROVIDER_NOT_CONFIGURED" && error.statusCode === 503,
  );
  assert.equal(resolveAiProviderConfig({}).mode, "unconfigured");
});

test("fixture provider requires an explicit response and emits persisted-style text deltas", async () => {
  const provider = createAiProvider({
    GROWDESK_AI_PROVIDER: "fixture",
    GROWDESK_AI_FIXTURE_TEXT: "fixture answer",
  });
  const deltas: string[] = [];
  const result = await provider.generate({
    sessionId: "session",
    babyId: null,
    message: "hello",
    attachmentIds: [],
    onTextDelta: async (delta) => {
      deltas.push(delta);
    },
  });
  assert.equal(result.text, "fixture answer");
  assert.deepEqual(deltas, ["fixture answer"]);
});

test("OpenAI-compatible HTTP fixture streams text without contacting an external provider", async (t) => {
  const server = createServer((request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer test-key");
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"好"}}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const provider = createAiProvider({
    GROWDESK_AI_PROVIDER: "openai-compatible",
    GROWDESK_AI_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    GROWDESK_AI_API_KEY: "test-key",
    GROWDESK_AI_MODEL: "fixture-model",
    GROWDESK_AI_TIMEOUT_MS: "2000",
  });
  const deltas: string[] = [];
  const result = await provider.generate({
    sessionId: "session",
    babyId: "baby",
    message: "hello",
    attachmentIds: [],
    onTextDelta: async (delta) => {
      deltas.push(delta);
    },
  });
  assert.equal(result.text, "你好");
  assert.deepEqual(deltas, ["你", "好"]);
});
