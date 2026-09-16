import { Type, type Static } from "@sinclair/typebox";
import { UuidString, Nullable, DateTimeString } from "./common.js";
import type { RouteDefinition } from "./routes.js";

const Role = Type.Union([Type.Literal("user"), Type.Literal("assistant"), Type.Literal("system")]);
export const WebAiMessageSchema = Type.Object({
  id: UuidString, sessionId: UuidString, role: Role, content: Type.String(),
  image: Nullable(Type.String()), toolsJson: Nullable(Type.String()), createdAt: DateTimeString,
}, { additionalProperties: false });
export type WebAiMessage = Static<typeof WebAiMessageSchema>;
export const WebAiSessionSchema = Type.Object({
  id: UuidString, userId: UuidString, babyId: Nullable(UuidString),
  title: Type.String(), contextType: Type.String(), createdAt: DateTimeString, updatedAt: DateTimeString,
  messages: Type.Array(WebAiMessageSchema), messageCount: Type.Integer({ minimum: 0 }),
  lastMessage: Nullable(WebAiMessageSchema),
}, { additionalProperties: false });
export type WebAiSession = Static<typeof WebAiSessionSchema>;
export const WebAiSessionBody = Type.Object({
  babyId: Type.Optional(Nullable(UuidString)), title: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  contextType: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
}, { additionalProperties: false });
export type WebAiSessionInput = Static<typeof WebAiSessionBody>;
export const WebAiMessageBody = Type.Object({
  id: UuidString, role: Role, content: Type.String({ maxLength: 200_000 }),
  image: Type.Optional(Nullable(Type.String({ maxLength: 8_000_000 }))),
  toolsJson: Type.Optional(Nullable(Type.String({ maxLength: 200_000 }))),
}, { additionalProperties: false });
export type WebAiMessageInput = Static<typeof WebAiMessageBody>;
export const WebAiListQuery = Type.Object({
  babyId: Type.Optional(UuidString), contextType: Type.Optional(Type.String({ maxLength: 50 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 30 })),
  offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 10000, default: 0 })),
}, { additionalProperties: false });
export type WebAiListOptions = Static<typeof WebAiListQuery>;
export const WebAiTitleBody = Type.Object({ title: Type.String({ minLength: 1, maxLength: 100 }) }, { additionalProperties: false });
const Id = Type.Object({ id: UuidString }, { additionalProperties: false });
const ErrorResponse = Type.Object({ error: Type.Object({ code: Type.String(), message: Type.String(), requestId: Type.String() }) });
const errors = { 400: ErrorResponse, 401: ErrorResponse, 403: ErrorResponse, 404: ErrorResponse, 409: ErrorResponse, 413: ErrorResponse, 503: ErrorResponse };
const sessionResponse = Type.Object({ data: WebAiSessionSchema }, { additionalProperties: false });
export const WEB_AI_ROUTE_DEFINITIONS: RouteDefinition[] = [
  { method: "POST", path: "/api/v1/web/ai/sessions", operationId: "createWebAiSession", summary: "Create a durable legacy Web conversation", tags: ["Web AI"], implementationStatus: "READY", body: WebAiSessionBody, responses: { 201: sessionResponse, ...errors } },
  { method: "GET", path: "/api/v1/web/ai/sessions", operationId: "listWebAiSessions", summary: "List authorized conversations with counts and last messages", tags: ["Web AI"], implementationStatus: "READY", querystring: WebAiListQuery, responses: { 200: Type.Object({ data: Type.Object({ total: Type.Integer(), sessions: Type.Array(WebAiSessionSchema) }) }), ...errors } },
  { method: "GET", path: "/api/v1/web/ai/sessions/:id", operationId: "getWebAiSession", summary: "Read complete authorized conversation history", tags: ["Web AI"], implementationStatus: "READY", params: Id, responses: { 200: sessionResponse, ...errors } },
  { method: "PATCH", path: "/api/v1/web/ai/sessions/:id", operationId: "renameWebAiSession", summary: "Persist a conversation title", tags: ["Web AI"], implementationStatus: "READY", params: Id, body: WebAiTitleBody, responses: { 200: sessionResponse, ...errors } },
  { method: "DELETE", path: "/api/v1/web/ai/sessions/:id", operationId: "deleteWebAiSession", summary: "Delete an inactive conversation and its messages", tags: ["Web AI"], implementationStatus: "READY", params: Id, responses: { 200: Type.Object({ data: Type.Object({ deleted: Type.Boolean() }) }), ...errors } },
  { method: "POST", path: "/api/v1/web/ai/sessions/:id/messages", operationId: "appendWebAiMessage", summary: "Idempotently append a message owned by the authenticated user", tags: ["Web AI"], implementationStatus: "READY", params: Id, body: WebAiMessageBody, responses: { 201: Type.Object({ data: WebAiMessageSchema }), ...errors } },
];
