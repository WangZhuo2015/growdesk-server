import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import {
  ApiErrorEnvelopeSchema,
  BabyResponseSchema,
  UpdateBabyRequestSchema,
  BabyMemberListResponseSchema,
  AddBabyMemberRequestSchema,
  RemoveBabyMemberResponseSchema,
  SuccessStatusResponseSchema,
  IdParamSchema,
  FamilyAndMemberParamSchema,
  type UpdateBabyRequest,
  type AddBabyMemberRequest,
} from "@growdesk/contracts";
import { FamilyBabyService } from "../services/family-baby-service.js";

export interface BabyRoutesOptions {
  readonly prisma: PrismaClient;
}

export const babyRoutes: FastifyPluginAsync<BabyRoutesOptions> = async (fastify, options) => {
  const service = new FamilyBabyService(options.prisma);

  // 1. GET /api/v1/babies/:id
  fastify.get<{ Params: { id: string } }>(
    "/api/v1/babies/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: IdParamSchema,
        response: {
          200: BabyResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const baby = await service.getBaby(request.principal!, request.params.id);
      return { data: baby };
    },
  );

  // 2. PATCH /api/v1/babies/:id
  fastify.patch<{ Params: { id: string }; Body: UpdateBabyRequest }>(
    "/api/v1/babies/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: IdParamSchema,
        body: UpdateBabyRequestSchema,
        response: {
          200: BabyResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const baby = await service.updateBaby(
        request.principal!,
        request.params.id,
        request.body,
      );
      return { data: baby };
    },
  );

  // 3. GET /api/v1/babies/:id/members
  fastify.get<{ Params: { id: string } }>(
    "/api/v1/babies/:id/members",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: IdParamSchema,
        response: {
          200: BabyMemberListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const members = await service.listBabyMembers(request.principal!, request.params.id);
      return { data: members };
    },
  );

  // 4. POST /api/v1/babies/:id/members
  fastify.post<{ Params: { id: string }; Body: AddBabyMemberRequest }>(
    "/api/v1/babies/:id/members",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: IdParamSchema,
        body: AddBabyMemberRequestSchema,
        response: {
          201: SuccessStatusResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.addBabyMember(
        request.principal!,
        request.params.id,
        request.body.userId,
        request.body.role,
      );
      reply.status(201);
      return { data: result };
    },
  );

  // 5. DELETE /api/v1/babies/:id/members/:userId
  fastify.delete<{ Params: { id: string; userId: string } }>(
    "/api/v1/babies/:id/members/:userId",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: FamilyAndMemberParamSchema,
        response: {
          200: RemoveBabyMemberResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const result = await service.removeBabyMember(
        request.principal!,
        request.params.id,
        request.params.userId,
      );
      return { data: result };
    },
  );
};
