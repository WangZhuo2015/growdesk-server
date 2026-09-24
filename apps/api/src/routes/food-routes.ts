import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import { ConcurrencyConflictError } from "@growdesk/database";
import {
  ApiErrorEnvelopeSchema,
  BabyIdParamSchema,
  BabyAndIdParamSchema,
  PaginationQuerySchema,
  CreateFoodRequestSchema,
  UpdateFoodRequestSchema,
  FoodRecordResponseSchema,
  FoodListResponseSchema,
  DeleteRecordResponseSchema,
  FoodLibraryItemListResponseSchema,
  FoodLibraryItemSchema,
  CreateFoodLibraryItemRequestSchema,
  FoodLibraryItemsQuerySchema,
  FoodGuidelinesResponseSchema,
  FoodPlanResponseSchema,
  SaveFoodPlanRequestSchema,
  type BabyIdParam,
  type BabyAndIdParam,
  type PaginationQuery,
  type CreateFoodRequest,
  type UpdateFoodRequest,
  type CreateFoodLibraryItemRequest,
  type FoodLibraryItemsQuery,
  type SaveFoodPlanRequest,
} from "@growdesk/contracts";
import { FoodService } from "../services/food-service.js";

export interface FoodRoutesOptions {
  readonly prisma: PrismaClient;
}

export const foodRoutes: FastifyPluginAsync<FoodRoutesOptions> = async (fastify, options) => {
  const service = new FoodService(options.prisma);

  // 1. GET /api/v1/babies/:babyId/records/food
  fastify.get<{ Params: BabyIdParam; Querystring: PaginationQuery }>(
    "/api/v1/babies/:babyId/records/food",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        querystring: PaginationQuerySchema,
        response: {
          200: FoodListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId } = request.params;
      const result = await service.listFoodRecords(principal, babyId, request.query);
      reply.status(200).send(result);
    },
  );

  // 2. POST /api/v1/babies/:babyId/records/food
  fastify.post<{ Params: BabyIdParam; Body: CreateFoodRequest }>(
    "/api/v1/babies/:babyId/records/food",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        body: CreateFoodRequestSchema,
        response: {
          201: FoodRecordResponseSchema,
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
      const result = await service.createFoodRecord(principal, babyId, request.body, idempotencyKey);
      reply.status(201).send({ data: result });
    },
  );

  // 3. GET /api/v1/babies/:babyId/records/food/:id
  fastify.get<{ Params: BabyAndIdParam }>(
    "/api/v1/babies/:babyId/records/food/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        response: {
          200: FoodRecordResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId, id } = request.params;
      const result = await service.getFoodRecord(principal, babyId, id);
      reply.status(200).send({ data: result });
    },
  );

  // 4. PATCH /api/v1/babies/:babyId/records/food/:id
  fastify.patch<{ Params: BabyAndIdParam; Body: UpdateFoodRequest }>(
    "/api/v1/babies/:babyId/records/food/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        body: UpdateFoodRequestSchema,
        response: {
          200: FoodRecordResponseSchema,
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
      const result = await service.updateFoodRecord(principal, babyId, id, request.body, idempotencyKey);
      reply.status(200).send({ data: result });
    },
  );

  // 5. DELETE /api/v1/babies/:babyId/records/food/:id
  fastify.delete<{ Params: BabyAndIdParam; Querystring: { baseVersion?: string } }>(
    "/api/v1/babies/:babyId/records/food/:id",
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
      const result = await service.deleteFoodRecord(principal, babyId, id, baseVersion, idempotencyKey);
      reply.status(200).send({
        data: {
          id: result.id,
          deleted: true,
        },
      });
    },
  );

  // 6. GET /api/v1/food/items
  fastify.get<{ Querystring: FoodLibraryItemsQuery }>(
    "/api/v1/food/items",
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: FoodLibraryItemsQuerySchema,
        response: {
          200: FoodLibraryItemListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          400: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const items = await service.listFoodLibraryItems(principal, request.query);
      reply.status(200).send({ data: items });
    },
  );

  // 7. POST /api/v1/food/items
  fastify.post<{ Body: CreateFoodLibraryItemRequest }>(
    "/api/v1/food/items",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: CreateFoodLibraryItemRequestSchema,
        response: {
          201: FoodLibraryItemSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const item = await service.createFoodLibraryItem(principal, request.body);
      reply.status(201).send(item);
    },
  );

  // 8. GET /api/v1/food/guidelines
  fastify.get(
    "/api/v1/food/guidelines",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: FoodGuidelinesResponseSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (_request, reply) => {
      const guidelines = service.getFoodGuidelines();
      reply.status(200).send({ data: guidelines });
    },
  );

  // 9. GET /api/v1/babies/:babyId/food-plan
  fastify.get<{ Params: BabyIdParam }>(
    "/api/v1/babies/:babyId/food-plan",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        response: {
          200: FoodPlanResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId } = request.params;
      const plan = await service.getFoodPlan(principal, babyId);
      reply.status(200).send({ data: plan });
    },
  );

  // 10. PUT /api/v1/babies/:babyId/food-plan
  fastify.put<{ Params: BabyIdParam; Body: SaveFoodPlanRequest }>(
    "/api/v1/babies/:babyId/food-plan",
    {
      preHandler: [fastify.authenticate],
      // Keep the missing-precondition failure distinct from malformed plan
      // data. Older clients must not silently overwrite the shared document.
      preValidation: async (request) => {
        if (typeof (request.body as Partial<SaveFoodPlanRequest> | undefined)?.baseVersion !== "string") {
          throw new ConcurrencyConflictError("baseVersion is required; reload the food plan before saving");
        }
      },
      schema: {
        params: BabyIdParamSchema,
        body: SaveFoodPlanRequestSchema,
        response: {
          200: FoodPlanResponseSchema,
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
      const plan = await service.saveFoodPlan(principal, babyId, request.body.planData, request.body.baseVersion);
      reply.status(200).send({ data: plan });
    },
  );
};
