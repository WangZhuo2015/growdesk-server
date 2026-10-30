import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

const MAX_KEY_FILE_BYTES = 16_384;
const KEY_FILE_ERROR = "GROWDESK_AI_API_KEY_FILE must name a readable regular file with a single-line key";

/** Resolve the official OpenAI key without consulting implicit filesystem paths. */
export function resolveOfficialOpenAiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const inlineKey = env.GROWDESK_AI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim();
  if (inlineKey) return inlineKey;

  const filePath = env.GROWDESK_AI_API_KEY_FILE;
  if (!filePath?.trim()) return null;

  let descriptor: number | undefined;
  try {
    descriptor = openSync(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(descriptor).isFile()) throw new Error();

    const bytes = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
    const byteCount = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (byteCount > MAX_KEY_FILE_BYTES) throw new Error();

    const rawKey = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, byteCount));
    const key = rawKey.trim();
    if (!key || /[\s\p{C}]/u.test(key)) throw new Error();
    return key;
  } catch {
    throw new Error(KEY_FILE_ERROR);
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Keep close errors opaque as well; never attach filesystem details to the key resolver error.
      }
    }
  }
}
