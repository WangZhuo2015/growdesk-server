import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import {
  ApiErrorEnvelopeSchema,
  FamilyListResponseSchema,
  FamilyResponseSchema,
  CreateFamilyRequestSchema,
  UpdateFamilyRequestSchema,
  CreateFamilyInviteRequestSchema,
  CreateFamilyInviteResponseSchema,
  PreviewFamilyInviteQuerySchema,
  PreviewFamilyInviteResponseSchema,
  JoinFamilyRequestSchema,
  JoinFamilyResponseSchema,
  FamilyMemberListResponseSchema,
  UpdateFamilyMemberRequestSchema,
  RemoveFamilyMemberResponseSchema,
  BabyListResponseSchema,
  BabyResponseSchema,
  CreateBabyRequestSchema,
  SuccessStatusResponseSchema,
  IdParamSchema,
  FamilyAndMemberParamSchema,
  type CreateFamilyRequest,
  type UpdateFamilyRequest,
  type CreateFamilyInviteRequest,
  type PreviewFamilyInviteQuery,
  type JoinFamilyRequest,
  type UpdateFamilyMemberRequest,
  type CreateBabyRequest,
} from "@growdesk/contracts";
import { FamilyBabyService } from "../services/family-baby-service.js";

export interface FamilyRoutesOptions {
  readonly prisma: PrismaClient;
}

export const familyRoutes: FastifyPluginAsync<FamilyRoutesOptions> = async (fastify, options) => {
  const service = new FamilyBabyService(options.prisma);

  // 1. GET /api/v1/families
  fastify.get(
    "/api/v1/families",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: FamilyListResponseSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const families = await service.listFamilies(request.principal!);
      return { data: families };
    },
  );

  // 2. POST /api/v1/families
  fastify.post<{ Body: CreateFamilyRequest }>(
    "/api/v1/families",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: CreateFamilyRequestSchema,
        response: {
          201: FamilyResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const family = await service.createFamily(request.principal!, request.body);
      reply.status(201);
      return { data: family };
    },
  );

  // 3. GET /api/v1/families/invites/preview (MUST be mounted before /api/v1/families/:id)
  fastify.get<{ Querystring: PreviewFamilyInviteQuery }>(
    "/api/v1/families/invites/preview",
    {
      schema: {
        querystring: PreviewFamilyInviteQuerySchema,
        response: {
          200: PreviewFamilyInviteResponseSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const preview = await service.previewFamilyInvite(request.query.code);
      return { data: preview };
    },
  );

  // 4. POST /api/v1/families/join (MUST be mounted before /api/v1/families/:id)
  fastify.post<{ Body: JoinFamilyRequest }>(
    "/api/v1/families/join",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: JoinFamilyRequestSchema,
        response: {
          200: JoinFamilyResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const result = await service.joinFamily(request.principal!, request.body.inviteCode);
      return { data: result };
    },
  );

  // 5. GET /api/v1/families/:id
  fastify.get<{ Params: { id: string } }>(
    "/api/v1/families/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: IdParamSchema,
        response: {
          200: FamilyResponseSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const family = await service.getFamily(request.principal!, request.params.id);
      return { data: family };
    },
  );

  // 6. PATCH /api/v1/families/:id
  fastify.patch<{ Params: { id: string }; Body: UpdateFamilyRequest }>(
    "/api/v1/families/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: IdParamSchema,
        body: UpdateFamilyRequestSchema,
        response: {
          200: FamilyResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const family = await service.updateFamily(request.principal!, request.params.id, request.body);
      return { data: family };
    },
  );

  // 7. POST /api/v1/families/:id/invites
  fastify.post<{ Params: { id: string }; Body: CreateFamilyInviteRequest }>(
    "/api/v1/families/:id/invites",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: IdParamSchema,
        body: CreateFamilyInviteRequestSchema,
        response: {
          201: CreateFamilyInviteResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const invite = await service.createFamilyInvite(
        request.principal!,
        request.params.id,
        request.body?.expiresInDays ?? 7,
      );
      reply.status(201);
      return { data: invite };
    },
  );

  // 8. GET /api/v1/families/:id/members
  fastify.get<{ Params: { id: string } }>(
    "/api/v1/families/:id/members",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: IdParamSchema,
        response: {
          200: FamilyMemberListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const members = await service.listFamilyMembers(request.principal!, request.params.id);
      return { data: members };
    },
  );

  // 9. PATCH /api/v1/families/:id/members/:userId
  fastify.patch<{ Params: { id: string; userId: string }; Body: UpdateFamilyMemberRequest }>(
    "/api/v1/families/:id/members/:userId",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: FamilyAndMemberParamSchema,
        body: UpdateFamilyMemberRequestSchema,
        response: {
          200: SuccessStatusResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const result = await service.updateFamilyMember(
        request.principal!,
        request.params.id,
        request.params.userId,
        request.body.role,
      );
      return { data: result };
    },
  );

  // 10. DELETE /api/v1/families/:id/members/:userId
  fastify.delete<{ Params: { id: string; userId: string } }>(
    "/api/v1/families/:id/members/:userId",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: FamilyAndMemberParamSchema,
        response: {
          200: RemoveFamilyMemberResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const result = await service.removeFamilyMember(
        request.principal!,
        request.params.id,
        request.params.userId,
      );
      return { data: result };
    },
  );

  // 11. GET /api/v1/families/:id/babies
  fastify.get<{ Params: { id: string } }>(
    "/api/v1/families/:id/babies",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: IdParamSchema,
        response: {
          200: BabyListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request) => {
      const babies = await service.listFamilyBabies(request.principal!, request.params.id);
      return { data: babies };
    },
  );

  // 12. POST /api/v1/families/:id/babies
  fastify.post<{ Params: { id: string }; Body: CreateBabyRequest }>(
    "/api/v1/families/:id/babies",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: IdParamSchema,
        body: CreateBabyRequestSchema,
        response: {
          201: BabyResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const baby = await service.createFamilyBaby(
        request.principal!,
        request.params.id,
        request.body,
      );
      reply.status(201);
      return { data: baby };
    },
  );
};
