import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import {
  ApiErrorEnvelopeSchema,
  BabyIdParamSchema,
  BabyAndIdParamSchema,
  PaginationQuerySchema,
  CreateGrowthMeasurementRequestSchema,
  UpdateGrowthMeasurementRequestSchema,
  GrowthMeasurementResponseSchema,
  GrowthMeasurementListResponseSchema,
  GrowthChartResponseSchema,
  DeleteRecordResponseSchema,
  type BabyIdParam,
  type BabyAndIdParam,
  type PaginationQuery,
  type CreateGrowthMeasurementRequest,
  type UpdateGrowthMeasurementRequest,
} from "@growdesk/contracts";
import { GrowthService } from "../services/growth-service.js";

export interface GrowthRoutesOptions {
  readonly prisma: PrismaClient;
}

export const growthRoutes: FastifyPluginAsync<GrowthRoutesOptions> = async (fastify, options) => {
  const service = new GrowthService(options.prisma);

  // 1. GET /api/v1/babies/:babyId/growth-measurements
  fastify.get<{ Params: BabyIdParam; Querystring: PaginationQuery }>(
    "/api/v1/babies/:babyId/growth-measurements",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        querystring: PaginationQuerySchema,
        response: {
          200: GrowthMeasurementListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId } = request.params;
      const result = await service.listGrowthMeasurements(principal, babyId, request.query);
      reply.status(200).send(result);
    },
  );

  // 2. POST /api/v1/babies/:babyId/growth-measurements
  fastify.post<{ Params: BabyIdParam; Body: CreateGrowthMeasurementRequest }>(
    "/api/v1/babies/:babyId/growth-measurements",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        body: CreateGrowthMeasurementRequestSchema,
        response: {
          201: GrowthMeasurementResponseSchema,
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
      const result = await service.createGrowthMeasurement(principal, babyId, request.body, idempotencyKey);
      reply.status(201).send({ data: result });
    },
  );

  // 3. GET /api/v1/babies/:babyId/growth-measurements/:id
  fastify.get<{ Params: BabyAndIdParam }>(
    "/api/v1/babies/:babyId/growth-measurements/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        response: {
          200: GrowthMeasurementResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId, id } = request.params;
      const result = await service.getGrowthMeasurement(principal, babyId, id);
      reply.status(200).send({ data: result });
    },
  );

  // 4. PATCH /api/v1/babies/:babyId/growth-measurements/:id
  fastify.patch<{ Params: BabyAndIdParam; Body: UpdateGrowthMeasurementRequest }>(
    "/api/v1/babies/:babyId/growth-measurements/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        body: UpdateGrowthMeasurementRequestSchema,
        response: {
          200: GrowthMeasurementResponseSchema,
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
      const result = await service.updateGrowthMeasurement(principal, babyId, id, request.body, idempotencyKey);
      reply.status(200).send({ data: result });
    },
  );

  // 5. DELETE /api/v1/babies/:babyId/growth-measurements/:id
  fastify.delete<{ Params: BabyAndIdParam; Querystring: { baseVersion?: string } }>(
    "/api/v1/babies/:babyId/growth-measurements/:id",
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
      const result = await service.deleteGrowthMeasurement(principal, babyId, id, baseVersion, idempotencyKey);
      reply.status(200).send({
        data: {
          id: result.id,
          deleted: true,
        },
      });
    },
  );

  // 6. GET /api/v1/babies/:babyId/growth-chart
  fastify.get<{ Params: BabyIdParam }>(
    "/api/v1/babies/:babyId/growth-chart",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        response: {
          200: GrowthChartResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId } = request.params;
      const result = await service.getGrowthChart(principal, babyId);
      reply.status(200).send({ data: result });
    },
  );
};
