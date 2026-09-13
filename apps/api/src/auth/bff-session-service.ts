import type { PrismaClient } from "@growdesk/database";
import type pg from "pg";
import crypto from "node:crypto";
import { signAccessToken } from "./tokens.js";
import { createSession, revokeSession, rotateRefreshToken } from "./session-service.js";
import type { ReplayStore } from "./replay-store.js";
import type { UserProfile } from "@growdesk/contracts";

export interface CreateOrBindBffSessionParams {
  readonly prisma: PrismaClient;
  readonly sessionSecretHash: string;
  readonly userId: string;
  readonly deviceLabel?: string | null;
  readonly jwtSecret?: string;
}

export interface BffSessionResult {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly user: UserProfile;
}

export interface ExchangeBffSessionParams {
  readonly prisma: PrismaClient;
  readonly pool: pg.Pool;
  readonly replayStore: ReplayStore;
  readonly sessionSecretHash: string;
  readonly userId?: string;
  readonly jwtSecret?: string;
}

export interface BffExchangeSuccess {
  readonly success: true;
  readonly data: BffSessionResult;
}

export interface BffExchangeFailure {
  readonly success: false;
  readonly statusCode: 401 | 400;
  readonly code: string;
  readonly message: string;
}

export type BffExchangeResult = BffExchangeSuccess | BffExchangeFailure;

/**
 * Creates a new DeviceSession and binds it to a unique sessionSecretHash in bff_sessions.
 */
export async function createOrBindBffSession(
  params: CreateOrBindBffSessionParams,
): Promise<BffSessionResult> {
  const { prisma, sessionSecretHash, userId, deviceLabel, jwtSecret } = params;

  const user = await prisma.user.findUnique({
    where: { id: userId },
  });
  if (!user || user.deletedAt !== null) {
    throw new Error("User not found or deleted");
  }

  const sessionResult = await createSession(
    prisma,
    userId,
    deviceLabel || "Web Browser",
    "web",
  );

  const { token: accessToken, expiresIn } = await signAccessToken(
    {
      userId,
      sessionId: sessionResult.sessionId,
      deviceLabel: deviceLabel || "Web Browser",
    },
    jwtSecret,
  );

  const now = new Date();
  const accessTokenExpiresAt = new Date(now.getTime() + expiresIn * 1000);
  const idleExpiresAt = sessionResult.expiresAt;
  const absoluteExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  await prisma.bffSession.upsert({
    where: { sessionSecretHash },
    create: {
      id: crypto.randomUUID(),
      sessionSecretHash,
      userId,
      sessionId: sessionResult.sessionId,
      encryptedRefreshToken: sessionResult.rawRefreshToken,
      rotationId: sessionResult.rotationId,
      currentAccessToken: accessToken,
      accessTokenExpiresAt,
      idleExpiresAt,
      absoluteExpiresAt,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    update: {
      userId,
      sessionId: sessionResult.sessionId,
      encryptedRefreshToken: sessionResult.rawRefreshToken,
      rotationId: sessionResult.rotationId,
      currentAccessToken: accessToken,
      accessTokenExpiresAt,
      idleExpiresAt,
      absoluteExpiresAt,
      revokedAt: null,
      updatedAt: now,
    },
  });

  return {
    accessToken,
    expiresIn,
    user: {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    },
  };
}

/**
 * Exchanges a sessionSecretHash for an active accessToken.
 * Automatically performs atomic refresh with a row lock if the token is close to expiry.
 */
export async function exchangeBffSession(
  params: ExchangeBffSessionParams,
): Promise<BffExchangeResult> {
  const { prisma, pool, replayStore, sessionSecretHash, userId, jwtSecret } = params;

  const bffSession = await prisma.bffSession.findUnique({
    where: { sessionSecretHash },
    include: {
      session: true,
      user: true,
    },
  });

  if (!bffSession) {
    return {
      success: false,
      statusCode: 401,
      code: "BFF_SESSION_NOT_FOUND",
      message: "BFF session does not exist or has expired",
    };
  }

  const now = new Date();
  if (
    bffSession.revokedAt !== null ||
    bffSession.session.revokedAt !== null ||
    bffSession.absoluteExpiresAt <= now ||
    bffSession.idleExpiresAt <= now
  ) {
    return {
      success: false,
      statusCode: 401,
      code: "BFF_SESSION_EXPIRED",
      message: "BFF session has been revoked or expired",
    };
  }

  if (userId && bffSession.userId !== userId) {
    return {
      success: false,
      statusCode: 401,
      code: "BFF_SESSION_USER_MISMATCH",
      message: "BFF session user identity mismatch",
    };
  }

  const user = bffSession.user;
  if (!user || user.deletedAt !== null) {
    return {
      success: false,
      statusCode: 401,
      code: "USER_DELETED",
      message: "User account is no longer active",
    };
  }

  const userDto: UserProfile = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };

  // Check if current access token is still valid (at least 60s remaining)
  if (
    bffSession.currentAccessToken &&
    bffSession.accessTokenExpiresAt &&
    bffSession.accessTokenExpiresAt.getTime() - now.getTime() > 60_000
  ) {
    const remainingSeconds = Math.max(
      1,
      Math.floor((bffSession.accessTokenExpiresAt.getTime() - now.getTime()) / 1000),
    );
    return {
      success: true,
      data: {
        accessToken: bffSession.currentAccessToken,
        expiresIn: remainingSeconds,
        user: userDto,
      },
    };
  }

  // Token is expired or expiring within 60s: refresh inside row lock
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Row lock on bff_sessions to serialize concurrent refreshes
    const lockRes = await client.query<{
      id: string;
      session_id: string;
      encrypted_refresh_token: string;
      rotation_id: string;
      current_access_token: string | null;
      access_token_expires_at: Date | null;
    }>(
      `SELECT id, session_id, encrypted_refresh_token, rotation_id, current_access_token, access_token_expires_at
       FROM bff_sessions
       WHERE session_secret_hash = $1
       FOR UPDATE`,
      [sessionSecretHash],
    );

    const locked = lockRes.rows[0];
    if (!locked) {
      await client.query("ROLLBACK");
      return {
        success: false,
        statusCode: 401,
        code: "BFF_SESSION_NOT_FOUND",
        message: "BFF session not found during lock acquisition",
      };
    }

    // Double-check if another worker refreshed it while waiting for lock
    const currentLockTime = Date.now();
    if (
      locked.current_access_token &&
      locked.access_token_expires_at &&
      locked.access_token_expires_at.getTime() - currentLockTime > 60_000
    ) {
      await client.query("COMMIT");
      const remainingSeconds = Math.max(
        1,
        Math.floor((locked.access_token_expires_at.getTime() - currentLockTime) / 1000),
      );
      return {
        success: true,
        data: {
          accessToken: locked.current_access_token,
          expiresIn: remainingSeconds,
          user: userDto,
        },
      };
    }

    // Perform refresh token rotation
    const rotationResult = await rotateRefreshToken({
      pool,
      rawRefreshToken: locked.encrypted_refresh_token,
      rotationId: locked.rotation_id,
      replayStore,
      jwtSecret,
    });

    if (!rotationResult.success) {
      await client.query("ROLLBACK");
      return {
        success: false,
        statusCode: 401,
        code: rotationResult.code,
        message: rotationResult.message,
      };
    }

    const { accessToken: newAccessToken, refreshToken: newRefreshToken, expiresIn: newExpiresIn, rotationId: newRotationId } =
      rotationResult.data;
    const newExpiresAt = new Date(Date.now() + newExpiresIn * 1000);
    const newIdleExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await client.query(
      `UPDATE bff_sessions
       SET encrypted_refresh_token = $1,
           rotation_id = $2,
           current_access_token = $3,
           access_token_expires_at = $4,
           idle_expires_at = $5,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = $6`,
      [newRefreshToken, newRotationId, newAccessToken, newExpiresAt, newIdleExpiresAt, locked.id],
    );

    await client.query("COMMIT");

    return {
      success: true,
      data: {
        accessToken: newAccessToken,
        expiresIn: newExpiresIn,
        user: userDto,
      },
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Revoke a BFF session and its associated DeviceSession.
 */
export async function revokeBffSession(
  prisma: PrismaClient,
  sessionSecretHash: string,
): Promise<boolean> {
  const bffSession = await prisma.bffSession.findUnique({
    where: { sessionSecretHash },
  });

  if (!bffSession) {
    return false;
  }

  const now = new Date();
  await prisma.bffSession.update({
    where: { sessionSecretHash },
    data: { revokedAt: now },
  });

  await revokeSession(prisma, bffSession.userId, bffSession.sessionId);
  return true;
}
