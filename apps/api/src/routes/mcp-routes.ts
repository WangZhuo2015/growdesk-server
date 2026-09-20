import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import { BabyAccessDeniedError, BadRequestError, FamilyAccessDeniedError } from "@growdesk/database";
import {
  ApiErrorEnvelopeSchema,
  McpRpcRequestSchema,
  McpRpcResponseSchema,
  type McpRpcRequest,
} from "@growdesk/contracts";
import type { UserPrincipal } from "@growdesk/domain";
import { resolvePrincipalFromSession } from "../auth/session-service.js";
import { verifyMcpAccessToken, type VerifiedMcpTokenClaims } from "../auth/tokens.js";
import { SupplementCatalogService, type McpSupplementProductInput } from "../services/supplement-catalog-service.js";

export interface McpRoutesOptions {
  readonly prisma: PrismaClient;
  readonly jwtSecret?: string;
  /** Exact `aud` value accepted for MCP tokens, normally `<publicBaseUrl>/mcp`. */
  readonly resourceAudience: string;
  readonly issuer?: string;
}

interface McpAuthContext {
  readonly principal: UserPrincipal;
  readonly claims: VerifiedMcpTokenClaims;
}

const CREATE_SUPPLEMENT_TOOL = {
  name: "create_supplement_product",
  description: "在家庭档案库中建档或更新营养补充剂产品，无需打卡即可录入营养成分。",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["name"],
    properties: {
      name: { type: "string", minLength: 1, maxLength: 200, description: "补剂全称" },
      brand: { type: "string", maxLength: 100, description: "品牌名称，默认使用补剂名称" },
      dosageForm: { type: "string", maxLength: 50, description: "剂型，如 drops、capsule、liquid_ml、sachet、tablet" },
      unitName: { type: "string", maxLength: 50, description: "单次计量单位，如 滴、粒、ml、袋、片" },
      defaultDose: { type: "number", exclusiveMinimum: 0, description: "单次推荐用量，默认 1" },
      nutrients: { type: "object", description: "营养成分表，支持数字或 {amount, unit}" },
      notes: { type: "string", description: "补充说明或医嘱注意事项" },
      familyId: { type: "string", description: "可选目标家庭；服务端会与宝宝归属核对" },
      babyId: { type: "string", description: "可选授权锚点；无 grant baby_id 时必填" },
      idempotencyKey: { type: "string", maxLength: 128, description: "可选重试键；缺省使用 JSON-RPC id" },
    },
  },
} as const;

function requestId(request: FastifyRequest): string {
  return (request.id as string) || "mcp-request";
}

function rpcError(id: McpRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

function hasScope(scopes: ReadonlySet<string>, ...required: string[]): boolean {
  return required.some((scope) => scopes.has(scope));
}

async function authenticateMcp(
  request: FastifyRequest,
  options: McpRoutesOptions,
): Promise<McpAuthContext | null> {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7).trim();
  if (!token) return null;
  try {
    const claims = await verifyMcpAccessToken(token, options.jwtSecret, options.resourceAudience, options.issuer);
    const principal = await resolvePrincipalFromSession(options.prisma, claims.userId, claims.sessionId);
    if (!principal) return null;
    return { principal, claims };
  } catch {
    return null;
  }
}

async function resolveMcpBaby(
  prisma: PrismaClient,
  principal: UserPrincipal,
  claims: VerifiedMcpTokenClaims,
  requestedBabyId: unknown,
  requestedFamilyId: unknown,
): Promise<{ familyId: string; babyId: string }> {
  const requested = typeof requestedBabyId === "string" && requestedBabyId.trim() ? requestedBabyId.trim() : undefined;
  if (claims.babyId && requested && claims.babyId !== requested) {
    throw new BabyAccessDeniedError(requested, "BABY_SCOPE_MISMATCH");
  }
  const babyId = claims.babyId ?? requested;
  if (!babyId) throw new BadRequestError("MCP call requires a baby-scoped grant", "BABY_SCOPE_REQUIRED");

  const baby = await prisma.baby.findUnique({ where: { id: babyId }, select: { familyId: true, deletedAt: true } });
  if (!baby || baby.deletedAt !== null) throw new BabyAccessDeniedError(babyId, "BABY_ACCESS_DENIED");
  const member = principal.babyMemberships?.find(
    (item) => item.userId === principal.userId && item.babyId === babyId && item.familyId === baby.familyId && item.status === "active",
  );
  if (!member || member.role === "viewer") throw new BabyAccessDeniedError(babyId, "BABY_WRITE_DENIED");
  if (typeof requestedFamilyId === "string" && requestedFamilyId.trim() && requestedFamilyId.trim() !== baby.familyId) {
    throw new FamilyAccessDeniedError(requestedFamilyId.trim());
  }
  return { familyId: baby.familyId, babyId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const mcpRoutes: FastifyPluginAsync<McpRoutesOptions> = async (fastify, options) => {
  const catalog = new SupplementCatalogService(options.prisma);

  fastify.post<{ Body: McpRpcRequest }>(
    "/mcp",
    {
      schema: {
        body: McpRpcRequestSchema,
        response: {
          200: McpRpcResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const auth = await authenticateMcp(request, options);
      if (!auth) {
        reply.status(401).send({
          error: {
            code: "UNAUTHORIZED",
            message: "Invalid or expired MCP bearer token",
            requestId: requestId(request),
          },
        });
        return;
      }

      const rpc = request.body;
      const params = rpc.params ?? {};
      if (rpc.method === "initialize") {
        return reply.send({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "growdesk", version: "0.1.0" },
          },
        });
      }
      if (rpc.method === "notifications/initialized" || rpc.method === "ping") {
        return reply.send({ jsonrpc: "2.0", id: rpc.id, result: {} });
      }
      if (rpc.method === "tools/list") {
        if (!hasScope(auth.claims.scopes, "baby:read", "baby:write", "app:read", "app:write")) {
          return reply.send(rpcError(rpc.id, -32003, "Forbidden: missing MCP read scope"));
        }
        return reply.send({ jsonrpc: "2.0", id: rpc.id, result: { tools: [CREATE_SUPPLEMENT_TOOL] } });
      }
      if (rpc.method !== "tools/call") return reply.send(rpcError(rpc.id, -32601, "Method not found"));

      const toolName = params.name;
      if (toolName !== "create_supplement_product") return reply.send(rpcError(rpc.id, -32601, "Unknown MCP tool"));
      if (!hasScope(auth.claims.scopes, "baby:write", "app:write")) {
        return reply.send(rpcError(rpc.id, -32003, "Forbidden: missing baby:write scope"));
      }
      if (!isRecord(params.arguments)) return reply.send(rpcError(rpc.id, -32602, "Tool arguments must be an object"));

      try {
        const args = params.arguments;
        const target = await resolveMcpBaby(options.prisma, auth.principal, auth.claims, args.babyId, args.familyId);
        const input: McpSupplementProductInput = {
          name: typeof args.name === "string" ? args.name : "",
          brand: typeof args.brand === "string" ? args.brand : undefined,
          dosageForm: typeof args.dosageForm === "string" ? args.dosageForm : undefined,
          unitName: typeof args.unitName === "string" ? args.unitName : undefined,
          defaultDose: typeof args.defaultDose === "number" || typeof args.defaultDose === "string" ? args.defaultDose : undefined,
          nutrients: args.nutrients,
          notes: typeof args.notes === "string" ? args.notes : undefined,
        };
        const rawKey = typeof args.idempotencyKey === "string" && args.idempotencyKey.trim()
          ? args.idempotencyKey.trim()
          : String(rpc.id);
        const result = await catalog.createOrUpdateProductFromMcp(
          auth.principal,
          target.familyId,
          target.babyId,
          input,
          `mcp:create_supplement_product:${rawKey}`,
        );
        const product = { ...result.product, nutrients: result.product.nutrientsJson };
        return reply.send({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            content: [{
              type: "text",
              text: JSON.stringify({ success: true, action: "create_supplement_product", replayed: result.replayed, product }, null, 2),
            }],
          },
        });
      } catch (error) {
        const status = typeof error === "object" && error !== null && "statusCode" in error
          ? Number((error as { statusCode?: unknown }).statusCode)
          : 0;
        const message = status >= 400 && status < 500 && error instanceof Error
          ? error.message
          : "MCP supplement product write failed";
        return reply.send(rpcError(rpc.id, status === 403 ? -32003 : -32602, message));
      }
    },
  );
};
