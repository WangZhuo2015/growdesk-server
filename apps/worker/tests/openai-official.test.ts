import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveOfficialOpenAiKey } from "@growdesk/adapters";
import {
  AiProviderError,
  createAiProvider,
  resolveAiProviderConfig,
} from "../src/ai-provider.js";

const encoder = new TextEncoder();
const defaultRequest = {
  sessionId: "test_session_01",
  babyId: null,
  message: "test prompt",
  attachmentIds: ["test_attachment_01"],
};

async function withFetch<T>(
  fetchMock: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  run: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function responseText(text: string): Response {
  return new Response(text, { headers: { "content-type": "text/event-stream" } });
}

function sse(event: string, payload: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function completedResponse(text: string, model = "gpt-6-luna-2026-10-30"): Record<string, unknown> {
  return {
    id: "resp_test_01",
    status: "completed",
    model,
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 17, output_tokens: 8, total_tokens: 25 },
  };
}

function openAiEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    GROWDESK_AI_PROVIDER: "openai",
    GROWDESK_AI_API_KEY: "test-openai-key-01",
    ...overrides,
  };
}

test("official OpenAI defaults, key selection, and base URL allowlist", () => {
  const config = resolveAiProviderConfig(openAiEnv());
  assert.equal(config.mode, "openai");
  assert.equal(config.baseUrl, "https://api.openai.com/v1/responses");
  assert.equal(config.model, "gpt-6-luna");
  assert.equal(config.timeoutMs, 60_000);
  assert.equal(config.apiKey, "test-openai-key-01");

  assert.equal(resolveAiProviderConfig(openAiEnv({ GROWDESK_AI_API_KEY: "  ", OPENAI_API_KEY: "test-openai-fallback" })).apiKey,
    "test-openai-fallback");
  assert.equal(resolveAiProviderConfig(openAiEnv({ GROWDESK_AI_API_KEY: "test-primary", OPENAI_API_KEY: "test-secondary" })).apiKey,
    "test-primary");
  assert.equal(resolveAiProviderConfig({ GROWDESK_AI_PROVIDER: "openai", AI_API_KEY: "test-legacy-key" }).mode,
    "unconfigured");
  assert.equal(resolveAiProviderConfig({ GROWDESK_AI_PROVIDER: "openai", OPENAI_API_KEY: "test-openai-env-key" }).apiKey,
    "test-openai-env-key");
  assert.equal(resolveAiProviderConfig({ GROWDESK_AI_PROVIDER: "openai-compatible", GROWDESK_AI_API_KEY: "test-key", GROWDESK_AI_BASE_URL: "http://127.0.0.1:8123/v1" }).timeoutMs,
    10_000);

  for (const allowed of [
    "https://api.openai.com",
    "https://api.openai.com/",
    "https://api.openai.com/v1",
    "https://api.openai.com/v1/",
    "https://api.openai.com/v1/responses",
  ]) {
    assert.equal(resolveAiProviderConfig(openAiEnv({ GROWDESK_AI_BASE_URL: allowed })).baseUrl,
      "https://api.openai.com/v1/responses");
  }
  for (const rejected of [
    "http://api.openai.com/v1",
    "https://api.openai.com:443/v1",
    "https://user@api.openai.com/v1",
    "https://api.openai.com/v1?query=test",
    "https://api.openai.com/v1#fragment",
    "https://api.openai.com/v1/chat/completions",
    "https://api.example.test/v1",
    "https://api.openai.com/v1/responses/",
  ]) {
    assert.throws(() => resolveAiProviderConfig(openAiEnv({ GROWDESK_AI_BASE_URL: rejected })), AiProviderError);
  }
});

test("official provider remains unconfigured without an approved key source", async () => {
  const provider = createAiProvider({
    GROWDESK_AI_PROVIDER: "openai",
    AI_API_KEY: "test-legacy-key-must-not-be-used",
  });
  await withFetch(async () => {
    throw new Error("fetch must not run without an OpenAI key");
  }, async () => {
    await assert.rejects(provider.generate(defaultRequest), (error: unknown) =>
      error instanceof AiProviderError && error.code === "AI_PROVIDER_NOT_CONFIGURED" && error.statusCode === 503);
  });
});

test("official Responses API sends the fixed request schema and streams before the body closes", async () => {
  const provider = createAiProvider(openAiEnv());
  const content = "completed answer";
  const firstChunk = content.slice(0, 12);
  const secondChunk = content.slice(firstChunk.length);
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let bodyClosed = false;
  let requestUrl = "";
  let requestBody: Record<string, unknown> | null = null;
  const deltas: string[] = [];
  let deltaArrived!: () => void;
  const sawDelta = new Promise<void>((resolve) => { deltaArrived = resolve; });

  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      value.enqueue(sse("response.output_text.delta", { type: "response.output_text.delta", delta: firstChunk }));
    },
    cancel() { bodyClosed = true; },
  });
  const pending = withFetch(async (input, init) => {
    requestUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-openai-key-01");
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  }, async () => provider.generate({
    ...defaultRequest,
    onTextDelta: async (delta) => {
      deltas.push(delta);
      deltaArrived();
    },
  }));

  await sawDelta;
  assert.equal(bodyClosed, false);
  assert.deepEqual(deltas, [firstChunk]);
  assert.equal(requestUrl, "https://api.openai.com/v1/responses");
  assert.deepEqual(requestBody, {
    model: "gpt-6-luna",
    stream: true,
    store: false,
    instructions: "You are GrowDesk's private baby-care assistant. Return JSON with a text string and an actions array. Use an empty actions array for read-only answers. Actions are proposals only; never claim a write has occurred or that you authorize server scope.",
    input: "test prompt",
  });

  controller?.enqueue(sse("response.output_text.delta", { type: "response.output_text.delta", delta: secondChunk }));
  controller?.enqueue(sse("response.completed", { type: "response.completed", response: completedResponse(content) }));
  const result = await pending;
  assert.equal(bodyClosed, true);
  assert.deepEqual(deltas, [firstChunk, secondChunk]);
  assert.equal(result.text, "completed answer");
  assert.deepEqual(result.actions, []);
  assert.deepEqual(result.usage, { input_tokens: 17, output_tokens: 8, total_tokens: 25 });
  assert.deepEqual(result.llm, {
    source: "api",
    provider: "api.openai.com",
    model: "gpt-6-luna-2026-10-30",
    modelBasis: "provider_response",
  });
});

test("official Responses SSE emits parsed text for JSON action proposals and returns before EOF", async () => {
  const provider = createAiProvider(openAiEnv());
  const action = {
    actionId: "test_stream_action_01",
    entityType: "record",
    operation: "create",
    summary: "test proposed action",
    payload: { label: "test payload" },
  };
  const content = JSON.stringify({ text: "structured answer", actions: [action] });
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(sse("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: content.slice(0, 19),
      }));
      controller.enqueue(sse("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: content.slice(19),
      }));
      controller.enqueue(sse("response.completed", {
        type: "response.completed",
        response: completedResponse(content),
      }));
    },
    cancel() { cancelled = true; },
  });
  await withFetch(async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }), async () => {
    const deltas: string[] = [];
    const result = await provider.generate({
      ...defaultRequest,
      onTextDelta: async (delta) => { deltas.push(delta); },
    });
    assert.equal(result.text, "structured answer");
    assert.deepEqual(result.actions, [action]);
    assert.deepEqual(deltas, [result.text]);
    assert.equal(deltas.join(""), result.text);
    assert.equal(cancelled, true);
  });
});

test("official Responses API parses non-stream JSON output, model, usage, and action proposals", async () => {
  const content = JSON.stringify({
    text: "non-stream answer",
    actions: [{
      actionId: "test_action_01",
      entityType: "record",
      operation: "create",
      summary: "test action",
      payload: { label: "test value" },
    }],
  });
  const body = {
    status: "completed",
    model: "gpt-6-luna-test-echo",
    output: [{ type: "message", content: [{ type: "output_text", text: content }] }],
    usage: { input_tokens: 4, output_tokens: 6 },
  };
  const provider = createAiProvider(openAiEnv());
  await withFetch(async (_input, init) => {
    assert.equal(JSON.parse(String(init?.body)).stream, true);
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  }, async () => {
    const deltas: string[] = [];
    const result = await provider.generate({
      ...defaultRequest,
      onTextDelta: async (delta) => { deltas.push(delta); },
    });
    assert.equal(result.text, "non-stream answer");
    assert.equal(result.actions.length, 1);
    assert.deepEqual(result.actions[0], body.output[0]?.content[0] && JSON.parse(content).actions[0]);
    assert.deepEqual(result.usage, body.usage);
    assert.deepEqual(result.llm, {
      source: "api", provider: "api.openai.com", model: "gpt-6-luna-test-echo", modelBasis: "provider_response",
    });
    assert.deepEqual(deltas, ["non-stream answer"]);
  });
});

test("official Responses API rejects non-completed, errored, and empty JSON results", async () => {
  const provider = createAiProvider(openAiEnv());
  const validOutput = [{ type: "message", content: [{ type: "output_text", text: "test answer" }] }];
  const failures: Array<{ body: Record<string, unknown>; code: string }> = [
    { body: { status: "failed", output: validOutput }, code: "AI_PROVIDER_REQUEST_FAILED" },
    { body: { status: "incomplete", output: validOutput }, code: "AI_PROVIDER_REQUEST_FAILED" },
    { body: { status: "completed", error: { message: "test-provider-error" }, output: validOutput }, code: "AI_PROVIDER_REQUEST_FAILED" },
    { body: { status: "completed", output: [] }, code: "AI_PROVIDER_INVALID_RESPONSE" },
    { body: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "  " }] }] }, code: "AI_PROVIDER_INVALID_RESPONSE" },
    { body: { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({ text: "", actions: [] }) }] }] }, code: "AI_PROVIDER_INVALID_RESPONSE" },
  ];
  for (const failure of failures) {
    await withFetch(async () => new Response(JSON.stringify(failure.body), {
      headers: { "content-type": "application/json" },
    }), async () => {
      await assert.rejects(provider.generate(defaultRequest), (error: unknown) =>
        error instanceof AiProviderError && error.code === failure.code);
    });
  }
});

test("official Responses API rejects truncated JSON-looking text in JSON and SSE completions", async () => {
  const provider = createAiProvider(openAiEnv());
  const malformedContents = [
    '{"text":"partial"',
    '```json\n{"text":"partial"',
  ];
  for (const content of malformedContents) {
    const completed = completedResponse(content);
    await withFetch(async () => new Response(JSON.stringify(completed), {
      headers: { "content-type": "application/json" },
    }), async () => {
      await assert.rejects(provider.generate(defaultRequest), (error: unknown) =>
        error instanceof AiProviderError && error.code === "AI_PROVIDER_INVALID_RESPONSE");
    });

    const frames = [
      sse("response.output_text.delta", { type: "response.output_text.delta", delta: content.slice(0, 8) }),
      sse("response.output_text.delta", { type: "response.output_text.delta", delta: content.slice(8) }),
      sse("response.completed", { type: "response.completed", response: completed }),
    ].map((frame) => new TextDecoder().decode(frame)).join("");
    await withFetch(async () => responseText(frames), async () => {
      await assert.rejects(provider.generate(defaultRequest), (error: unknown) =>
        error instanceof AiProviderError && error.code === "AI_PROVIDER_INVALID_RESPONSE");
    });
  }
});

test("official Responses SSE parses multiline CRLF data split across chunks", async () => {
  const provider = createAiProvider(openAiEnv());
  const output = JSON.stringify({ text: "CRLF answer", actions: [] });
  const responseJson = JSON.stringify({
    type: "response.completed",
    response: completedResponse(output),
  });
  const comma = responseJson.indexOf(",");
  const wire = `event: response.completed\r\ndata: ${responseJson.slice(0, comma + 1)}\r\ndata: ${responseJson.slice(comma + 1)}\r\n\r\n`;
  const bytes = encoder.encode(wire);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.subarray(offset, offset + 7));
      controller.close();
    },
  });
  await withFetch(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }), async () => {
    const deltas: string[] = [];
    const result = await provider.generate({
      ...defaultRequest,
      onTextDelta: async (delta) => { deltas.push(delta); },
    });
    assert.equal(result.text, "CRLF answer");
    assert.deepEqual(deltas, ["CRLF answer"]);
  });
});

test("official provider classifies auth and rate limits without exposing provider bodies", async () => {
  const provider = createAiProvider(openAiEnv());
  for (const [status, code, retryable, statusCode] of [
    [401, "AI_PROVIDER_AUTH_FAILED", false, 502],
    [429, "AI_PROVIDER_HTTP_ERROR", true, 503],
    [503, "AI_PROVIDER_HTTP_ERROR", true, 502],
  ] as const) {
    await withFetch(async () => new Response("test-provider-private-body", { status }), async () => {
      await assert.rejects(provider.generate(defaultRequest), (error: unknown) => {
        assert.ok(error instanceof AiProviderError);
        assert.equal(error.code, code);
        assert.equal(error.retryable, retryable);
        assert.equal(error.statusCode, statusCode);
        assert.equal(error.message.includes("test-provider-private-body"), false);
        assert.equal(error.message.includes("test-openai-key-01"), false);
        return true;
      });
    });
  }
});

test("official Responses API rejects truncated, failed, incomplete, and malformed event streams", async () => {
  const provider = createAiProvider(openAiEnv());
  const failureCases: Array<{ body: string; code: string }> = [
    { body: "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n", code: "AI_PROVIDER_INVALID_RESPONSE" },
    { body: "event: response.failed\ndata: {\"type\":\"response.failed\"}\n\n", code: "AI_PROVIDER_REQUEST_FAILED" },
    { body: "event: response.incomplete\ndata: {\"type\":\"response.incomplete\"}\n\n", code: "AI_PROVIDER_REQUEST_FAILED" },
    { body: "event: error\ndata: {\"type\":\"error\",\"error\":{\"message\":\"test-private-provider-error\"}}\n\n", code: "AI_PROVIDER_REQUEST_FAILED" },
    { body: "event: response.completed\ndata: {\"type\":\"response.completed\",\"response\":", code: "AI_PROVIDER_INVALID_RESPONSE" },
  ];
  for (const failureCase of failureCases) {
    await withFetch(async () => responseText(failureCase.body), async () => {
      await assert.rejects(provider.generate(defaultRequest), (error: unknown) =>
        error instanceof AiProviderError && error.code === failureCase.code);
    });
  }
});

test("official Responses API enforces response and frame limits", async () => {
  const provider = createAiProvider(openAiEnv());
  const oversizedFrame = `event: response.output_text.delta\ndata: ${JSON.stringify({
    type: "response.output_text.delta",
    delta: "x".repeat(256 * 1024),
  })}\n\n`;
  await withFetch(async () => responseText(oversizedFrame), async () => {
    await assert.rejects(provider.generate(defaultRequest), (error: unknown) =>
      error instanceof AiProviderError && error.code === "AI_PROVIDER_INVALID_RESPONSE");
  });

  await withFetch(async () => new Response("x".repeat(4 * 1024 * 1024 + 1), {
    headers: { "content-type": "application/json" },
  }), async () => {
    await assert.rejects(provider.generate(defaultRequest), (error: unknown) =>
      error instanceof AiProviderError && error.code === "AI_PROVIDER_INVALID_RESPONSE");
  });
});

test("official provider classifies request timeout", async () => {
  const provider = createAiProvider(openAiEnv({ GROWDESK_AI_TIMEOUT_MS: "100" }));
  await withFetch((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    }, { once: true });
  }), async () => {
    await assert.rejects(provider.generate(defaultRequest), (error: unknown) =>
      error instanceof AiProviderError && error.code === "AI_PROVIDER_TIMEOUT" && error.retryable && error.statusCode === 503);
  });
});

test("official API key resolver uses inline keys first and validates only explicit temporary files", () => {
  const directory = mkdtempSync(join(tmpdir(), "growdesk-test-openai-key-"));
  try {
    const keyFile = join(directory, "test-openai-key.txt");
    writeFileSync(keyFile, "  test-file-openai-key-01  \r\n", "utf8");
    const missingFile = join(directory, "missing-test-key.txt");
    const directoryFile = join(directory, "test-key-directory");
    mkdirSync(directoryFile);

    assert.equal(resolveOfficialOpenAiKey({}), null);
    assert.equal(resolveOfficialOpenAiKey({
      GROWDESK_AI_API_KEY: "test-inline-openai-key-01",
      OPENAI_API_KEY: "test-secondary-openai-key-01",
      GROWDESK_AI_API_KEY_FILE: missingFile,
    }), "test-inline-openai-key-01");
    assert.equal(resolveOfficialOpenAiKey({
      GROWDESK_AI_API_KEY: "  ",
      OPENAI_API_KEY: "test-openai-env-key-01",
      GROWDESK_AI_API_KEY_FILE: keyFile,
    }), "test-openai-env-key-01");
    assert.equal(resolveOfficialOpenAiKey({
      GROWDESK_AI_API_KEY: "  ",
      OPENAI_API_KEY: "",
      GROWDESK_AI_API_KEY_FILE: keyFile,
    }), "test-file-openai-key-01");
    assert.throws(
      () => resolveAiProviderConfig({ GROWDESK_AI_PROVIDER: "openai", GROWDESK_AI_API_KEY_FILE: missingFile }),
      (error: unknown) => error instanceof AiProviderError &&
        error.code === "AI_PROVIDER_CONFIG_INVALID" && !error.message.includes(missingFile),
    );

    const invalidFiles = [
      join(directory, "empty-test-key.txt"),
      missingFile,
      directoryFile,
      join(directory, "oversized-test-key.txt"),
      join(directory, "multiline-test-key.txt"),
    ];
    writeFileSync(invalidFiles[0]!, " \r\n\t ", "utf8");
    writeFileSync(invalidFiles[3]!, "x".repeat(16_385), "utf8");
    writeFileSync(invalidFiles[4]!, "test-key-first-line\ntest-key-second-line", "utf8");
    for (const filePath of invalidFiles) {
      assert.throws(
        () => resolveOfficialOpenAiKey({ GROWDESK_AI_API_KEY_FILE: filePath }),
        (error: unknown) => error instanceof Error &&
          error.message === "GROWDESK_AI_API_KEY_FILE must name a readable regular file with a single-line key" &&
          !error.message.includes(filePath),
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
