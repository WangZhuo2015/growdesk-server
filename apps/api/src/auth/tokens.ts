import * as jose from "jose";
import crypto from "node:crypto";

const DEFAULT_JWT_SECRET = "growdesk-development-jwt-secret-do-not-use-in-production-min-32-chars";

export interface AccessTokenPayload {
  readonly userId: string;
  readonly sessionId: string;
  readonly deviceLabel?: string;
}

export interface VerifiedTokenClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly jti: string;
  readonly deviceLabel?: string;
}

export interface VerifiedMcpTokenClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly jti: string;
  readonly scopes: ReadonlySet<string>;
  readonly babyId?: string;
  readonly clientId?: string;
}

export async function signAccessToken(
  payload: AccessTokenPayload,
  secret: string = DEFAULT_JWT_SECRET,
  expiresInSeconds = 600, // 10 minutes
): Promise<{ token: string; expiresIn: number }> {
  const secretKey = new TextEncoder().encode(secret);
  const now = Math.floor(Date.now() / 1000);
  const token = await new jose.SignJWT({
    sub: payload.userId,
    sid: payload.sessionId,
    deviceLabel: payload.deviceLabel ?? null,
    typ: "at+jwt",
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer("growdesk-api")
    .setAudience("baby-panel-api")
    .setIssuedAt(now)
    .setExpirationTime(now + expiresInSeconds)
    .setJti(crypto.randomUUID())
    .sign(secretKey);

  return { token, expiresIn: expiresInSeconds };
}

export async function verifyAccessToken(
  token: string,
  secret: string = DEFAULT_JWT_SECRET,
  expectedAudience = "baby-panel-api",
): Promise<VerifiedTokenClaims> {
  const secretKey = new TextEncoder().encode(secret);
  const { payload } = await jose.jwtVerify(token, secretKey, {
    issuer: "growdesk-api",
    audience: expectedAudience,
  });

  if (payload.typ !== "at+jwt" || typeof payload.sub !== "string" || typeof payload.sid !== "string") {
    throw new Error("INVALID_TOKEN_CLAIMS");
  }

  return {
    userId: payload.sub,
    sessionId: payload.sid,
    jti: typeof payload.jti === "string" ? payload.jti : crypto.randomUUID(),
    deviceLabel: typeof payload.deviceLabel === "string" ? payload.deviceLabel : undefined,
  };
}

/**
 * Verify the separate OAuth/MCP bearer audience. A regular app access token
 * has audience `baby-panel-api` and is deliberately rejected here. The MCP
 * grant is still tied to a live application session so principal resolution
 * can re-check current user, family and baby memberships on every request.
 */
export async function verifyMcpAccessToken(
  token: string,
  secret: string = DEFAULT_JWT_SECRET,
  expectedAudience: string,
  expectedIssuer?: string,
): Promise<VerifiedMcpTokenClaims> {
  if (!expectedAudience.trim()) throw new Error("MCP_RESOURCE_AUDIENCE_NOT_CONFIGURED");
  const secretKey = new TextEncoder().encode(secret);
  const { payload } = await jose.jwtVerify(token, secretKey, {
    ...(expectedIssuer ? { issuer: expectedIssuer } : {}),
    audience: expectedAudience,
  });

  // Legacy OAuth-issued MCP tokens had no typ claim; an app JWT explicitly
  // carries at+jwt and must not be accepted on this endpoint.
  if (payload.typ === "at+jwt" || typeof payload.sub !== "string" || typeof payload.sid !== "string") {
    throw new Error("INVALID_MCP_TOKEN_CLAIMS");
  }
  if (typeof payload.scope !== "string") throw new Error("MCP_SCOPE_MISSING");
  const scopes = new Set(payload.scope.split(/\s+/).map((scope) => scope.trim()).filter(Boolean));
  if (scopes.size === 0) throw new Error("MCP_SCOPE_MISSING");

  return {
    userId: payload.sub,
    sessionId: payload.sid,
    jti: typeof payload.jti === "string" ? payload.jti : crypto.randomUUID(),
    scopes,
    babyId: typeof payload.baby_id === "string" && payload.baby_id ? payload.baby_id : undefined,
    clientId: typeof payload.client_id === "string" && payload.client_id ? payload.client_id : undefined,
  };
}

export function generateRefreshToken(): { rawToken: string; tokenHash: string } {
  const rawSecret = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawSecret).digest("hex");
  return { rawToken: rawSecret, tokenHash };
}

export function hashRefreshToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}
