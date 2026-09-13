import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import type pg from "pg";
import {
  ApiErrorEnvelopeSchema,
  RegisterRequestSchema,
  RegisterResponseSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  RefreshTokenRequestSchema,
  RefreshTokenResponseSchema,
  SessionListResponseSchema,
  RevokeSessionResponseSchema,
  SuccessStatusResponseSchema,
  CurrentUserResponseSchema,
  ChangePasswordRequestSchema,
  RegenerateRecoveryCodesRequestSchema,
  RegenerateRecoveryCodesResponseSchema,
  RecoverPasswordRequestSchema,
  BffSessionExchangeRequestSchema,
  BffSessionExchangeResponseSchema,
  BffSessionRevokeRequestSchema,
  type RegisterRequest,
  type LoginRequest,
  type RefreshTokenRequest,
  type ChangePasswordRequest,
  type RegenerateRecoveryCodesRequest,
  type RecoverPasswordRequest,
  type BffSessionExchangeRequest,
  type BffSessionRevokeRequest,
} from "@growdesk/contracts";
import crypto from "node:crypto";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { signAccessToken } from "../auth/tokens.js";
import { createSession, revokeSession, rotateRefreshToken } from "../auth/session-service.js";
import {
  createOrBindBffSession,
  exchangeBffSession,
  revokeBffSession,
} from "../auth/bff-session-service.js";
import {
  changePasswordTx,
  regenerateRecoveryCodesTx,
  recoverPasswordTx,
} from "../auth/recovery-service.js";
import { ReplayStore } from "../auth/replay-store.js";

export interface AuthRoutesOptions {
  readonly prisma: PrismaClient;
  readonly pool: pg.Pool;
  readonly replayStore?: ReplayStore;
  readonly jwtSecret?: string;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (fastify, options) => {
  const { prisma, pool, jwtSecret } = options;
  const replayStore = options.replayStore ?? new ReplayStore();

  // 1. POST /api/v1/auth/register
  fastify.post<{ Body: RegisterRequest }>(
    "/api/v1/auth/register",
    {
      schema: {
        body: RegisterRequestSchema,
        response: {
          201: RegisterResponseSchema,
          400: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const { username, password, displayName, deviceLabel } = request.body;
      const requestId = (request.id as string) || crypto.randomUUID();

      // Check username collision
      const existingUser = await prisma.user.findUnique({
        where: { username },
      });
      if (existingUser) {
        reply.status(409).send({
          error: {
            code: "USERNAME_EXISTS",
            message: `Username '${username}' is already taken`,
            requestId,
          },
        });
        return;
      }

      const userId = crypto.randomUUID();
      const familyId = crypto.randomUUID();
      const memberId = crypto.randomUUID();
      const passwordHash = await hashPassword(password);
      const now = new Date();

      // Atomic creation of user, default family, admin membership, and sync states
      const user = await prisma.$transaction(async (tx) => {
        const createdUser = await tx.user.create({
          data: {
            id: userId,
            username,
            passwordHash,
            displayName,
            createdAt: now,
            updatedAt: now,
            syncState: {
              create: {
                cursor: 0n,
                epoch: crypto.randomUUID(),
                createdAt: now,
                updatedAt: now,
              },
            },
          },
        });

        await tx.family.create({
          data: {
            id: familyId,
            name: `${displayName}的家庭`,
            timezone: "Asia/Shanghai",
            createdAt: now,
            updatedAt: now,
            syncState: {
              create: {
                cursor: 0n,
                epoch: crypto.randomUUID(),
                createdAt: now,
                updatedAt: now,
              },
            },
            members: {
              create: {
                id: memberId,
                userId,
                role: "admin",
                status: "active",
                createdAt: now,
                updatedAt: now,
              },
            },
          },
        });

        return createdUser;
      });

      const sessionResult = await createSession(prisma, userId, deviceLabel);
      const { token: accessToken, expiresIn } = await signAccessToken(
        {
          userId: user.id,
          sessionId: sessionResult.sessionId,
          deviceLabel: deviceLabel ?? undefined,
        },
        jwtSecret,
      );

      reply.status(201).send({
        data: {
          accessToken,
          refreshToken: sessionResult.rawRefreshToken,
          expiresIn,
          sessionId: sessionResult.sessionId,
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            createdAt: user.createdAt.toISOString(),
            updatedAt: user.updatedAt.toISOString(),
          },
        },
      });
    },
  );

  // 2. POST /api/v1/auth/login
  fastify.post<{ Body: LoginRequest }>(
    "/api/v1/auth/login",
    {
      schema: {
        body: LoginRequestSchema,
        response: {
          200: LoginResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const { username, password, deviceLabel } = request.body;
      const requestId = (request.id as string) || crypto.randomUUID();

      const user = await prisma.user.findUnique({
        where: { username },
      });

      if (!user || user.deletedAt !== null) {
        reply.status(401).send({
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid username or password",
            requestId,
          },
        });
        return;
      }

      const verification = await verifyPassword(password, user.passwordHash);
      if (!verification.valid) {
        reply.status(401).send({
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Invalid username or password",
            requestId,
          },
        });
        return;
      }

      // Transparent password upgrade if legacy bcrypt format
      if (verification.needsUpgrade) {
        const upgradedHash = await hashPassword(password, 12);
        await prisma.user.update({
          where: { id: user.id },
          data: {
            passwordHash: upgradedHash,
            passwordHashVersion: user.passwordHashVersion + 1,
            passwordHashNeedsRehash: false,
          },
        });
      }

      const sessionResult = await createSession(prisma, user.id, deviceLabel);
      const { token: accessToken, expiresIn } = await signAccessToken(
        {
          userId: user.id,
          sessionId: sessionResult.sessionId,
          deviceLabel: deviceLabel ?? undefined,
        },
        jwtSecret,
      );

      reply.status(200).send({
        data: {
          accessToken,
          refreshToken: sessionResult.rawRefreshToken,
          expiresIn,
          sessionId: sessionResult.sessionId,
          user: {
            id: user.id,
            username: user.username,
            displayName: user.displayName,
            createdAt: user.createdAt.toISOString(),
            updatedAt: user.updatedAt.toISOString(),
          },
        },
      });
    },
  );

  // 3. POST /api/v1/auth/refresh
  fastify.post<{ Body: RefreshTokenRequest }>(
    "/api/v1/auth/refresh",
    {
      schema: {
        body: RefreshTokenRequestSchema,
        response: {
          200: RefreshTokenResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const { refreshToken, rotationId } = request.body;
      const requestId = (request.id as string) || crypto.randomUUID();

      const result = await rotateRefreshToken({
        pool,
        rawRefreshToken: refreshToken,
        rotationId,
        replayStore,
        jwtSecret,
      });

      if (!result.success) {
        reply.status(result.statusCode).send({
          error: {
            code: result.code,
            message: result.message,
            requestId,
          },
        });
        return;
      }

      reply.status(200).send({
        data: result.data,
      });
    },
  );

  // 4. POST /api/v1/auth/logout
  fastify.post(
    "/api/v1/auth/logout",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: SuccessStatusResponseSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      await revokeSession(prisma, principal.userId, principal.sessionId);
      reply.status(200).send({
        data: {
          success: true,
        },
      });
    },
  );

  // 5. GET /api/v1/auth/sessions
  fastify.get(
    "/api/v1/auth/sessions",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: SessionListResponseSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const sessions = await prisma.deviceSession.findMany({
        where: {
          userId: principal.userId,
          revokedAt: null,
          absoluteExpiresAt: { gt: new Date() },
        },
        orderBy: { lastSeenAt: "desc" },
      });

      reply.status(200).send({
        data: sessions.map((s) => ({
          id: s.id,
          deviceLabel: s.deviceLabel,
          createdAt: s.createdAt.toISOString(),
          lastSeenAt: s.lastSeenAt.toISOString(),
          expiresAt: s.absoluteExpiresAt.toISOString(),
        })),
      });
    },
  );

  // 6. DELETE /api/v1/auth/sessions/:id
  fastify.delete<{ Params: { id: string } }>(
    "/api/v1/auth/sessions/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: RevokeSessionResponseSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const targetSessionId = request.params.id;
      const requestId = (request.id as string) || crypto.randomUUID();

      const revoked = await revokeSession(prisma, principal.userId, targetSessionId);
      if (!revoked) {
        reply.status(404).send({
          error: {
            code: "SESSION_NOT_FOUND",
            message: `Session '${targetSessionId}' was not found or belongs to another user`,
            requestId,
          },
        });
        return;
      }

      reply.status(200).send({
        data: {
          revoked: true,
        },
      });
    },
  );

  // 7. GET /api/v1/me
  fastify.get(
    "/api/v1/me",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: CurrentUserResponseSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const requestId = (request.id as string) || crypto.randomUUID();

      const user = await prisma.user.findUnique({
        where: { id: principal.userId },
      });

      if (!user || user.deletedAt !== null) {
        reply.status(404).send({
          error: {
            code: "USER_NOT_FOUND",
            message: "User account not found",
            requestId,
          },
        });
        return;
      }

      reply.status(200).send({
        data: {
          id: user.id,
          username: user.username,
          displayName: user.displayName,
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
        },
      });
    },
  );

  // 8. POST /api/v1/auth/password/change
  fastify.post<{ Body: ChangePasswordRequest }>(
    "/api/v1/auth/password/change",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: ChangePasswordRequestSchema,
        response: {
          200: SuccessStatusResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { oldPassword, newPassword } = request.body;
      const requestId = (request.id as string) || crypto.randomUUID();

      const result = await changePasswordTx({
        pool,
        userId: principal.userId,
        sessionId: principal.sessionId,
        oldPassword,
        newPassword,
      });

      if (!result.success) {
        reply.status(result.statusCode).send({
          error: {
            code: result.code ?? "UNAUTHORIZED",
            message: result.message ?? "Password change failed",
            requestId,
          },
        });
        return;
      }

      reply.status(200).send({
        data: {
          success: true,
        },
      });
    },
  );

  // 9. POST /api/v1/auth/recovery-codes/regenerate
  fastify.post<{ Body: RegenerateRecoveryCodesRequest }>(
    "/api/v1/auth/recovery-codes/regenerate",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: RegenerateRecoveryCodesRequestSchema,
        response: {
          200: RegenerateRecoveryCodesResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { password } = request.body;
      const requestId = (request.id as string) || crypto.randomUUID();

      const user = await prisma.user.findUnique({
        where: { id: principal.userId },
      });

      if (!user || user.deletedAt !== null) {
        reply.status(401).send({
          error: {
            code: "UNAUTHORIZED",
            message: "User account not found",
            requestId,
          },
        });
        return;
      }

      const verification = await verifyPassword(password, user.passwordHash);
      if (!verification.valid) {
        reply.status(401).send({
          error: {
            code: "INVALID_CREDENTIALS",
            message: "Current password does not match",
            requestId,
          },
        });
        return;
      }

      const result = await regenerateRecoveryCodesTx(pool, principal.userId);
      reply.status(200).send({
        data: {
          codes: result.codes,
          batchId: result.batchId,
        },
      });
    },
  );

  // 10. POST /api/v1/auth/password/recover
  fastify.post<{ Body: RecoverPasswordRequest }>(
    "/api/v1/auth/password/recover",
    {
      schema: {
        body: RecoverPasswordRequestSchema,
        response: {
          200: SuccessStatusResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const { username, recoveryCode, newPassword } = request.body;
      const requestId = (request.id as string) || crypto.randomUUID();

      const result = await recoverPasswordTx({
        pool,
        username,
        recoveryCode,
        newPassword,
      });

      if (!result.success) {
        reply.status(result.statusCode).send({
          error: {
            code: result.code ?? "INVALID_RECOVERY_CODE",
            message: result.message ?? "Invalid username or recovery code",
            requestId,
          },
        });
        return;
      }

      reply.status(200).send({
        data: {
          success: true,
        },
      });
    },
  );

  // 10. POST /api/v1/auth/bff/session
  fastify.post<{ Body: BffSessionExchangeRequest }>(
    "/api/v1/auth/bff/session",
    {
      schema: {
        body: BffSessionExchangeRequestSchema,
        response: {
          200: BffSessionExchangeResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const { sessionSecretHash, userId, username, password, deviceLabel } = request.body;
      const requestId = (request.id as string) || crypto.randomUUID();

      // Case 1: If username and password are provided, perform initial login & bind
      if (username && password) {
        const cleanUsername = username.trim().toLowerCase();
        const user = await prisma.user.findUnique({
          where: { username: cleanUsername },
        });

        const DUMMY_HASH = "$2a$12$e8qW7M11jAeVyXz0KkL7mOSX92/wP538fCg/yK04V5gGkLd/d091W";
        const isValid = user
          ? (await verifyPassword(password, user.passwordHash)).valid
          : (await verifyPassword(password, DUMMY_HASH)).valid;

        if (!user || !isValid || user.deletedAt !== null) {
          reply.status(401).send({
            error: {
              code: "INVALID_CREDENTIALS",
              message: "Invalid username or password",
              requestId,
            },
          });
          return;
        }

        const result = await createOrBindBffSession({
          prisma,
          sessionSecretHash,
          userId: user.id,
          deviceLabel: deviceLabel || "Web Browser",
          jwtSecret,
        });

        reply.status(200).send({
          data: result,
        });
        return;
      }

      // Case 2: Exchange / refresh token using sessionSecretHash
      const exchangeResult = await exchangeBffSession({
        prisma,
        pool,
        replayStore,
        sessionSecretHash,
        userId: userId ?? undefined,
        jwtSecret,
      });

      if (!exchangeResult.success) {
        reply.status(exchangeResult.statusCode).send({
          error: {
            code: exchangeResult.code,
            message: exchangeResult.message,
            requestId,
          },
        });
        return;
      }

      reply.status(200).send({
        data: exchangeResult.data,
      });
    },
  );

  // 11. DELETE /api/v1/auth/bff/session
  fastify.delete<{ Body: BffSessionRevokeRequest }>(
    "/api/v1/auth/bff/session",
    {
      schema: {
        body: BffSessionRevokeRequestSchema,
        response: {
          200: SuccessStatusResponseSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const { sessionSecretHash } = request.body;
      await revokeBffSession(prisma, sessionSecretHash);
      reply.status(200).send({
        data: {
          success: true,
        },
      });
    },
  );
};
