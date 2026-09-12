import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import {
  ApiErrorEnvelopeSchema,
  BabyIdParamSchema,
  BabyAndIdParamSchema,
  PaginationQuerySchema,
  CreateFeedingRequestSchema,
  UpdateFeedingRequestSchema,
  FeedingRecordResponseSchema,
  FeedingListResponseSchema,
  DeleteRecordResponseSchema,
  type BabyIdParam,
  type BabyAndIdParam,
  type PaginationQuery,
  type CreateFeedingRequest,
  type UpdateFeedingRequest,
} from "@growdesk/contracts";
import { FeedingService } from "../services/feeding-service.js";

export interface FeedingRoutesOptions {
  readonly prisma: PrismaClient;
}

export const feedingRoutes: FastifyPluginAsync<FeedingRoutesOptions> = async (fastify, options) => {
  const service = new FeedingService(options.prisma);

  // 1. GET /api/v1/babies/:babyId/records/feeding
  fastify.get<{ Params: BabyIdParam; Querystring: PaginationQuery }>(
    "/api/v1/babies/:babyId/records/feeding",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        querystring: PaginationQuerySchema,
        response: {
          200: FeedingListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId } = request.params;
      const result = await service.listFeedingRecords(principal, babyId, request.query);
      reply.status(200).send(result);
    },
  );

  // 2. POST /api/v1/babies/:babyId/records/feeding
  fastify.post<{ Params: BabyIdParam; Body: CreateFeedingRequest }>(
    "/api/v1/babies/:babyId/records/feeding",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        body: CreateFeedingRequestSchema,
        response: {
          201: FeedingRecordResponseSchema,
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
      const result = await service.createFeedingRecord(principal, babyId, request.body, idempotencyKey);
      reply.status(201).send({ data: result });
    },
  );

  // 3. GET /api/v1/babies/:babyId/records/feeding/:id
  fastify.get<{ Params: BabyAndIdParam }>(
    "/api/v1/babies/:babyId/records/feeding/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        response: {
          200: FeedingRecordResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId, id } = request.params;
      const result = await service.getFeedingRecord(principal, babyId, id);
      reply.status(200).send({ data: result });
    },
  );

  // 4. PATCH /api/v1/babies/:babyId/records/feeding/:id
  fastify.patch<{ Params: BabyAndIdParam; Body: UpdateFeedingRequest }>(
    "/api/v1/babies/:babyId/records/feeding/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        body: UpdateFeedingRequestSchema,
        response: {
          200: FeedingRecordResponseSchema,
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
      const result = await service.updateFeedingRecord(principal, babyId, id, request.body, idempotencyKey);
      reply.status(200).send({ data: result });
    },
  );

  // 5. DELETE /api/v1/babies/:babyId/records/feeding/:id
  fastify.delete<{ Params: BabyAndIdParam }>(
    "/api/v1/babies/:babyId/records/feeding/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        response: {
          200: DeleteRecordResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId, id } = request.params;
      const idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      const result = await service.deleteFeedingRecord(principal, babyId, id, 1, idempotencyKey);
      reply.status(200).send({
        data: {
          id: result.id,
          deleted: true,
        },
      });
    },
  );
};
