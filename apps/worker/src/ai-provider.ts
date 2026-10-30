import { resolveOfficialOpenAiKey } from "@growdesk/adapters";
import { createHash } from "node:crypto";

export interface AiProviderRequest {
  readonly sessionId: string;
  readonly babyId: string | null;
  readonly message: string;
  readonly attachmentIds: ReadonlyArray<string>;
  readonly onTextDelta?: (delta: string) => Promise<void>;
}

export interface AiProviderAction {
  readonly actionId: string;
  readonly entityType: string;
  readonly operation: string;
  readonly summary: string;
  readonly payload: Record<string, unknown>;
}

export interface AiProviderResult {
  readonly text: string;
  readonly actions: ReadonlyArray<AiProviderAction>;
  readonly usage?: Record<string, unknown>;
  readonly llm?: AiModelInfo;
}

export interface AiModelInfo {
  readonly source: string;
  readonly provider: string;
  readonly model: string;
  readonly modelBasis?: "provider_response" | "requested" | "fixture" | "unknown";
}

export interface AiProvider {
  readonly name: string;
  generate(request: AiProviderRequest): Promise<AiProviderResult>;
}

export class AiProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    message: string,
    code = "AI_PROVIDER_ERROR",
    options: { readonly retryable?: boolean; readonly statusCode?: number } = {},
  ) {
    super(message);
    this.name = "AiProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode ?? 502;
  }
}

export interface AiProviderConfig {
  readonly mode: "unconfigured" | "fixture" | "openai-compatible" | "openai";
  readonly baseUrl: string | null;
  readonly apiKey: string | null;
  readonly model: string | null;
  readonly timeoutMs: number;
  readonly fixtureResponse: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const OPENAI_DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const MAX_OPENAI_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_OPENAI_SSE_FRAME_BYTES = 256 * 1024;
const MAX_OPENAI_SSE_FRAMES = 50_000;
const modelUrlPrefix = /^(?:(?:[a-z][a-z0-9+.-]*:\/\/)|(?:https?|ftps?|wss?|file|data|javascript|mailto|blob|tel|ssh):|\/\/|www\.)/i;
const modelUrlHostPath = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+(?::[0-9]+)?\//i;

function safeModelLabel(value: string | null | undefined, apiKey: string | null): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (!label || Array.from(label).length > 200 || /\p{Cc}/u.test(label) ||
      modelUrlPrefix.test(label) || modelUrlHostPath.test(label) || (apiKey && label.includes(apiKey))) return null;
  try {
    const url = new URL(label);
    if (url.protocol && url.host) return null;
  } catch { /* opaque model IDs need not be URLs */ }
  return label;
}

function modelInfo(config: AiProviderConfig, responseModel?: string): AiModelInfo {
  const provider = config.baseUrl ? safeModelLabel(new URL(config.baseUrl).hostname, config.apiKey) : "fixture";
  if (config.mode === "fixture") {
    return { source: "api", provider: provider || "fixture", model: safeModelLabel(config.model, config.apiKey) || "test-fixture", modelBasis: "fixture" };
  }
  const echoed = safeModelLabel(responseModel, config.apiKey);
  const requested = safeModelLabel(config.model, config.apiKey);
  return {
    source: "api",
    provider: provider || "unknown",
    model: echoed || requested || "unknown",
    modelBasis: echoed ? "provider_response" : requested ? "requested" : "unknown",
  };
}

function parseTimeout(raw: string | undefined, defaultMs = DEFAULT_TIMEOUT_MS): number {
  if (!raw) return defaultMs;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 100 || value > MAX_TIMEOUT_MS) {
    throw new AiProviderError(
      `GROWDESK_AI_TIMEOUT_MS must be between 100 and ${MAX_TIMEOUT_MS}`,
      "AI_PROVIDER_CONFIG_INVALID",
      { statusCode: 500 },
    );
  }
  return Math.floor(value);
}

function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AiProviderError("GROWDESK_AI_BASE_URL must be a valid URL", "AI_PROVIDER_CONFIG_INVALID", {
      statusCode: 500,
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new AiProviderError(
      "GROWDESK_AI_BASE_URL must use http or https",
      "AI_PROVIDER_CONFIG_INVALID",
      { statusCode: 500 },
    );
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/chat/completions")
    ? pathname
    : `${pathname}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeOfficialResponsesUrl(raw: string | undefined): string {
  if (!raw?.trim()) return OPENAI_RESPONSES_URL;
  const value = raw.trim();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AiProviderError("GROWDESK_AI_BASE_URL is not an allowed OpenAI API URL", "AI_PROVIDER_CONFIG_INVALID", {
      statusCode: 500,
    });
  }
  const authority = value.match(/^https:\/\/([^/?#]*)/i)?.[1];
  const allowedPaths = new Set(["", "/", "/v1", "/v1/", "/v1/responses"]);
  if (url.protocol !== "https:" || url.hostname !== "api.openai.com" || !authority ||
      !/^api\.openai\.com$/i.test(authority) || url.username || url.password || url.port ||
      /[?#]/.test(value) || !allowedPaths.has(url.pathname)) {
    throw new AiProviderError(
      "GROWDESK_AI_BASE_URL must be the official OpenAI API root, /v1, or /v1/responses URL",
      "AI_PROVIDER_CONFIG_INVALID",
      { statusCode: 500 },
    );
  }
  return OPENAI_RESPONSES_URL;
}

/** Resolve configuration without opening a socket or contacting a provider. */
export function resolveAiProviderConfig(env: NodeJS.ProcessEnv = process.env): AiProviderConfig {
  const mode = (env.GROWDESK_AI_PROVIDER ?? "").trim().toLowerCase();
  const timeoutMs = parseTimeout(
    env.GROWDESK_AI_TIMEOUT_MS,
    mode === "openai" ? OPENAI_DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
  );

  if (mode === "") {
    return { mode: "unconfigured", baseUrl: null, apiKey: null, model: null, timeoutMs, fixtureResponse: null };
  }
  if (mode === "fixture") {
    return {
      mode,
      baseUrl: null,
      apiKey: null,
      model: env.GROWDESK_AI_MODEL?.trim() || "fixture",
      timeoutMs,
      fixtureResponse: env.GROWDESK_AI_FIXTURE_RESPONSE ?? env.GROWDESK_AI_FIXTURE_TEXT ?? null,
    };
  }
  if (mode === "openai") {
    const baseUrl = normalizeOfficialResponsesUrl(env.GROWDESK_AI_BASE_URL);
    let apiKey: string | null;
    try {
      apiKey = resolveOfficialOpenAiKey(env);
    } catch {
      throw new AiProviderError(
        "Official OpenAI API key configuration is invalid",
        "AI_PROVIDER_CONFIG_INVALID",
        { statusCode: 500 },
      );
    }
    const model = env.GROWDESK_AI_MODEL?.trim() || "gpt-6-luna";
    if (!apiKey) {
      return { mode: "unconfigured", baseUrl, apiKey: null, model, timeoutMs, fixtureResponse: null };
    }
    return { mode: "openai", baseUrl, apiKey, model, timeoutMs, fixtureResponse: null };
  }
  if (mode !== "openai-compatible" && mode !== "compat") {
    throw new AiProviderError(`Unsupported GROWDESK_AI_PROVIDER '${mode}'`, "AI_PROVIDER_CONFIG_INVALID", {
      statusCode: 500,
    });
  }

  const baseRaw = env.GROWDESK_AI_BASE_URL?.trim();
  const apiKey = (env.GROWDESK_AI_API_KEY ?? env.AI_API_KEY ?? env.OPENAI_API_KEY ?? "").trim();
  if (!baseRaw || !apiKey) {
    return {
      mode: "unconfigured",
      baseUrl: baseRaw ? normalizeBaseUrl(baseRaw) : null,
      apiKey: apiKey || null,
      model: env.GROWDESK_AI_MODEL?.trim() || null,
      timeoutMs,
      fixtureResponse: null,
    };
  }
  return {
    mode: "openai-compatible",
    baseUrl: normalizeBaseUrl(baseRaw),
    apiKey,
    model: env.GROWDESK_AI_MODEL?.trim() || "gpt-4o-mini",
    timeoutMs,
    fixtureResponse: null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function parseActions(value: unknown): AiProviderAction[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new AiProviderError("Provider actions must be an array", "AI_PROVIDER_INVALID_RESPONSE");
  }
  return value.map((candidate, index) => {
    const action = asRecord(candidate);
    const actionId = typeof action?.actionId === "string" ? action.actionId : "";
    const entityType = typeof action?.entityType === "string" ? action.entityType : "";
    const operation = typeof action?.operation === "string" ? action.operation : "";
    const summary = typeof action?.summary === "string" ? action.summary : "";
    const payload = asRecord(action?.payload);
    if (!actionId || !entityType || !operation || !summary || !payload) {
      throw new AiProviderError(
        `Provider action at index ${index} is missing actionId, entityType, operation, summary, or payload`,
        "AI_PROVIDER_INVALID_RESPONSE",
      );
    }
    return { actionId, entityType, operation, summary, payload };
  });
}

function parseAssistantContent(content: string): { text: string; actions: AiProviderAction[] } {
  const normalized = stripJsonFence(content);
  try {
    const parsed = JSON.parse(normalized) as unknown;
    const record = asRecord(parsed);
    if (!record) return { text: content, actions: [] };
    return {
      text: typeof record.text === "string" ? record.text : "",
      actions: parseActions(record.actions ?? record.proposedActions),
    };
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    return { text: content, actions: [] };
  }
}

async function emitText(request: AiProviderRequest, delta: string): Promise<void> {
  if (delta && request.onTextDelta) await request.onTextDelta(delta);
}

function parseFixtureResponse(raw: string): { text: string; actions: AiProviderAction[]; usage?: Record<string, unknown> } {
  const parsedContent = parseAssistantContent(raw);
  let value: unknown = null;
  try {
    value = JSON.parse(raw);
  } catch {
    // Plain fixture text is valid and intentionally has no actions.
  }
  const record = asRecord(value);
  if (!record) return parsedContent;
  const text = typeof record.text === "string" ? record.text : parsedContent.text;
  const actions = record.actions === undefined ? parsedContent.actions : parseActions(record.actions);
  return { text, actions, usage: asRecord(record.usage) ?? undefined };
}

class FixtureAiProvider implements AiProvider {
  readonly name = "fixture";

  constructor(private readonly config: AiProviderConfig) {}

  async generate(request: AiProviderRequest): Promise<AiProviderResult> {
    if (!this.config.fixtureResponse) {
      throw new AiProviderError(
        "GROWDESK_AI_FIXTURE_RESPONSE or GROWDESK_AI_FIXTURE_TEXT is required when fixture provider is selected",
        "AI_PROVIDER_NOT_CONFIGURED",
        { statusCode: 503 },
      );
    }
    const result = parseFixtureResponse(this.config.fixtureResponse);
    await emitText(request, result.text);
    return { ...result, llm: modelInfo(this.config) };
  }
}

interface ProviderStreamState {
  text: string;
  toolArguments: string;
  model?: string;
  usage?: Record<string, unknown>;
}

async function parseStreamData(
  data: string,
  state: ProviderStreamState,
  request: AiProviderRequest,
): Promise<void> {
  if (data === "[DONE]") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new AiProviderError("Provider returned malformed streaming JSON", "AI_PROVIDER_INVALID_RESPONSE");
  }
  const root = asRecord(parsed);
  if (typeof root?.model === "string" && root.model) state.model = root.model;
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  const choice = asRecord(choices[0]);
  const delta = asRecord(choice?.delta);
  const content = typeof delta?.content === "string" ? delta.content : "";
  if (content) state.text += content;
  const toolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
  for (const toolCall of toolCalls) {
    const fn = asRecord(asRecord(toolCall)?.function);
    if (typeof fn?.arguments === "string") state.toolArguments += fn.arguments;
  }
  const usage = asRecord(root?.usage);
  if (usage) state.usage = usage;
  await emitText(request, content);
}

async function readResponseBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    output += decoder.decode(chunk.value, { stream: true });
  }
  return output + decoder.decode();
}

class OpenAiCompatibleProvider implements AiProvider {
  readonly name = "openai-compatible";

  constructor(private readonly config: AiProviderConfig) {}

  async generate(request: AiProviderRequest): Promise<AiProviderResult> {
    if (!this.config.baseUrl || !this.config.apiKey || !this.config.model) {
      throw new AiProviderError(
        "GROWDESK_AI_BASE_URL, GROWDESK_AI_API_KEY, and GROWDESK_AI_MODEL are required",
        "AI_PROVIDER_NOT_CONFIGURED",
        { statusCode: 503 },
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const response = await fetch(this.config.baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({
          model: this.config.model,
          stream: true,
          messages: [
            {
              role: "system",
              content:
                "You are GrowDesk's private baby-care assistant. Return JSON with a text string and an actions array. Use an empty actions array for read-only answers.",
            },
            { role: "user", content: request.message },
          ],
          metadata: { sessionId: request.sessionId, babyId: request.babyId, attachmentIds: request.attachmentIds },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
        throw new AiProviderError(
          `AI provider returned HTTP ${response.status}`,
          response.status === 401 || response.status === 403 ? "AI_PROVIDER_AUTH_FAILED" : "AI_PROVIDER_HTTP_ERROR",
          { retryable, statusCode: response.status === 429 ? 503 : 502 },
        );
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      const raw = await readResponseBody(response);
      if (contentType.includes("text/event-stream")) {
        const state: ProviderStreamState = { text: "", toolArguments: "" };
        const normalized = raw.replace(/\r\n/g, "\n");
        for (const frame of normalized.split("\n\n")) {
          const dataLines = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart());
          if (dataLines.length > 0) await parseStreamData(dataLines.join("\n"), state, request);
        }
        let actions: AiProviderAction[] = [];
        if (state.toolArguments) {
          let toolPayload: unknown;
          try {
            toolPayload = JSON.parse(state.toolArguments);
          } catch {
            throw new AiProviderError("Provider returned malformed tool arguments", "AI_PROVIDER_INVALID_RESPONSE");
          }
          const toolRecord = asRecord(toolPayload);
          actions = parseActions(toolRecord?.actions ?? toolPayload);
        }
        const parsed = parseAssistantContent(state.text);
        return { text: parsed.text || state.text, actions: actions.length > 0 ? actions : parsed.actions, usage: state.usage,
          llm: modelInfo(this.config, state.model) };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw new AiProviderError("Provider returned malformed JSON", "AI_PROVIDER_INVALID_RESPONSE");
      }
      const root = asRecord(payload);
      const choices = Array.isArray(root?.choices) ? root.choices : [];
      const choice = asRecord(choices[0]);
      const message = asRecord(choice?.message);
      const content = typeof message?.content === "string" ? message.content : "";
      const parsed = parseAssistantContent(content);
      await emitText(request, parsed.text || content);
      return { text: parsed.text || content, actions: parsed.actions, usage: asRecord(root?.usage) ?? undefined,
        llm: modelInfo(this.config, typeof root?.model === "string" ? root.model : undefined) };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new AiProviderError("AI provider request timed out", "AI_PROVIDER_TIMEOUT", { retryable: true, statusCode: 503 });
      }
      throw new AiProviderError(error instanceof Error ? error.message : String(error), "AI_PROVIDER_NETWORK_ERROR", {
        retryable: true,
        statusCode: 503,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface OpenAiResponsesStreamState {
  deltaText: string;
  deltaBytes: number;
  deltaMode: "undecided" | "plain" | "structured";
  pendingText: string;
  completedText: string | null;
  model?: string;
  usage?: Record<string, unknown>;
  completed: boolean;
}

function invalidOpenAiResponse(message = "OpenAI returned an invalid Responses API response"): AiProviderError {
  return new AiProviderError(message, "AI_PROVIDER_INVALID_RESPONSE");
}

function assertOpenAiCompleted(response: Record<string, unknown>): void {
  if (response.type === "error" || (response.error !== undefined && response.error !== null)) {
    throw new AiProviderError("OpenAI Responses request did not complete successfully", "AI_PROVIDER_REQUEST_FAILED");
  }
  if (response.status === "failed" || response.status === "incomplete" || response.status === "cancelled") {
    throw new AiProviderError("OpenAI Responses request did not complete successfully", "AI_PROVIDER_REQUEST_FAILED");
  }
  if (response.status !== "completed") throw invalidOpenAiResponse();
}

function parseOpenAiOutput(response: Record<string, unknown>): { text: string; model?: string; usage?: Record<string, unknown> } {
  assertOpenAiCompleted(response);
  if (!Array.isArray(response.output)) throw invalidOpenAiResponse();
  let text = "";
  for (const candidate of response.output) {
    const item = asRecord(candidate);
    if (!item) throw invalidOpenAiResponse();
    if (item.type !== "message") continue;
    if (!Array.isArray(item.content)) throw invalidOpenAiResponse();
    for (const partCandidate of item.content) {
      const part = asRecord(partCandidate);
      if (!part) throw invalidOpenAiResponse();
      if (part.type === "output_text") {
        if (typeof part.text !== "string") throw invalidOpenAiResponse();
        text += part.text;
        if (Buffer.byteLength(text, "utf8") > MAX_OPENAI_RESPONSE_BYTES) throw invalidOpenAiResponse();
      }
    }
  }
  if (!text.trim()) throw invalidOpenAiResponse("OpenAI Responses API completed without output text");
  return {
    text,
    model: typeof response.model === "string" ? response.model : undefined,
    usage: asRecord(response.usage) ?? undefined,
  };
}

function parseOpenAiAssistantContent(content: string): { text: string; actions: AiProviderAction[] } {
  const normalized = stripJsonFence(content).trim();
  const jsonFence = content.trim().match(/^```json\s*([\s\S]*)$/i);
  let fencedCandidate = jsonFence?.[1]?.trim();
  if (fencedCandidate?.endsWith("```")) fencedCandidate = fencedCandidate.slice(0, -3).trimEnd();
  const structuredCandidate = normalized.startsWith("{") || normalized.startsWith("[")
    ? normalized
    : fencedCandidate?.startsWith("{") || fencedCandidate?.startsWith("[")
      ? fencedCandidate
      : null;
  if (structuredCandidate !== null) {
    try {
      JSON.parse(structuredCandidate);
    } catch {
      throw invalidOpenAiResponse("OpenAI Responses API returned malformed structured text");
    }
  }

  const parsed = parseAssistantContent(content);
  if (parsed.text.trim()) return parsed;
  if (!content.trim()) throw invalidOpenAiResponse("OpenAI Responses API completed without assistant text");
  try {
    const envelope = asRecord(JSON.parse(stripJsonFence(content)) as unknown);
    if (envelope && typeof envelope.text === "string") {
      throw invalidOpenAiResponse("OpenAI Responses API completed without assistant text");
    }
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    // Non-envelope structured text remains a valid raw assistant response.
  }
  return { text: content, actions: parsed.actions };
}

function appendOpenAiDelta(state: OpenAiResponsesStreamState, delta: string): void {
  const byteLength = Buffer.byteLength(delta, "utf8");
  if (state.deltaBytes + byteLength > MAX_OPENAI_RESPONSE_BYTES) throw invalidOpenAiResponse();
  state.deltaBytes += byteLength;
  state.deltaText += delta;
}

async function acceptOpenAiDelta(
  state: OpenAiResponsesStreamState,
  request: AiProviderRequest,
  delta: string,
): Promise<void> {
  appendOpenAiDelta(state, delta);
  if (state.deltaMode === "plain") {
    await emitText(request, delta);
    return;
  }
  if (state.deltaMode === "structured") return;

  state.pendingText += delta;
  const firstNonWhitespace = state.pendingText.trimStart()[0];
  if (!firstNonWhitespace) return;
  if (firstNonWhitespace === "{" || firstNonWhitespace === "[" || firstNonWhitespace === "`") {
    state.deltaMode = "structured";
    return;
  }
  state.deltaMode = "plain";
  await emitText(request, state.pendingText);
  state.pendingText = "";
}

async function parseOpenAiSseFrame(
  frame: string,
  state: OpenAiResponsesStreamState,
  request: AiProviderRequest,
): Promise<void> {
  if (Buffer.byteLength(frame, "utf8") > MAX_OPENAI_SSE_FRAME_BYTES) throw invalidOpenAiResponse();
  let eventName = "";
  const dataLines: string[] = [];
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return;
  const data = dataLines.join("\n");
  if (data === "[DONE]") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw invalidOpenAiResponse();
  }
  const root = asRecord(parsed);
  if (!root) throw invalidOpenAiResponse();
  const type = typeof root.type === "string" ? root.type : eventName;
  if (type === "error" || eventName === "error" || type === "response.failed" || type === "response.incomplete") {
    throw new AiProviderError("OpenAI Responses request did not complete successfully", "AI_PROVIDER_REQUEST_FAILED", {
      retryable: type === "response.failed",
    });
  }
  if (state.completed) throw invalidOpenAiResponse();
  if (type === "response.output_text.delta") {
    if (typeof root.delta !== "string") throw invalidOpenAiResponse();
    await acceptOpenAiDelta(state, request, root.delta);
    return;
  }
  if (type === "response.completed") {
    const response = asRecord(root.response);
    if (!response) throw invalidOpenAiResponse();
    const output = parseOpenAiOutput(response);
    if (state.deltaText && state.deltaText !== output.text) {
      throw invalidOpenAiResponse("OpenAI Responses stream text did not match the completed response");
    }
    state.completedText = output.text;
    state.model = output.model;
    state.usage = output.usage;
    state.completed = true;
  }
}

function lineEndingLength(value: string, index: number): number {
  if (value[index] === "\n") return 1;
  if (value[index] !== "\r") return 0;
  return value[index + 1] === "\n" ? 2 : 1;
}

function findSseFrameSeparator(value: string, fromIndex = 0): { index: number; length: number } | null {
  for (let index = fromIndex; index < value.length; index += 1) {
    const firstLength = lineEndingLength(value, index);
    if (!firstLength) continue;
    const secondIndex = index + firstLength;
    const secondLength = lineEndingLength(value, secondIndex);
    if (secondLength) return { index, length: firstLength + secondLength };
  }
  return null;
}

async function readOpenAiSse(
  response: Response,
  state: OpenAiResponsesStreamState,
  request: AiProviderRequest,
): Promise<void> {
  if (!response.body) throw invalidOpenAiResponse();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let scanFrom = 0;
  let lastBufferLengthChecked = 0;
  let totalBytes = 0;
  let frameCount = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_OPENAI_RESPONSE_BYTES) throw invalidOpenAiResponse();
      buffer += decoder.decode(chunk.value, { stream: true });
      while (true) {
        const separator = findSseFrameSeparator(buffer, scanFrom);
        if (!separator) {
          scanFrom = Math.max(0, buffer.length - 3);
          break;
        }
        if (++frameCount > MAX_OPENAI_SSE_FRAMES) throw invalidOpenAiResponse();
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator.length);
        scanFrom = 0;
        lastBufferLengthChecked = 0;
        await parseOpenAiSseFrame(frame, state, request);
        if (state.completed) {
          await reader.cancel().catch(() => undefined);
          complete = true;
          return;
        }
      }
      if (buffer.length - lastBufferLengthChecked >= 4096 || buffer.length > MAX_OPENAI_SSE_FRAME_BYTES) {
        lastBufferLengthChecked = buffer.length;
        if (Buffer.byteLength(buffer, "utf8") > MAX_OPENAI_SSE_FRAME_BYTES) throw invalidOpenAiResponse();
      }
    }
    if (Buffer.byteLength(buffer, "utf8") > MAX_OPENAI_SSE_FRAME_BYTES) throw invalidOpenAiResponse();
    if (buffer.trim()) throw invalidOpenAiResponse("OpenAI Responses stream ended with an incomplete event");
    if (!state.completed) throw invalidOpenAiResponse("OpenAI Responses stream ended without response.completed");
    complete = true;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function readOpenAiJson(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let totalBytes = 0;
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > MAX_OPENAI_RESPONSE_BYTES) throw invalidOpenAiResponse();
      text += decoder.decode(chunk.value, { stream: true });
    }
    complete = true;
    return text;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

class OpenAiResponsesProvider implements AiProvider {
  readonly name = "openai";

  constructor(private readonly config: AiProviderConfig) {}

  async generate(request: AiProviderRequest): Promise<AiProviderResult> {
    if (!this.config.baseUrl || !this.config.apiKey || !this.config.model) {
      throw new AiProviderError("OpenAI API key is not configured", "AI_PROVIDER_NOT_CONFIGURED", { statusCode: 503 });
    }
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);
    try {
      const response = await fetch(this.config.baseUrl, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream, application/json",
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify({
          model: this.config.model,
          stream: true,
          store: false,
          instructions:
            "You are GrowDesk's private baby-care assistant. Return JSON with a text string and an actions array. Use an empty actions array for read-only answers. Actions are proposals only; never claim a write has occurred or that you authorize server scope.",
          input: request.message,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const retryable = response.status === 408 || response.status === 409 || response.status === 429 || response.status >= 500;
        throw new AiProviderError(
          `AI provider returned HTTP ${response.status}`,
          response.status === 401 || response.status === 403 ? "AI_PROVIDER_AUTH_FAILED" : "AI_PROVIDER_HTTP_ERROR",
          { retryable, statusCode: response.status === 429 ? 503 : 502 },
        );
      }
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.includes("text/event-stream")) {
        const state: OpenAiResponsesStreamState = {
          deltaText: "",
          deltaBytes: 0,
          deltaMode: "undecided",
          pendingText: "",
          completedText: null,
          completed: false,
        };
        await readOpenAiSse(response, state, request);
        const content = state.completedText ?? state.deltaText;
        const parsed = parseOpenAiAssistantContent(content);
        if (state.deltaMode !== "plain") await emitText(request, parsed.text);
        return {
          text: parsed.text,
          actions: parsed.actions,
          usage: state.usage,
          llm: modelInfo(this.config, state.model),
        };
      }
      const raw = await readOpenAiJson(response);
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        throw invalidOpenAiResponse("OpenAI returned malformed JSON");
      }
      const root = asRecord(payload);
      if (!root) throw invalidOpenAiResponse();
      const output = parseOpenAiOutput(root);
      const parsed = parseOpenAiAssistantContent(output.text);
      await emitText(request, parsed.text);
      return {
        text: parsed.text,
        actions: parsed.actions,
        usage: output.usage,
        llm: modelInfo(this.config, output.model),
      };
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      if (timedOut || (error instanceof Error && error.name === "AbortError")) {
        throw new AiProviderError("AI provider request timed out", "AI_PROVIDER_TIMEOUT", { retryable: true, statusCode: 503 });
      }
      throw new AiProviderError("OpenAI Responses request failed", "AI_PROVIDER_NETWORK_ERROR", {
        retryable: true,
        statusCode: 503,
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createAiProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
  const config = resolveAiProviderConfig(env);
  if (config.mode === "fixture") return new FixtureAiProvider(config);
  if (config.mode === "openai") return new OpenAiResponsesProvider(config);
  if (config.mode === "openai-compatible") return new OpenAiCompatibleProvider(config);
  return {
    name: "unconfigured",
    async generate(): Promise<AiProviderResult> {
      throw new AiProviderError(
        "An AI provider is not configured. Set GROWDESK_AI_PROVIDER=fixture with an explicit fixture response for tests, or configure the approved provider and key.",
        "AI_PROVIDER_NOT_CONFIGURED",
        { statusCode: 503 },
      );
    },
  };
}

export function planHash(actions: ReadonlyArray<AiProviderAction>): string {
  return createHash("sha256").update(JSON.stringify(actions)).digest("hex");
}
