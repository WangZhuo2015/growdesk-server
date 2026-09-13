import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import {
  ApiErrorEnvelopeSchema,
  BabyIdParamSchema,
  BabyAndIdParamSchema,
  PaginationQuerySchema,
  CreateSleepRequestSchema,
  UpdateSleepRequestSchema,
  SleepRecordResponseSchema,
  SleepListResponseSchema,
  DeleteRecordResponseSchema,
  type BabyIdParam,
  type BabyAndIdParam,
  type PaginationQuery,
  type CreateSleepRequest,
  type UpdateSleepRequest,
} from "@growdesk/contracts";
import { SleepService } from "../services/sleep-service.js";

export interface SleepRoutesOptions {
  readonly prisma: PrismaClient;
}

export const sleepRoutes: FastifyPluginAsync<SleepRoutesOptions> = async (fastify, options) => {
  const service = new SleepService(options.prisma);

  // 1. GET /api/v1/babies/:babyId/records/sleep
  fastify.get<{ Params: BabyIdParam; Querystring: PaginationQuery }>(
    "/api/v1/babies/:babyId/records/sleep",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        querystring: PaginationQuerySchema,
        response: {
          200: SleepListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId } = request.params;
      const result = await service.listSleepRecords(principal, babyId, request.query);
      reply.status(200).send(result);
    },
  );

  // 2. POST /api/v1/babies/:babyId/records/sleep
  fastify.post<{ Params: BabyIdParam; Body: CreateSleepRequest }>(
    "/api/v1/babies/:babyId/records/sleep",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        body: CreateSleepRequestSchema,
        response: {
          201: SleepRecordResponseSchema,
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
      const result = await service.createSleepRecord(principal, babyId, request.body, idempotencyKey);
      reply.status(201).send({ data: result });
    },
  );

  // 3. GET /api/v1/babies/:babyId/records/sleep/:id
  fastify.get<{ Params: BabyAndIdParam }>(
    "/api/v1/babies/:babyId/records/sleep/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        response: {
          200: SleepRecordResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId, id } = request.params;
      const result = await service.getSleepRecord(principal, babyId, id);
      reply.status(200).send({ data: result });
    },
  );

  // 4. PATCH /api/v1/babies/:babyId/records/sleep/:id
  fastify.patch<{ Params: BabyAndIdParam; Body: UpdateSleepRequest }>(
    "/api/v1/babies/:babyId/records/sleep/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        body: UpdateSleepRequestSchema,
        response: {
          200: SleepRecordResponseSchema,
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
      const result = await service.updateSleepRecord(principal, babyId, id, request.body, idempotencyKey);
      reply.status(200).send({ data: result });
    },
  );

  // 5. DELETE /api/v1/babies/:babyId/records/sleep/:id
  fastify.delete<{ Params: BabyAndIdParam; Querystring: { baseVersion?: string } }>(
    "/api/v1/babies/:babyId/records/sleep/:id",
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
      const result = await service.deleteSleepRecord(principal, babyId, id, baseVersion, idempotencyKey);
      reply.status(200).send({
        data: {
          id: result.id,
          deleted: true,
        },
      });
    },
  );
};
