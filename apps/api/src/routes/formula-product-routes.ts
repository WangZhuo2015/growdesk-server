import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import {
  ApiErrorEnvelopeSchema,
  FamilyIdParamSchema,
  FamilyAndProductParamSchema,
  PaginationQuerySchema,
  CreateFormulaProductRequestSchema,
  UpdateFormulaProductRequestSchema,
  FormulaProductResponseSchema,
  FormulaProductListResponseSchema,
  DeleteRecordResponseSchema,
  type FamilyIdParam,
  type FamilyAndProductParam,
  type PaginationQuery,
  type CreateFormulaProductRequest,
  type UpdateFormulaProductRequest,
} from "@growdesk/contracts";
import { FormulaProductService } from "../services/formula-product-service.js";

export interface FormulaProductRoutesOptions {
  readonly prisma: PrismaClient;
}

export const formulaProductRoutes: FastifyPluginAsync<FormulaProductRoutesOptions> = async (fastify, options) => {
  const service = new FormulaProductService(options.prisma);

  // 1. GET /api/v1/families/:familyId/nutrition/products
  fastify.get<{ Params: FamilyIdParam; Querystring: PaginationQuery }>(
    "/api/v1/families/:familyId/nutrition/products",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: FamilyIdParamSchema,
        querystring: PaginationQuerySchema,
        response: {
          200: FormulaProductListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { familyId } = request.params;
      const result = await service.listFormulaProducts(principal, familyId, {
        limit: request.query?.limit,
      });
      reply.status(200).send(result);
    },
  );

  // 2. POST /api/v1/families/:familyId/nutrition/products
  fastify.post<{ Params: FamilyIdParam; Body: CreateFormulaProductRequest }>(
    "/api/v1/families/:familyId/nutrition/products",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: FamilyIdParamSchema,
        body: CreateFormulaProductRequestSchema,
        response: {
          201: FormulaProductResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { familyId } = request.params;
      const result = await service.createFormulaProduct(principal, familyId, request.body);
      reply.status(201).send({ data: result });
    },
  );

  // 3. PATCH /api/v1/families/:familyId/nutrition/products/:id
  fastify.patch<{ Params: FamilyAndProductParam; Body: UpdateFormulaProductRequest }>(
    "/api/v1/families/:familyId/nutrition/products/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: FamilyAndProductParamSchema,
        body: UpdateFormulaProductRequestSchema,
        response: {
          200: FormulaProductResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { familyId, id } = request.params;
      const result = await service.updateFormulaProduct(principal, familyId, id, request.body);
      reply.status(200).send({ data: result });
    },
  );

  // 4. DELETE /api/v1/families/:familyId/nutrition/products/:id
  fastify.delete<{ Params: FamilyAndProductParam }>(
    "/api/v1/families/:familyId/nutrition/products/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: FamilyAndProductParamSchema,
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
      const { familyId, id } = request.params;
      const result = await service.deleteFormulaProduct(principal, familyId, id);
      reply.status(200).send({
        data: {
          id: result.id,
          deleted: true,
        },
      });
    },
  );
};
