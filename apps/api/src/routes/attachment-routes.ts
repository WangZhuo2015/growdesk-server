import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { Readable } from "node:stream";
import { AttachmentService } from "../services/attachment-service.js";
import {
  CreateAttachmentRequest,
  CompleteAttachmentRequest,
  CreateAttachmentRequestSchema,
  CompleteAttachmentRequestSchema,
  AttachmentResponseSchema,
  SuccessStatusResponseSchema,
  UploadUrlResponseSchema,
  DeleteAttachmentResponseSchema,
  ApiErrorEnvelopeSchema,
  IdParamSchema,
} from "@growdesk/contracts";

export interface AttachmentRoutesOptions {
  attachmentService: AttachmentService;
}

export const attachmentRoutes: FastifyPluginAsync<AttachmentRoutesOptions> = async (
  fastify: FastifyInstance,
  opts: AttachmentRoutesOptions
) => {
  const { attachmentService } = opts;
  const { LegacyAttachmentQuerySchema, LegacyAttachmentResponseSchema } = await import("@growdesk/contracts");
  const legacySchema = { operationId: "resolveLegacyWebAttachment", querystring: LegacyAttachmentQuerySchema,
    response: { 200: LegacyAttachmentResponseSchema, 400: ApiErrorEnvelopeSchema,
      401: ApiErrorEnvelopeSchema, 403: ApiErrorEnvelopeSchema, 404: ApiErrorEnvelopeSchema, 503: ApiErrorEnvelopeSchema } };
  fastify.get<{ Querystring: { path: string } }>("/api/v1/web/attachments/resolve-legacy", {
    preHandler: [fastify.authenticate], schema: legacySchema,
  }, async (request, reply) => {
    const data = await attachmentService.resolveLegacyUpload(request.principal!, request.query.path);
    return reply.header("cache-control", "private, no-store").send({ data });
  });

  // Content is always streamed through the authenticated API. The old
  // download-url endpoint intentionally no longer exists: returning a
  // signed read URL would let the object outlive this authorization check.
  fastify.get<{ Params: { id: string } }>(
    "/api/v1/attachments/:id/content",
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: IdParamSchema,
        response: {
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          503: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const content = await attachmentService.getContent(request.principal!, request.params.id);
      reply
        .header("content-type", content.mimeType)
        .header("content-length", String(content.contentLength ?? content.byteSize))
        .header("cache-control", "private, no-store")
        .header("x-content-type-options", "nosniff");
      return reply.send(Readable.from(content.body, { objectMode: false }));
    },
  );

  // POST /api/v1/attachments - Initialize upload
  fastify.post<{
    Body: CreateAttachmentRequest;
  }>(
    "/api/v1/attachments",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: CreateAttachmentRequestSchema,
        response: {
          201: AttachmentResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const result = await attachmentService.createAttachment(principal, request.body);
      return reply.status(201).send({ data: result });
    }
  );

  // POST /api/v1/attachments/:id/complete - Verify and finalize
  fastify.post<{
    Params: { id: string };
    Body: CompleteAttachmentRequest;
  }>(
    "/api/v1/attachments/:id/complete",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: CompleteAttachmentRequestSchema,
        response: {
          200: SuccessStatusResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const result = await attachmentService.completeAttachment(
        principal,
        request.params.id,
        request.body
      );
      return reply.status(200).send(result);
    }
  );

  // GET /api/v1/attachments/:id/upload-url - Renew upload URL
  fastify.get<{
    Params: { id: string };
  }>(
    "/api/v1/attachments/:id/upload-url",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: UploadUrlResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const result = await attachmentService.getUploadUrl(principal, request.params.id);
      return reply.status(200).send({ data: result });
    }
  );

  // DELETE /api/v1/attachments/:id - Delete attachment
  fastify.delete<{
    Params: { id: string };
  }>(
    "/api/v1/attachments/:id",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: DeleteAttachmentResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          403: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
          409: ApiErrorEnvelopeSchema,
          503: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const result = await attachmentService.deleteAttachment(principal, request.params.id);
      return reply.status(200).send(result);
    }
  );
};
