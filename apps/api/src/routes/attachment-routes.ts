import { FastifyInstance, FastifyPluginAsync } from "fastify";
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
} from "@growdesk/contracts";

export interface AttachmentRoutesOptions {
  attachmentService: AttachmentService;
}

export const attachmentRoutes: FastifyPluginAsync<AttachmentRoutesOptions> = async (
  fastify: FastifyInstance,
  opts: AttachmentRoutesOptions
) => {
  const { attachmentService } = opts;

  fastify.get<{ Params: { id: string } }>("/api/v1/attachments/:id/download-url", { preHandler: [fastify.authenticate] }, async request => ({
    data: await attachmentService.getDownloadUrl(request.principal!, request.params.id),
  }));

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
