import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import {
  AcknowledgeVoiceLogRequestSchema,
  ApiErrorEnvelopeSchema,
  CreateVoiceLogRequestSchema,
  IdParamSchema,
  VoiceLogAckResponseSchema,
  VoiceLogListQuerySchema,
  VoiceLogQueryResponseSchema,
  VoiceLogResponseSchema,
  type AcknowledgeVoiceLogRequest,
  type CreateVoiceLogRequest,
  type VoiceLogListQuery,
} from "@growdesk/contracts";
import { VoiceLogService } from "../services/voice-log-service.js";

export interface VoiceLogRoutesOptions {
  readonly prisma: PrismaClient;
}

export const voiceLogRoutes: FastifyPluginAsync<VoiceLogRoutesOptions> = async (fastify, options) => {
  const service = new VoiceLogService(options.prisma);

  fastify.get<{ Querystring: VoiceLogListQuery }>(
    "/api/v1/voice/logs",
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: VoiceLogListQuerySchema,
        response: {
          200: VoiceLogQueryResponseSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => reply.status(200).send(await service.list(request.principal!, request.query)),
  );

  fastify.post<{ Body: CreateVoiceLogRequest }>(
    "/api/v1/voice/logs",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: CreateVoiceLogRequestSchema,
        response: {
          201: VoiceLogResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => reply.status(201).send(await service.create(request.principal!, request.body)),
  );

  fastify.get<{ Params: { id: string } }>(
    "/api/v1/voice/logs/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: IdParamSchema,
        response: {
          200: VoiceLogResponseSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => reply.status(200).send(await service.get(request.principal!, request.params.id)),
  );

  fastify.patch<{ Params: { id: string }; Body: AcknowledgeVoiceLogRequest }>(
    "/api/v1/voice/logs/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: IdParamSchema,
        body: AcknowledgeVoiceLogRequestSchema,
        response: {
          200: VoiceLogAckResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => reply.status(200).send(
      await service.acknowledge(request.principal!, request.params.id, request.body.acknowledged),
    ),
  );
};
