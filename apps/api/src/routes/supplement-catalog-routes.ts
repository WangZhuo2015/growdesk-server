import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import {
  ApiErrorEnvelopeSchema,
  BabyAndIdParamSchema,
  BabyIdParamSchema,
  CreateSupplementProductRequestSchema,
  CreateSupplementScheduleRequestSchema,
  DeleteRecordResponseSchema,
  FamilyAndProductParamSchema,
  FamilyIdParamSchema,
  SupplementProductListQuerySchema,
  SupplementProductListResponseSchema,
  SupplementProductResponseSchema,
  SupplementScheduleListQuerySchema,
  SupplementScheduleListResponseSchema,
  SupplementScheduleResponseSchema,
  UpdateSupplementProductRequestSchema,
  type BabyAndIdParam,
  type BabyIdParam,
  type CreateSupplementProductRequest,
  type CreateSupplementScheduleRequest,
  type FamilyAndProductParam,
  type FamilyIdParam,
  type SupplementProductListQuery,
  type SupplementScheduleListQuery,
  type UpdateSupplementProductRequest,
} from "@growdesk/contracts";
import { SupplementCatalogService } from "../services/supplement-catalog-service.js";

export interface SupplementCatalogRoutesOptions {
  readonly prisma: PrismaClient;
}

export const supplementCatalogRoutes: FastifyPluginAsync<SupplementCatalogRoutesOptions> = async (fastify, options) => {
  const service = new SupplementCatalogService(options.prisma);

  fastify.get<{ Params: FamilyIdParam; Querystring: SupplementProductListQuery }>(
    "/api/v1/families/:familyId/nutrition/supplement-products",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: FamilyIdParamSchema,
        querystring: SupplementProductListQuerySchema,
        response: { 200: SupplementProductListResponseSchema, 400: ApiErrorEnvelopeSchema, 401: ApiErrorEnvelopeSchema, 403: ApiErrorEnvelopeSchema },
      },
    },
    async (request, reply) => reply.send(await service.listProducts(request.principal!, request.params.familyId, request.query)),
  );

  fastify.post<{ Params: FamilyIdParam; Body: CreateSupplementProductRequest }>(
    "/api/v1/families/:familyId/nutrition/supplement-products",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: FamilyIdParamSchema,
        body: CreateSupplementProductRequestSchema,
        response: { 201: SupplementProductResponseSchema, 400: ApiErrorEnvelopeSchema, 401: ApiErrorEnvelopeSchema, 403: ApiErrorEnvelopeSchema },
      },
    },
    async (request, reply) => reply.status(201).send({ data: await service.createProduct(request.principal!, request.params.familyId, request.body) }),
  );

  fastify.patch<{ Params: FamilyAndProductParam; Body: UpdateSupplementProductRequest }>(
    "/api/v1/families/:familyId/nutrition/supplement-products/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: FamilyAndProductParamSchema,
        body: UpdateSupplementProductRequestSchema,
        response: { 200: SupplementProductResponseSchema, 400: ApiErrorEnvelopeSchema, 401: ApiErrorEnvelopeSchema, 403: ApiErrorEnvelopeSchema, 404: ApiErrorEnvelopeSchema, 409: ApiErrorEnvelopeSchema },
      },
    },
    async (request, reply) => reply.send({ data: await service.updateProduct(request.principal!, request.params.familyId, request.params.id, request.body) }),
  );

  fastify.delete<{ Params: FamilyAndProductParam }>(
    "/api/v1/families/:familyId/nutrition/supplement-products/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: FamilyAndProductParamSchema,
        response: { 200: DeleteRecordResponseSchema, 401: ApiErrorEnvelopeSchema, 403: ApiErrorEnvelopeSchema, 404: ApiErrorEnvelopeSchema },
      },
    },
    async (request, reply) => reply.send({ data: await service.deleteProduct(request.principal!, request.params.familyId, request.params.id) }),
  );

  fastify.get<{ Params: BabyIdParam; Querystring: SupplementScheduleListQuery }>(
    "/api/v1/babies/:babyId/nutrition/supplement-schedules",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        querystring: SupplementScheduleListQuerySchema,
        response: { 200: SupplementScheduleListResponseSchema, 401: ApiErrorEnvelopeSchema, 403: ApiErrorEnvelopeSchema },
      },
    },
    async (request, reply) => reply.send(await service.listSchedules(request.principal!, request.params.babyId, request.query.date)),
  );

  fastify.post<{ Params: BabyIdParam; Body: CreateSupplementScheduleRequest }>(
    "/api/v1/babies/:babyId/nutrition/supplement-schedules",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        body: CreateSupplementScheduleRequestSchema,
        response: { 200: SupplementScheduleResponseSchema, 201: SupplementScheduleResponseSchema, 400: ApiErrorEnvelopeSchema, 401: ApiErrorEnvelopeSchema, 403: ApiErrorEnvelopeSchema, 404: ApiErrorEnvelopeSchema, 409: ApiErrorEnvelopeSchema },
      },
    },
    async (request, reply) => {
      const result = await service.upsertSchedule(request.principal!, request.params.babyId, request.body);
      return reply.status(result.created ? 201 : 200).send({ data: result.schedule });
    },
  );

  fastify.delete<{ Params: BabyAndIdParam }>(
    "/api/v1/babies/:babyId/nutrition/supplement-schedules/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyAndIdParamSchema,
        response: { 200: DeleteRecordResponseSchema, 401: ApiErrorEnvelopeSchema, 403: ApiErrorEnvelopeSchema, 404: ApiErrorEnvelopeSchema },
      },
    },
    async (request, reply) => reply.send({ data: await service.deleteSchedule(request.principal!, request.params.babyId, request.params.id) }),
  );
};
