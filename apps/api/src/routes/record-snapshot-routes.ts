import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import {
  ApiErrorEnvelopeSchema,
  BabyIdParamSchema,
  RecordSnapshotDeleteRequestSchema,
  RecordSnapshotDeleteResponseSchema,
  RecordSnapshotEntityTypeSchema,
  RecordSnapshotListQuerySchema,
  RecordSnapshotListResponseSchema,
  RecordSnapshotRestoreRequestSchema,
  RecordSnapshotRestoreResponseSchema,
  RecordSnapshotSchema,
  type RecordSnapshotDeleteRequest,
  type RecordSnapshotEntityType,
  type RecordSnapshotListQuery,
  type RecordSnapshotRestoreRequest,
} from "@growdesk/contracts";
import { RecordSnapshotService } from "../services/record-snapshot-service.js";

interface SnapshotBabyParams { babyId: string }
interface SnapshotParams extends SnapshotBabyParams { snapshotId: string }
interface DeleteParams extends SnapshotBabyParams { entityType: RecordSnapshotEntityType; entityId: string }

export interface RecordSnapshotRoutesOptions {
  readonly prisma: PrismaClient;
}

const snapshotIdParamSchema = {
  type: "object",
  properties: {
    babyId: { type: "string", format: "uuid" },
    snapshotId: { type: "string", minLength: 1, maxLength: 200 },
  },
  required: ["babyId", "snapshotId"],
  additionalProperties: false,
} as const;

export const recordSnapshotRoutes: FastifyPluginAsync<RecordSnapshotRoutesOptions> = async (fastify, options) => {
  const service = new RecordSnapshotService(options.prisma);

  fastify.get<{ Params: SnapshotBabyParams; Querystring: RecordSnapshotListQuery }>(
    "/api/v1/babies/:babyId/record-snapshots",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        querystring: RecordSnapshotListQuerySchema,
        response: {
          200: RecordSnapshotListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const data = await service.listSnapshots(request.principal!, request.params.babyId, request.query);
      return reply.status(200).send(data);
    },
  );

  fastify.get<{ Params: SnapshotParams }>(
    "/api/v1/babies/:babyId/record-snapshots/:snapshotId",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: snapshotIdParamSchema,
        response: {
          200: { type: "object", properties: { data: { $ref: "RecordSnapshot#" } }, required: ["data"], additionalProperties: false },
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const data = await service.getSnapshot(request.principal!, request.params.babyId, request.params.snapshotId);
      return reply.status(200).send({ data });
    },
  );

  fastify.delete<{ Params: DeleteParams; Body: RecordSnapshotDeleteRequest | null }>(
    "/api/v1/babies/:babyId/record-snapshots/:entityType/:entityId",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: {
          type: "object",
          properties: {
            babyId: { type: "string", format: "uuid" },
            entityType: RecordSnapshotEntityTypeSchema,
            entityId: { type: "string", minLength: 1 },
          },
          required: ["babyId", "entityType", "entityId"],
          additionalProperties: false,
        },
        // MCP retries may send DELETE without a JSON body when no baseVersion
        // is known.  Treat that as the empty request while still rejecting
        // arbitrary body fields when a body is present.
        body: { anyOf: [RecordSnapshotDeleteRequestSchema, { type: "null" }] },
        response: {
          200: RecordSnapshotDeleteResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
          422: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.deleteWithSnapshot(
        request.principal!,
        request.params.babyId,
        request.params.entityType,
        request.params.entityId,
        request.body?.baseVersion ? Number(request.body.baseVersion) : undefined,
        request.headers["idempotency-key"] as string | undefined,
        { source: "mcp" },
      );
      return reply.status(200).send({ data: result });
    },
  );

  fastify.post<{ Params: SnapshotBabyParams; Body: RecordSnapshotRestoreRequest }>(
    "/api/v1/babies/:babyId/record-snapshots/restore",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        body: RecordSnapshotRestoreRequestSchema,
        response: {
          200: RecordSnapshotRestoreResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
          422: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.restore(request.principal!, request.params.babyId, request.body);
      return reply.status(200).send({ data: result });
    },
  );

  fastify.post<{ Params: SnapshotParams }>(
    "/api/v1/babies/:babyId/record-snapshots/:snapshotId/restore",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: snapshotIdParamSchema,
        response: {
          200: RecordSnapshotRestoreResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
          422: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await service.restore(request.principal!, request.params.babyId, { snapshotId: request.params.snapshotId });
      return reply.status(200).send({ data: result });
    },
  );
};
