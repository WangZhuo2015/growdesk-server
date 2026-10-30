import type { AiModelInfo } from "@growdesk/contracts";

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

const modelUrlPrefix = /^(?:(?:[a-z][a-z0-9+.-]*:\/\/)|(?:https?|ftps?|wss?|file|data|javascript|mailto|blob|tel|ssh):|\/\/|www\.)/i;
const modelUrlHostPath = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)+(?::[0-9]+)?\//i;
function safeModelLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const label = value.trim();
  if (!label || Array.from(label).length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(label) ||
      modelUrlPrefix.test(label) || modelUrlHostPath.test(label)) return null;
  try {
    const url = new URL(label);
    if (url.protocol && url.host) return null;
  } catch { /* opaque model IDs need not be URLs */ }
  return label;
}

export function publicModelInfo(value: unknown): AiModelInfo | null {
  const candidate = asRecord(value);
  const source = safeModelLabel(candidate.source);
  const provider = safeModelLabel(candidate.provider);
  const model = safeModelLabel(candidate.model);
  if (!source || Array.from(source).length > 40 || !provider || !model) return null;
  const basis = candidate.modelBasis;
  const modelBasis = basis === "provider_response" || basis === "requested" || basis === "fixture" || basis === "unknown"
    ? basis : undefined;
  return { source, provider, model, ...(modelBasis ? { modelBasis } : {}) };
}

export function messageModelInfoFromToolsJson(toolsJson: string | null): AiModelInfo | null {
  if (!toolsJson || toolsJson.length > 200_000) return null;
  try {
    const traces: unknown = JSON.parse(toolsJson);
    if (!Array.isArray(traces)) return null;
    for (const trace of traces) {
      const entry = asRecord(trace);
      if (entry.type === "llm_model") return publicModelInfo(entry.llm);
    }
  } catch { return null; }
  return null;
}
