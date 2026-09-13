import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { NotificationService } from "../services/notification-service.js";
import {
  RegisterPushDeviceRequest,
  RegisterPushDeviceRequestSchema,
  SuccessStatusResponseSchema,
  UnregisterPushDeviceResponseSchema,
  NotificationListResponseSchema,
  MarkNotificationReadResponseSchema,
  ApiErrorEnvelopeSchema,
} from "@growdesk/contracts";

export interface NotificationRoutesOptions {
  notificationService: NotificationService;
}

export const notificationRoutes: FastifyPluginAsync<NotificationRoutesOptions> = async (
  fastify: FastifyInstance,
  opts: NotificationRoutesOptions
) => {
  const { notificationService } = opts;

  // PUT /api/v1/devices/:installationId/push - Register push device
  fastify.put<{
    Params: { installationId: string };
    Body: RegisterPushDeviceRequest;
  }>(
    "/api/v1/devices/:installationId/push",
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: RegisterPushDeviceRequestSchema,
        response: {
          200: SuccessStatusResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const result = await notificationService.registerPushDevice(
        principal,
        request.params.installationId,
        request.body
      );
      return reply.status(200).send(result);
    }
  );

  // DELETE /api/v1/devices/:installationId/push - Unregister push device
  fastify.delete<{
    Params: { installationId: string };
  }>(
    "/api/v1/devices/:installationId/push",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: UnregisterPushDeviceResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const result = await notificationService.unregisterPushDevice(
        principal,
        request.params.installationId
      );
      return reply.status(200).send(result);
    }
  );

  // GET /api/v1/notifications - List notifications
  fastify.get<{
    Querystring: { limit?: number; cursor?: string };
  }>(
    "/api/v1/notifications",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: NotificationListResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const result = await notificationService.listNotifications(principal, request.query);
      return reply.status(200).send(result);
    }
  );

  // POST /api/v1/notifications/:id/read - Mark notification as read
  fastify.post<{
    Params: { id: string };
  }>(
    "/api/v1/notifications/:id/read",
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: MarkNotificationReadResponseSchema,
          400: ApiErrorEnvelopeSchema,
          401: ApiErrorEnvelopeSchema,
          404: ApiErrorEnvelopeSchema,
        },
      },
    },
    async (request, reply) => {
      const principal = request.principal!;
      const result = await notificationService.markNotificationAsRead(principal, request.params.id);
      return reply.status(200).send(result);
    }
  );
};
