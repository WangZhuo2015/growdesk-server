import type { FastifyPluginAsync } from "fastify";
import type pg from "pg";
import { WEB_AI_ROUTE_DEFINITIONS, type WebAiSessionInput, type WebAiMessageInput, type WebAiListOptions } from "@growdesk/contracts";
import { WebAiSessionService } from "../services/web-ai-session-service.js";

function schema(operationId: string) {
  const route = WEB_AI_ROUTE_DEFINITIONS.find(item => item.operationId === operationId)!;
  return { operationId, body: route.body, params: route.params, querystring: route.querystring, response: route.responses };
}
export const webAiRoutes: FastifyPluginAsync<{ pool: pg.Pool }> = async (app, { pool }) => {
  const service = new WebAiSessionService(pool);
  app.post<{ Body: WebAiSessionInput }>("/api/v1/web/ai/sessions", {
    preHandler: [app.authenticate], schema: schema("createWebAiSession"),
  }, async (request, reply) => reply.code(201).send({ data: await service.create(request.principal!.userId, request.body) }));
  app.get<{ Querystring: WebAiListOptions }>("/api/v1/web/ai/sessions", {
    preHandler: [app.authenticate], schema: schema("listWebAiSessions"),
  }, async request => ({ data: await service.list(request.principal!.userId, request.query) }));
  app.get<{ Params: { id: string } }>("/api/v1/web/ai/sessions/:id", {
    preHandler: [app.authenticate], schema: schema("getWebAiSession"),
  }, async request => ({ data: await service.get(request.principal!.userId, request.params.id) }));
  app.patch<{ Params: { id: string }; Body: { title: string } }>("/api/v1/web/ai/sessions/:id", {
    preHandler: [app.authenticate], schema: schema("renameWebAiSession"),
  }, async request => ({ data: await service.rename(request.principal!.userId, request.params.id, request.body.title) }));
  app.delete<{ Params: { id: string } }>("/api/v1/web/ai/sessions/:id", {
    preHandler: [app.authenticate], schema: schema("deleteWebAiSession"),
  }, async request => ({ data: await service.remove(request.principal!.userId, request.params.id) }));
  app.post<{ Params: { id: string }; Body: WebAiMessageInput }>("/api/v1/web/ai/sessions/:id/messages", {
    preHandler: [app.authenticate], bodyLimit: 9_000_000, schema: schema("appendWebAiMessage"),
  }, async (request, reply) => reply.code(201).send({ data: await service.append(request.principal!.userId, request.params.id, request.body) }));
};
