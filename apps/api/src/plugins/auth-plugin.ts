import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import type { PrismaClient } from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import crypto from "node:crypto";
import { verifyAccessToken } from "../auth/tokens.js";
import { resolvePrincipalFromSession } from "../auth/session-service.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: UserPrincipal | null;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface AuthPluginOptions {
  readonly prisma: PrismaClient;
  readonly jwtSecret?: string;
}

const authPluginCallback: FastifyPluginAsync<AuthPluginOptions> = async (fastify, options) => {
  fastify.decorateRequest("principal", null);

  fastify.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const authHeader = request.headers.authorization;
    const requestId = (request.id as string) || crypto.randomUUID();

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      reply.status(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "Missing or malformed Authorization header",
          requestId,
        },
      });
      return;
    }

    const token = authHeader.slice(7).trim();
    let claims;
    try {
      claims = await verifyAccessToken(token, options.jwtSecret);
    } catch {
      reply.status(401).send({
        error: {
          code: "UNAUTHORIZED",
          message: "Invalid or expired access token",
          requestId,
        },
      });
      return;
    }

    const principal = await resolvePrincipalFromSession(
      options.prisma,
      claims.userId,
      claims.sessionId,
    );

    if (!principal) {
      reply.status(401).send({
        error: {
          code: "SESSION_REVOKED",
          message: "Session has expired or was revoked",
          requestId,
        },
      });
      return;
    }

    request.principal = principal;
  });
};

export const authPlugin = fp(authPluginCallback, {
  name: "auth-plugin",
  fastify: "5.x",
});
