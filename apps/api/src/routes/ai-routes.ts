import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { AiService } from "../services/ai-service.js";
import { BadRequestError } from "@growdesk/database";
import { once } from "node:events";
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
  AiRunEventsQuery,
  AiRunEventsQuerySchema,
} from "@growdesk/contracts";

export interface AiRoutesOptions {
  aiService: AiService;
}

function parseEventCursor(value: string | undefined): bigint | null {
  if (value === undefined || value.trim() === "") return null;
  if (!/^\d+$/.test(value.trim())) {
    throw new BadRequestError("SSE event cursor must be a non-negative integer", "INVALID_EVENT_CURSOR");
  }
  try {
    return BigInt(value.trim());
  } catch {
    throw new BadRequestError("SSE event cursor is outside the supported range", "INVALID_EVENT_CURSOR");
  }
}

async function writeSseFrame(raw: NodeJS.WritableStream & { writableEnded?: boolean; writableLength?: number; destroyed?: boolean }, frame: string): Promise<boolean> {
  if (raw.writableEnded || raw.destroyed) return false;
  if ((raw.writableLength ?? 0) > 64 * 1024) {
    if (typeof (raw as unknown as { destroy?: () => void }).destroy === "function") (raw as unknown as { destroy: () => void }).destroy();
    return false;
  }
  const accepted = raw.write(frame);
  if (!accepted) {
    try {
      await once(raw, "drain");
    } catch {
      return false;
    }
  }
  return !(raw.writableEnded || raw.destroyed);
}

function sseFrame(event: { seq: string; type: string; payload: Record<string, unknown>; runId: string; attempt: number }): string {
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
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
          503: ApiErrorEnvelopeSchema,
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

  // GET /api/v1/ai/runs/:id/events - Replay durable AI events over SSE
  fastify.get<{
    Params: { id: string };
    Querystring: AiRunEventsQuery;
  }>(
    "/api/v1/ai/runs/:id/events",
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: AiRunEventsQuerySchema,
        response: {
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const queryCursor = parseEventCursor(request.query.after);
      const headerValue = request.headers["last-event-id"];
      const headerCursor = parseEventCursor(Array.isArray(headerValue) ? headerValue[0] : headerValue);
      if (queryCursor !== null && headerCursor !== null && queryCursor !== headerCursor) {
        throw new BadRequestError("after and Last-Event-ID must identify the same cursor", "EVENT_CURSOR_CONFLICT");
      }
      let cursor = headerCursor ?? queryCursor ?? 0n;
      let open = true;
      const raw = reply.raw;
      const close = (): void => {
        open = false;
      };
      request.raw.once("close", close);
      reply.hijack();
      raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });

      let lastHeartbeat = Date.now();
      try {
        while (open && !raw.writableEnded && !raw.destroyed) {
          const batch = await aiService.listRunEvents(request.principal!, request.params.id, cursor, 100);
          for (const event of batch.events) {
            if (!await writeSseFrame(raw, sseFrame(event))) {
              open = false;
              break;
            }
            cursor = BigInt(event.seq);
          }
          if (!open || batch.terminal) break;
          const now = Date.now();
          if (now - lastHeartbeat >= 15_000) {
            if (!await writeSseFrame(raw, ": heartbeat\n\n")) {
              open = false;
              break;
            }
            lastHeartbeat = now;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      } finally {
        request.raw.off("close", close);
        if (!raw.writableEnded && !raw.destroyed) raw.end();
      }
    },
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
