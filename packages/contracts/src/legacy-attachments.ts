import { Type } from "@sinclair/typebox";
import { ApiErrorEnvelopeSchema, UuidString } from "./common.js";
import type { RouteDefinition } from "./routes.js";

export const LegacyAttachmentQuerySchema = Type.Object({
  path: Type.String({ minLength: 10, maxLength: 1024 }),
}, { additionalProperties: false });
export const LegacyAttachmentResponseSchema = Type.Object({
  data: Type.Object({ id: UuidString }, { additionalProperties: false }),
}, { additionalProperties: false });
export const LEGACY_ATTACHMENT_ROUTE_DEFINITIONS: RouteDefinition[] = [{
  method: "GET",
  path: "/api/v1/web/attachments/resolve-legacy",
  operationId: "resolveLegacyWebAttachment",
  summary: "Resolve a promoted legacy upload using current object-level authorization",
  tags: ["Attachments"],
  implementationStatus: "READY",
  querystring: LegacyAttachmentQuerySchema,
  responses: {
    200: LegacyAttachmentResponseSchema,
    400: ApiErrorEnvelopeSchema,
    401: ApiErrorEnvelopeSchema,
    403: ApiErrorEnvelopeSchema,
    404: ApiErrorEnvelopeSchema,
    503: ApiErrorEnvelopeSchema,
  },
}];
