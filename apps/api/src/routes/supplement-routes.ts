import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import {
  ApiErrorEnvelopeSchema,
  BabyIdParamSchema,
  BabyAndIdParamSchema,
  PaginationQuerySchema,
  CreateSupplementRequestSchema,
  UpdateSupplementRequestSchema,
  SupplementRecordResponseSchema,
  SupplementListResponseSchema,
  DeleteRecordResponseSchema,
  type BabyIdParam,
  type BabyAndIdParam,
  type PaginationQuery,
  type CreateSupplementRequest,
  type UpdateSupplementRequest,
} from "@growdesk/contracts";
import { SupplementService } from "../services/supplement-service.js";

export interface SupplementRoutesOptions {
  readonly prisma: PrismaClient;
}

export const supplementRoutes: FastifyPluginAsync<SupplementRoutesOptions> = async (fastify, options) => {
  const service = new SupplementService(options.prisma);

  // 1. GET /api/v1/babies/:babyId/records/supplement
  fastify.get<{ Params: BabyIdParam; Querystring: PaginationQuery }>(
    "/api/v1/babies/:babyId/records/supplement",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        querystring: PaginationQuerySchema,
        response: {
          200: SupplementListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId } = request.params;
      const result = await service.listSupplementRecords(principal, babyId, request.query);
      reply.status(200).send(result);
    },
  );

  // 2. POST /api/v1/babies/:babyId/records/supplement
  fastify.post<{ Params: BabyIdParam; Body: CreateSupplementRequest }>(
    "/api/v1/babies/:babyId/records/supplement",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        body: CreateSupplementRequestSchema,
        response: {
          201: SupplementRecordResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId } = request.params;
      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const result = await service.createSupplementRecord(principal, babyId, request.body, idempotencyKey);
      reply.status(201).send({ data: result });
    },
  );

  // 3. GET /api/v1/babies/:babyId/records/supplement/:id
  fastify.get<{ Params: BabyAndIdParam }>(
    "/api/v1/babies/:babyId/records/supplement/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        response: {
          200: SupplementRecordResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId, id } = request.params;
      const result = await service.getSupplementRecord(principal, babyId, id);
      reply.status(200).send({ data: result });
    },
  );

  // 4. PATCH /api/v1/babies/:babyId/records/supplement/:id
  fastify.patch<{ Params: BabyAndIdParam; Body: UpdateSupplementRequest }>(
    "/api/v1/babies/:babyId/records/supplement/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        body: UpdateSupplementRequestSchema,
        response: {
          200: SupplementRecordResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId, id } = request.params;
      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const result = await service.updateSupplementRecord(principal, babyId, id, request.body, idempotencyKey);
      reply.status(200).send({ data: result });
    },
  );

  // 5. DELETE /api/v1/babies/:babyId/records/supplement/:id
  fastify.delete<{ Params: BabyAndIdParam; Querystring: { baseVersion?: string } }>(
    "/api/v1/babies/:babyId/records/supplement/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        response: {
          200: DeleteRecordResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId, id } = request.params;
      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const baseVersionStr = (request.query as { baseVersion?: string }).baseVersion;
      const baseVersion = baseVersionStr ? parseInt(baseVersionStr, 10) : 1;
      const result = await service.deleteSupplementRecord(principal, babyId, id, baseVersion, idempotencyKey);
      reply.status(200).send({
        data: {
          id: result.id,
          deleted: true,
        },
      });
    },
  );
};
