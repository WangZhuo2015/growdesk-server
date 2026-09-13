import type { PrismaClient } from "@growdesk/database";
import type {
  UserPrincipal,
  FamilyMembership,
  BabyMember,
  FamilyRole,
  BabyRole,
  MembershipStatus,
} from "@growdesk/domain";
import type pg from "pg";
import crypto from "node:crypto";
import { generateRefreshToken, hashRefreshToken, signAccessToken } from "./tokens.js";
import type { ReplayStore } from "./replay-store.js";

export interface CreateSessionResult {
  readonly sessionId: string;
  readonly rawRefreshToken: string;
  readonly tokenHash: string;
  readonly rotationId: string;
  readonly expiresAt: Date;
}

export type DevicePlatform = "ios" | "web" | "macos" | "android" | "unknown";

export function inferPlatform(deviceLabel?: string | null): DevicePlatform {
  if (!deviceLabel) return "unknown";
  const label = deviceLabel.toLowerCase();
  if (label.includes("ios") || label.includes("iphone") || label.includes("ipad")) return "ios";
  if (label.includes("web") || label.includes("chrome") || label.includes("safari") || label.includes("firefox")) return "web";
  if (label.includes("mac")) return "macos";
  if (label.includes("android")) return "android";
  return "unknown";
}

/**
 * Create a new DeviceSession and initial RefreshCredential in PostgreSQL 18.
 */
export async function createSession(
  prisma: PrismaClient,
  userId: string,
  deviceLabel?: string | null,
  platformOverride?: DevicePlatform,
): Promise<CreateSessionResult> {
  const sessionId = crypto.randomUUID();
  const rotationId = crypto.randomUUID();
  const now = new Date();
  const absoluteExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days
  const refreshExpiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days idle
  const platform = platformOverride || inferPlatform(deviceLabel);

  const { rawToken, tokenHash } = generateRefreshToken();

  await prisma.deviceSession.create({
    data: {
      id: sessionId,
      userId,
      deviceLabel: deviceLabel || "Web/Default",
      platform,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt,
      refreshCredentials: {
        create: {
          tokenHash,
          userId,
          rotationId,
          createdAt: now,
          expiresAt: refreshExpiresAt,
        },
      },
    },
  });

  return {
    sessionId,
    rawRefreshToken: rawToken,
    tokenHash,
    rotationId,
    expiresAt: refreshExpiresAt,
  };
}

/**
 * Resolve active UserPrincipal from a validated session.
 * Re-reads User, DeviceSession, FamilyMembers, and BabyMembers from the database.
 */
export async function resolvePrincipalFromSession(
  prisma: PrismaClient,
  userId: string,
  sessionId: string,
): Promise<UserPrincipal | null> {
  const now = new Date();

  const session = await prisma.deviceSession.findUnique({
    where: { id: sessionId },
    include: {
      user: {
        include: {
          familyMemberships: true,
          babyMemberships: true,
        },
      },
    },
  });

  if (!session || session.userId !== userId || session.revokedAt !== null || session.absoluteExpiresAt <= now) {
    return null;
  }

  const user = session.user;
  if (!user || user.deletedAt !== null) {
    return null;
  }

  const familyMemberships: FamilyMembership[] = user.familyMemberships
    .filter((fm) => fm.status === "active" && fm.deletedAt === null)
    .map((fm) => ({
      familyId: fm.familyId,
      role: fm.role as FamilyRole,
      status: fm.status as MembershipStatus,
    }));

  const babyMemberships: BabyMember[] = user.babyMemberships
    .filter((bm) => bm.status === "active" && bm.deletedAt === null)
    .map((bm) => ({
      userId: bm.userId,
      babyId: bm.babyId,
      familyId: bm.familyId,
      role: bm.role as BabyRole,
      status: bm.status as MembershipStatus,
    }));

  return {
    userId: user.id,
    username: user.username,
    sessionId: session.id,
    deviceLabel: session.deviceLabel,
    familyMemberships,
    babyMemberships,
  };
}

/**
 * Revoke a specific session for a user.
 */
export async function revokeSession(
  prisma: PrismaClient,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const session = await prisma.deviceSession.findUnique({
    where: { id: sessionId },
  });

  if (!session || session.userId !== userId) {
    return false;
  }

  const now = new Date();
  await prisma.$transaction([
    prisma.deviceSession.update({
      where: { id: sessionId },
      data: { revokedAt: now },
    }),
    prisma.refreshCredential.updateMany({
      where: { sessionId, revokedAt: null },
      data: { revokedAt: now },
    }),
  ]);

  return true;
}

export interface RotateRefreshTokenParams {
  readonly pool: pg.Pool;
  readonly rawRefreshToken: string;
  readonly rotationId: string;
  readonly replayStore: ReplayStore;
  readonly jwtSecret?: string;
}

export interface RotateRefreshTokenSuccess {
  readonly success: true;
  readonly data: {
    readonly accessToken: string;
    readonly refreshToken: string;
    readonly expiresIn: number;
    readonly rotationId: string;
  };
}

export interface RotateRefreshTokenFailure {
  readonly success: false;
  readonly statusCode: 401 | 409;
  readonly code: string;
  readonly message: string;
}

export type RotateRefreshTokenResult = RotateRefreshTokenSuccess | RotateRefreshTokenFailure;

/**
 * Atomic Refresh Token Rotation adhering to 02_BACKEND_CONTRACTS.md Section 3.2.
 * Enforces strict lock hierarchy: UserSyncState -> DeviceSession -> RefreshCredential.
 * Detects reuse and executes cascade session revocation on replay attack.
 */
export async function rotateRefreshToken(params: RotateRefreshTokenParams): Promise<RotateRefreshTokenResult> {
  const { pool, rawRefreshToken, rotationId, replayStore, jwtSecret } = params;
  const tokenHash = hashRefreshToken(rawRefreshToken);

  // Pre-lookup outside transaction to locate userId and check initial state
  const preLookup = await pool.query(
    `SELECT token_hash, session_id, user_id, parent_id, rotation_id, created_at, expires_at, used_at, revoked_at, replaced_by_id
     FROM refresh_credentials WHERE token_hash = $1`,
    [tokenHash],
  );

  if (preLookup.rows.length === 0) {
    return {
      success: false,
      statusCode: 401,
      code: "INVALID_REFRESH_TOKEN",
      message: "Refresh token is invalid or does not exist",
    };
  }

  const existingCred = preLookup.rows[0];

  // Case A: Token was already used
  if (existingCred.used_at !== null) {
    const usedAtMs = new Date(existingCred.used_at).getTime();
    const isSameRotation = existingCred.rotation_id === rotationId;
    const isWithinWindow = Date.now() - usedAtMs <= 60_000;

    if (isSameRotation && isWithinWindow) {
      // Replay of same rotationId within 60s (lost response recovery)
      const cached = await replayStore.getReplay(`replay:refresh:${tokenHash}:${rotationId}`);
      if (cached) {
        return { success: true, data: cached };
      }
      return {
        success: false,
        statusCode: 401,
        code: "REPLAY_EXPIRED",
        message: "Replay window has expired; please authenticate again",
      };
    }

    // Reuse detected (different rotationId or outside 60s window) -> Revoke entire session tree
    const revokeClient = await pool.connect();
    try {
      await revokeClient.query("BEGIN");
      await revokeClient.query(
        "SELECT cursor FROM user_sync_states WHERE user_id = $1 FOR UPDATE",
        [existingCred.user_id],
      );
      await revokeClient.query(
        "UPDATE device_sessions SET revoked_at = NOW() WHERE id = $1",
        [existingCred.session_id],
      );
      await revokeClient.query(
        "UPDATE refresh_credentials SET revoked_at = NOW() WHERE session_id = $1",
        [existingCred.session_id],
      );
      await revokeClient.query("COMMIT");
    } catch {
      await revokeClient.query("ROLLBACK");
    } finally {
      revokeClient.release();
    }

    return {
      success: false,
      statusCode: 409,
      code: "REFRESH_REUSE_DETECTED",
      message: "Refresh token reuse detected; device session has been revoked",
    };
  }

  if (existingCred.revoked_at !== null) {
    return {
      success: false,
      statusCode: 401,
      code: "REFRESH_TOKEN_REVOKED",
      message: "Refresh token has been revoked",
    };
  }

  if (new Date(existingCred.expires_at) <= new Date()) {
    return {
      success: false,
      statusCode: 401,
      code: "REFRESH_TOKEN_EXPIRED",
      message: "Refresh token has expired",
    };
  }

  // Case B: Token has not been used yet -> Rotate atomically under strict global lock hierarchy
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1. Lock UserSyncState (Global Lock Ordering Rule #1)
    const userSyncRes = await client.query(
      "SELECT cursor FROM user_sync_states WHERE user_id = $1 FOR UPDATE",
      [existingCred.user_id],
    );
    if (userSyncRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        success: false,
        statusCode: 401,
        code: "USER_NOT_FOUND",
        message: "User account not found",
      };
    }

    // 2. Lock DeviceSession (Global Lock Ordering Rule #2)
    const sessionRes = await client.query(
      "SELECT id, revoked_at, absolute_expires_at, device_label, platform FROM device_sessions WHERE id = $1 FOR UPDATE",
      [existingCred.session_id],
    );
    if (sessionRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return {
        success: false,
        statusCode: 401,
        code: "SESSION_NOT_FOUND",
        message: "Session not found",
      };
    }
    const session = sessionRes.rows[0];
    if (session.revoked_at !== null || new Date(session.absolute_expires_at) <= new Date()) {
      await client.query("ROLLBACK");
      return {
        success: false,
        statusCode: 401,
        code: "SESSION_REVOKED",
        message: "Session has expired or was revoked",
      };
    }

    // 3. Lock RefreshCredential (Global Lock Ordering Rule #3)
    const credRes = await client.query(
      "SELECT token_hash, used_at, revoked_at, expires_at, rotation_id FROM refresh_credentials WHERE token_hash = $1 FOR UPDATE",
      [tokenHash],
    );
    const lockedCred = credRes.rows[0];
    if (!lockedCred || lockedCred.revoked_at !== null) {
      await client.query("ROLLBACK");
      return {
        success: false,
        statusCode: 401,
        code: "REFRESH_TOKEN_REVOKED",
        message: "Refresh token was revoked",
      };
    }

    if (lockedCred.used_at !== null) {
      // Race condition occurred while acquiring locks
      if (lockedCred.rotation_id === rotationId) {
        await client.query("ROLLBACK");
        const cached = await replayStore.getReplay(`replay:refresh:${tokenHash}:${rotationId}`);
        if (cached) return { success: true, data: cached };
        return {
          success: false,
          statusCode: 401,
          code: "REPLAY_EXPIRED",
          message: "Replay window expired",
        };
      }

      // Different rotationId in race -> Revoke session and abort with 409
      await client.query("UPDATE device_sessions SET revoked_at = NOW() WHERE id = $1", [session.id]);
      await client.query("UPDATE refresh_credentials SET revoked_at = NOW() WHERE session_id = $1", [session.id]);
      await client.query("COMMIT");
      return {
        success: false,
        statusCode: 409,
        code: "REFRESH_REUSE_DETECTED",
        message: "Concurrent refresh reuse detected; session revoked",
      };
    }

    // 4. Generate successor credential
    const { rawToken: newRawToken, tokenHash: newHash } = generateRefreshToken();
    const now = new Date();
    const candidateExpiry = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days idle
    const sessionExpiry = new Date(session.absolute_expires_at);
    const newExpiresAt = candidateExpiry < sessionExpiry ? candidateExpiry : sessionExpiry;

    // 5. Mark old credential used
    await client.query(
      "UPDATE refresh_credentials SET used_at = NOW(), rotation_id = $2, replaced_by_id = $3 WHERE token_hash = $1",
      [tokenHash, rotationId, newHash],
    );

    // 6. Insert successor credential
    await client.query(
      `INSERT INTO refresh_credentials (token_hash, session_id, user_id, parent_id, rotation_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6)`,
      [newHash, session.id, existingCred.user_id, tokenHash, rotationId, newExpiresAt],
    );

    // 7. Touch session lastSeenAt
    await client.query(
      "UPDATE device_sessions SET last_seen_at = NOW() WHERE id = $1",
      [session.id],
    );

    await client.query("COMMIT");

    // 8. Sign new access token
    const { token: newAccessToken, expiresIn } = await signAccessToken(
      {
        userId: existingCred.user_id,
        sessionId: session.id,
        deviceLabel: session.device_label,
      },
      jwtSecret,
    );

    const responsePayload = {
      accessToken: newAccessToken,
      refreshToken: newRawToken,
      expiresIn,
      rotationId,
    };

    // 9. Cache for 60s lost response replay window
    await replayStore.saveReplay(`replay:refresh:${tokenHash}:${rotationId}`, responsePayload, 60);

    return {
      success: true,
      data: responsePayload,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
