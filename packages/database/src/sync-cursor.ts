import crypto from "node:crypto";
import { InvalidSyncCursorError } from "./errors.js";

export interface SyncCursorPayload {
  readonly scope: "family" | "user";
  readonly scopeId: string;
  readonly epoch: string;
  readonly position: string; // BigInt as string
  readonly highWater: string; // BigInt as string
  readonly mode: "page" | "tail";
  readonly schemaVersion: number;
}

/**
 * Signs and encodes a SyncCursorPayload into an opaque token.
 * Token structure: `${base64url(JSON)}.${hmacSha256Hex}`
 */
export function encodeSyncCursor(
  payload: SyncCursorPayload,
  secret: string
): string {
  const jsonStr = JSON.stringify({
    scope: payload.scope,
    scopeId: payload.scopeId,
    epoch: payload.epoch,
    position: payload.position,
    highWater: payload.highWater,
    mode: payload.mode,
    schemaVersion: payload.schemaVersion,
  });

  const b64Data = Buffer.from(jsonStr, "utf8").toString("base64url");
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(jsonStr)
    .digest("hex");

  return `${b64Data}.${hmac}`;
}

/**
 * Decodes, authenticates, and validates an opaque sync cursor token.
 * Throws InvalidSyncCursorError on malformed, tampered, or mismatched scope/scopeId.
 */
export function decodeSyncCursor(
  rawToken: string,
  secret: string,
  expectedScope: "family" | "user",
  expectedScopeId: string
): SyncCursorPayload {
  if (!rawToken || typeof rawToken !== "string") {
    throw new InvalidSyncCursorError("Missing or non-string sync cursor");
  }

  const parts = rawToken.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new InvalidSyncCursorError("Malformed sync cursor token format");
  }

  const b64Data = parts[0];
  const providedHmac = parts[1];
  let jsonStr: string;
  try {
    jsonStr = Buffer.from(b64Data, "base64url").toString("utf8");
  } catch {
    throw new InvalidSyncCursorError("Invalid base64 encoding in sync cursor");
  }

  const expectedHmac = crypto
    .createHmac("sha256", secret)
    .update(jsonStr)
    .digest("hex");

  const providedBuf = Buffer.from(providedHmac, "hex");
  const expectedBuf = Buffer.from(expectedHmac, "hex");

  if (
    providedBuf.length !== expectedBuf.length ||
    !crypto.timingSafeEqual(providedBuf, expectedBuf)
  ) {
    throw new InvalidSyncCursorError("Tampered or invalid sync cursor signature");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new InvalidSyncCursorError("Corrupted JSON body in sync cursor");
  }

  if (
    parsed.scope !== expectedScope ||
    parsed.scopeId !== expectedScopeId
  ) {
    throw new InvalidSyncCursorError(
      `Sync cursor scope mismatch: expected ${expectedScope}:${expectedScopeId}, got ${parsed.scope}:${parsed.scopeId}`
    );
  }

  if (!parsed.epoch || typeof parsed.epoch !== "string") {
    throw new InvalidSyncCursorError("Missing epoch in sync cursor");
  }

  if (
    parsed.position === undefined ||
    typeof parsed.position !== "string" ||
    !/^\d+$/.test(parsed.position)
  ) {
    throw new InvalidSyncCursorError("Invalid position in sync cursor");
  }

  if (
    parsed.highWater === undefined ||
    typeof parsed.highWater !== "string" ||
    !/^\d+$/.test(parsed.highWater)
  ) {
    throw new InvalidSyncCursorError("Invalid highWater in sync cursor");
  }

  if (parsed.mode !== "page" && parsed.mode !== "tail") {
    throw new InvalidSyncCursorError("Invalid cursor mode; must be 'page' or 'tail'");
  }

  return {
    scope: parsed.scope as "family" | "user",
    scopeId: parsed.scopeId as string,
    epoch: parsed.epoch as string,
    position: parsed.position as string,
    highWater: parsed.highWater as string,
    mode: parsed.mode as "page" | "tail",
    schemaVersion: Number(parsed.schemaVersion ?? 1),
  };
}
