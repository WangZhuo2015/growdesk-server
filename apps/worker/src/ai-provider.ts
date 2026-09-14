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
  readonly mode: "unconfigured" | "fixture" | "openai-compatible";
  readonly baseUrl: string | null;
  readonly apiKey: string | null;
  readonly model: string | null;
  readonly timeoutMs: number;
  readonly fixtureResponse: string | null;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 180_000;

function parseTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_MS;
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

/** Resolve configuration without opening a socket or contacting a provider. */
export function resolveAiProviderConfig(env: NodeJS.ProcessEnv = process.env): AiProviderConfig {
  const mode = (env.GROWDESK_AI_PROVIDER ?? "").trim().toLowerCase();
  const timeoutMs = parseTimeout(env.GROWDESK_AI_TIMEOUT_MS);

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
  if (mode !== "openai-compatible" && mode !== "openai" && mode !== "compat") {
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
    return result;
  }
}

interface ProviderStreamState {
  text: string;
  toolArguments: string;
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
        return { text: parsed.text || state.text, actions: actions.length > 0 ? actions : parsed.actions, usage: state.usage };
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
      return { text: parsed.text || content, actions: parsed.actions, usage: asRecord(root?.usage) ?? undefined };
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

export function createAiProvider(env: NodeJS.ProcessEnv = process.env): AiProvider {
  const config = resolveAiProviderConfig(env);
  if (config.mode === "fixture") return new FixtureAiProvider(config);
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
