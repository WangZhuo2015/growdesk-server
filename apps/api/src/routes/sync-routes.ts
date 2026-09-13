import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";
import {
  ApiErrorEnvelopeSchema,
  SyncCommandBatchRequestSchema,
  SyncCommandBatchResponseSchema,
  FamilyChangesResponseSchema,
  UserChangesResponseSchema,
  CreateSyncSnapshotResponseSchema,
  SyncSnapshotResponseSchema,
  FamilyIdParamSchema,
  IdParamSchema,
  PaginationQuerySchema,
  UuidString,
  type SyncCommandBatchRequest,
  type PaginationQuery,
  type FamilyIdParam,
  type IdParam,
} from "@growdesk/contracts";
import type { SyncService } from "../services/sync-service.js";

export interface SyncRoutesOptions {
  readonly syncService: SyncService;
}

export const syncRoutes: FastifyPluginAsync<SyncRoutesOptions> = async (
  fastify,
  options
) => {
  const { syncService } = options;

  // 1. POST /api/v1/sync/commands - Execute offline command batch
  fastify.post<{ Body: SyncCommandBatchRequest }>(
    "/api/v1/sync/commands",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: SyncCommandBatchRequestSchema,
        response: {
          200: SyncCommandBatchResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          422: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const result = await syncService.executeSyncCommands(principal, request.body);
      reply.status(200).send(result);
    }
  );

  // 2. GET /api/v1/sync/families/:familyId/changes - Incremental change feed for family scope
  fastify.get<{ Params: FamilyIdParam; Querystring: PaginationQuery }>(
    "/api/v1/sync/families/:familyId/changes",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: FamilyIdParamSchema,
        querystring: PaginationQuerySchema,
        response: {
          200: FamilyChangesResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          410: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { familyId } = request.params;
      const result = await syncService.getFamilyChanges(
        principal,
        familyId,
        request.query
      );
      reply.status(200).send(result);
    }
  );

  // 3. GET /api/v1/sync/me/changes - Incremental change feed for user scope
  fastify.get<{ Querystring: PaginationQuery }>(
    "/api/v1/sync/me/changes",
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: PaginationQuerySchema,
        response: {
          200: UserChangesResponseSchema,
          401: ApiErrorEnvelopeSchema,
          410: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const result = await syncService.getUserChanges(principal, request.query);
      reply.status(200).send(result);
    }
  );

  // 4. POST /api/v1/sync/families/:id/snapshots - Queue repeatable read bootstrap snapshot
  fastify.post<{ Params: IdParam }>(
    "/api/v1/sync/families/:id/snapshots",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: IdParamSchema,
        response: {
          202: CreateSyncSnapshotResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { id } = request.params;
      const result = await syncService.createFamilySnapshot(principal, id);
      reply.status(202).send(result);
    }
  );

  // 5. GET /api/v1/sync/families/:id/snapshots/:snapshotId - Get snapshot manifest and download status
  fastify.get<{ Params: { id: string; snapshotId: string } }>(
    "/api/v1/sync/families/:id/snapshots/:snapshotId",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: Type.Object(
          {
            id: UuidString,
            snapshotId: UuidString,
          },
          { additionalProperties: false }
        ),
        response: {
          200: SyncSnapshotResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { id, snapshotId } = request.params;
      const result = await syncService.getFamilySnapshot(
        principal,
        id,
        snapshotId
      );
      reply.status(200).send(result);
    }
  );
};
