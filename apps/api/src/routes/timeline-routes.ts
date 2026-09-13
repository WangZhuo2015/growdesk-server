import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "@growdesk/database";
import {
  ApiErrorEnvelopeSchema,
  BabyIdParamSchema,
  PaginationQuerySchema,
  TimelineResponseSchema,
  type BabyIdParam,
  type PaginationQuery,
} from "@growdesk/contracts";
import { TimelineService } from "../services/timeline-service.js";

export interface TimelineRoutesOptions {
  readonly prisma: PrismaClient;
}

export const timelineRoutes: FastifyPluginAsync<TimelineRoutesOptions> = async (fastify, options) => {
  const service = new TimelineService(options.prisma);

  // 1. GET /api/v1/babies/:babyId/timeline
  fastify.get<{ Params: BabyIdParam; Querystring: PaginationQuery & { entityType?: string } }>(
    "/api/v1/babies/:babyId/timeline",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: BabyIdParamSchema,
        querystring: PaginationQuerySchema,
        response: {
          200: TimelineResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const { babyId } = request.params;
      const result = await service.listTimeline(principal, babyId, request.query);
      reply.status(200).send(result);
    },
  );
};
