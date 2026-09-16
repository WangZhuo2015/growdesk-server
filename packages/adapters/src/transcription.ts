/** Provider-independent, bounded audio transcription. Configuration never comes from HTTP callers. */
export interface TranscriptionInput { bytes: Uint8Array; mimeType: string; signal?: AbortSignal }
export interface Transcriber { transcribe(input: TranscriptionInput): Promise<string> }
export class TranscriptionError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 503) { super(message); }
}
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const extensions: Record<string, string> = {
  "audio/webm": "webm", "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/mp4": "m4a",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac",
};
export function audioExtension(mimeType: string): string {
  const extension = extensions[mimeType.split(";")[0]!.trim().toLowerCase()];
  if (!extension) throw new TranscriptionError("UNSUPPORTED_AUDIO_TYPE", "Unsupported audio format", 415);
  return extension;
}
export function transcriptionConfig(env: NodeJS.ProcessEnv = process.env) {
  const base = env.GROWDESK_TRANSCRIPTION_BASE_URL?.trim();
  const key = env.GROWDESK_TRANSCRIPTION_API_KEY?.trim();
  const model = env.GROWDESK_TRANSCRIPTION_MODEL?.trim();
  if (!base || !key || !model) throw new TranscriptionError("TRANSCRIPTION_NOT_CONFIGURED", "Configure the transcription URL, API key and model");
  let url: URL;
  try { url = new URL(base); } catch { throw new TranscriptionError("TRANSCRIPTION_INVALID_CONFIG", "Invalid transcription URL"); }
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new TranscriptionError("TRANSCRIPTION_INVALID_CONFIG", "Transcription endpoint must use HTTPS or loopback HTTP");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/audio/transcriptions`;
  const timeoutMs = Number(env.GROWDESK_TRANSCRIPTION_TIMEOUT_MS ?? 60_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 180_000) throw new TranscriptionError("TRANSCRIPTION_INVALID_CONFIG", "Invalid transcription timeout");
  return { url: url.toString(), key, model, timeoutMs };
}

export function createTranscriber(env: NodeJS.ProcessEnv = process.env, fetchApi: typeof fetch = fetch): Transcriber {
  return {
    async transcribe({ bytes, mimeType, signal }) {
      const config = transcriptionConfig(env);
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_AUDIO_BYTES) throw new TranscriptionError("INVALID_AUDIO_SIZE", "Audio is empty or exceeds the configured limit", 413);
      const form = new FormData();
      form.set("model", config.model);
      form.set("response_format", "json");
      form.set("file", new Blob([Uint8Array.from(bytes).buffer], { type: mimeType }), `recording.${audioExtension(mimeType)}`);
      const timeout = AbortSignal.timeout(config.timeoutMs);
      let response: Response;
      try {
        response = await fetchApi(config.url, { method: "POST", headers: { authorization: `Bearer ${config.key}` }, body: form,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error" });
      } catch { throw new TranscriptionError("TRANSCRIPTION_TRANSPORT_ERROR", "Transcription request failed or timed out", 502); }
      if (!response.ok) throw new TranscriptionError("TRANSCRIPTION_UPSTREAM_ERROR", `Transcription provider returned HTTP ${response.status}`, response.status === 429 ? 429 : 502);
      const reader = response.body?.getReader();
      if (!reader) throw new TranscriptionError("TRANSCRIPTION_INVALID_RESPONSE", "Provider returned no response body", 502);
      const chunks: Uint8Array[] = []; let length = 0;
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break;
          length += next.value.byteLength;
          if (length > 1_000_000) { await reader.cancel(); throw new TranscriptionError("TRANSCRIPTION_INVALID_RESPONSE", "Provider response exceeds limit", 502); }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new TranscriptionError("TRANSCRIPTION_INVALID_RESPONSE", "Provider did not return valid JSON", 502); }
      if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string" || !value.text.trim() || value.text.length > 200_000) {
        throw new TranscriptionError("TRANSCRIPTION_INVALID_RESPONSE", "Provider did not return a usable transcript", 502);
      }
      return value.text.trim();
    },
  };
}
