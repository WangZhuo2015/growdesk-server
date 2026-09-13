import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { AiService } from "../services/ai-service.js";
import {
  CreateAiSessionRequest,
  CreateAiSessionRequestSchema,
  AiSessionResponseSchema,
  AiSessionListResponseSchema,
  AiMessageListResponseSchema,
  CreateAiRunRequest,
  CreateAiRunRequestSchema,
  AiRunResponseSchema,
  AiRunConfirmRequest,
  AiRunConfirmRequestSchema,
  AiRunConfirmResponseSchema,
  AiRunCancelResponseSchema,
  AiRunRetryResponseSchema,
  CreateVoiceRunRequest,
  CreateVoiceRunRequestSchema,
  VoiceRunResponseSchema,
  CreateDailySummaryRunRequest,
  CreateDailySummaryRunRequestSchema,
  DailySummaryRunResponseSchema,
  DailySummaryListResponseSchema,
  PaginationQuery,
  PaginationQuerySchema,
  ApiErrorEnvelopeSchema,
} from "@growdesk/contracts";

export interface AiRoutesOptions {
  aiService: AiService;
}

export const aiRoutes: FastifyPluginAsync<AiRoutesOptions> = async (
  fastify: FastifyInstance,
  opts: AiRoutesOptions
) => {
  const { aiService } = opts;

  // POST /api/v1/ai/sessions - Create AI conversation session
  fastify.post<{
    Body: CreateAiSessionRequest;
  }>(
    "/api/v1/ai/sessions",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: CreateAiSessionRequestSchema,
        response: {
          201: AiSessionResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await aiService.createSession(request.principal!, request.body);
      return reply.status(201).send(result);
    }
  );

  // GET /api/v1/ai/sessions - List AI sessions for current user
  fastify.get<{
    Querystring: PaginationQuery;
  }>(
    "/api/v1/ai/sessions",
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: PaginationQuerySchema,
        response: {
          200: AiSessionListResponseSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await aiService.listSessions(request.principal!, request.query);
      return reply.status(200).send(result);
    }
  );

  // GET /api/v1/ai/sessions/:id/messages - List messages in session
  fastify.get<{
    Params: { id: string };
    Querystring: PaginationQuery;
  }>(
    "/api/v1/ai/sessions/:id/messages",
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: PaginationQuerySchema,
        response: {
          200: AiMessageListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await aiService.listMessages(
        request.principal!,
        request.params.id,
        request.query
      );
      return reply.status(200).send(result);
    }
  );

  // POST /api/v1/ai/sessions/:id/runs - Start asynchronous AI run
  fastify.post<{
    Params: { id: string };
    Body: CreateAiRunRequest;
  }>(
    "/api/v1/ai/sessions/:id/runs",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: CreateAiRunRequestSchema,
        response: {
          202: AiRunResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await aiService.createRun(
        request.principal!,
        request.params.id,
        request.body
      );
      return reply.status(202).send(result);
    }
  );

  // GET /api/v1/ai/runs/:id - Get AI run status
  fastify.get<{
    Params: { id: string };
  }>(
    "/api/v1/ai/runs/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: AiRunResponseSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await aiService.getRun(request.principal!, request.params.id);
      return reply.status(200).send(result);
    }
  );

  // POST /api/v1/ai/runs/:id/confirm - Confirm proposed actions
  fastify.post<{
    Params: { id: string };
    Body: AiRunConfirmRequest;
  }>(
    "/api/v1/ai/runs/:id/confirm",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: AiRunConfirmRequestSchema,
        response: {
          200: AiRunConfirmResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await aiService.confirmRun(
        request.principal!,
        request.params.id,
        request.body
      );
      return reply.status(200).send(result);
    }
  );

  // POST /api/v1/ai/runs/:id/cancel - Cancel AI run
  fastify.post<{
    Params: { id: string };
  }>(
    "/api/v1/ai/runs/:id/cancel",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: AiRunCancelResponseSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await aiService.cancelRun(request.principal!, request.params.id);
      return reply.status(200).send(result);
    }
  );

  // POST /api/v1/ai/runs/:id/retry - Retry failed run
  fastify.post<{
    Params: { id: string };
  }>(
    "/api/v1/ai/runs/:id/retry",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          202: AiRunRetryResponseSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await aiService.retryRun(request.principal!, request.params.id);
      return reply.status(202).send(result);
    }
  );

  // POST /api/v1/voice/runs - Queue voice processing run
  fastify.post<{
    Body: CreateVoiceRunRequest;
  }>(
    "/api/v1/voice/runs",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: CreateVoiceRunRequestSchema,
        response: {
          202: VoiceRunResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await aiService.createVoiceRun(request.principal!, request.body);
      return reply.status(202).send(result);
    }
  );

  // POST /api/v1/babies/:babyId/daily-summaries/runs - Queue daily summary run
  fastify.post<{
    Params: { babyId: string };
    Body: CreateDailySummaryRunRequest;
  }>(
    "/api/v1/babies/:babyId/daily-summaries/runs",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: CreateDailySummaryRunRequestSchema,
        response: {
          202: DailySummaryRunResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await aiService.createDailySummaryRun(
        request.principal!,
        request.params.babyId,
        request.body
      );
      return reply.status(202).send(result);
    }
  );

  // GET /api/v1/babies/:babyId/daily-summaries - List daily summaries
  fastify.get<{
    Params: { babyId: string };
    Querystring: PaginationQuery;
  }>(
    "/api/v1/babies/:babyId/daily-summaries",
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: PaginationQuerySchema,
        response: {
          200: DailySummaryListResponseSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await aiService.listDailySummaries(
        request.principal!,
        request.params.babyId,
        request.query
      );
      return reply.status(200).send(result);
    }
  );
};
