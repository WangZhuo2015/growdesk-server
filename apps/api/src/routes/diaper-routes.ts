import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import {
  ApiErrorEnvelopeSchema,
  BabyIdParamSchema,
  BabyAndIdParamSchema,
  PaginationQuerySchema,
  CreateDiaperRequestSchema,
  UpdateDiaperRequestSchema,
  DiaperRecordResponseSchema,
  DiaperListResponseSchema,
  DeleteRecordResponseSchema,
  type BabyIdParam,
  type BabyAndIdParam,
  type PaginationQuery,
  type CreateDiaperRequest,
  type UpdateDiaperRequest,
} from "@growdesk/contracts";
import { DiaperService } from "../services/diaper-service.js";

export interface DiaperRoutesOptions {
  readonly prisma: PrismaClient;
}

export const diaperRoutes: FastifyPluginAsync<DiaperRoutesOptions> = async (fastify, options) => {
  const service = new DiaperService(options.prisma);

  // 1. GET /api/v1/babies/:babyId/records/diaper
  fastify.get<{ Params: BabyIdParam; Querystring: PaginationQuery }>(
    "/api/v1/babies/:babyId/records/diaper",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        querystring: PaginationQuerySchema,
        response: {
          200: DiaperListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId } = request.params;
      const result = await service.listDiaperRecords(principal, babyId, request.query);
      reply.status(200).send(result);
    },
  );

  // 2. POST /api/v1/babies/:babyId/records/diaper
  fastify.post<{ Params: BabyIdParam; Body: CreateDiaperRequest }>(
    "/api/v1/babies/:babyId/records/diaper",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        body: CreateDiaperRequestSchema,
        response: {
          201: DiaperRecordResponseSchema,
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
      const result = await service.createDiaperRecord(principal, babyId, request.body, idempotencyKey);
      reply.status(201).send({ data: result });
    },
  );

  // 3. GET /api/v1/babies/:babyId/records/diaper/:id
  fastify.get<{ Params: BabyAndIdParam }>(
    "/api/v1/babies/:babyId/records/diaper/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        response: {
          200: DiaperRecordResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId, id } = request.params;
      const result = await service.getDiaperRecord(principal, babyId, id);
      reply.status(200).send({ data: result });
    },
  );

  // 4. PATCH /api/v1/babies/:babyId/records/diaper/:id
  fastify.patch<{ Params: BabyAndIdParam; Body: UpdateDiaperRequest }>(
    "/api/v1/babies/:babyId/records/diaper/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        body: UpdateDiaperRequestSchema,
        response: {
          200: DiaperRecordResponseSchema,
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
      const result = await service.updateDiaperRecord(principal, babyId, id, request.body, idempotencyKey);
      reply.status(200).send({ data: result });
    },
  );

  // 5. DELETE /api/v1/babies/:babyId/records/diaper/:id
  fastify.delete<{ Params: BabyAndIdParam; Querystring: { baseVersion?: string } }>(
    "/api/v1/babies/:babyId/records/diaper/:id",
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
      const result = await service.deleteDiaperRecord(principal, babyId, id, baseVersion, idempotencyKey);
      reply.status(200).send({
        data: {
          id: result.id,
          deleted: true,
        },
      });
    },
  );
};
