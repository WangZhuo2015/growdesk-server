import Fastify from "fastify";
import swagger from "@fastify/swagger";
import * as contracts from "@growdesk/contracts";

export function transformOpenApi(spec) {
  const transformed = JSON.parse(JSON.stringify(spec));
  const schemas = transformed.components?.schemas || {};

  // Build mapping from discriminator value (e.g. kind: "feeding") to schema name (e.g. "FeedingEvent")
  const discriminatorMap = {};
  for (const [name, schema] of Object.entries(schemas)) {
    if (schema.type === "object" && schema.properties?.kind?.enum?.[0]) {
      discriminatorMap[schema.properties.kind.enum[0]] = name;
    }
  }

  function transformNode(node) {
    if (!node || typeof node !== "object") return;

    if (node.discriminator && Array.isArray(node.anyOf)) {
      const mapping = {};
      node.oneOf = node.anyOf.map((subSchema) => {
        const kindValue = subSchema.properties?.kind?.enum?.[0];
        const targetSchemaName = kindValue ? discriminatorMap[kindValue] : null;
        if (targetSchemaName) {
          const ref = `#/components/schemas/${targetSchemaName}`;
          if (kindValue) {
            mapping[kindValue] = ref;
          }
          return { $ref: ref };
        }
        return subSchema;
      });
      if (Object.keys(mapping).length > 0) {
        node.discriminator.mapping = mapping;
      }
      delete node.anyOf;
    }

    if (Array.isArray(node.anyOf) && node.anyOf.some((s) => s && s.type === "null")) {
      const nonNullVariants = node.anyOf.filter((s) => s && s.type !== "null");
      delete node.anyOf;
      if (nonNullVariants.length === 1) {
        Object.assign(node, nonNullVariants[0], { nullable: true });
      } else {
        node.anyOf = nonNullVariants;
        node.nullable = true;
      }
    }

    for (const key of Object.keys(node)) {
      transformNode(node[key]);
    }
  }

  transformNode(transformed);
  return transformed;
}

export async function buildContractApp() {
  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: {
        keywords: ["discriminator"],
      },
    },
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "GrowDesk API",
        version: "0.1.0",
        description: "Canonical GrowDesk Backend & Web BFF Shared Contract",
      },
      servers: [
        {
          url: "https://ampere.zwang.fun:8443",
          description: "Cloud Staging / Production Backend",
        },
        {
          url: "http://127.0.0.1:3000",
          description: "Local Development Server",
        },
      ],
    },
    refResolver: {
      buildLocalReference(json, _baseUri, _fragment, i) {
        return json.$id || json.title || `def-${i}`;
      },
    },
  });

  // Register shared schemas as components
  const sharedSchemas = [
    contracts.ApiErrorEnvelopeSchema,
    contracts.UserProfileSchema,
    contracts.SessionSummarySchema,
    contracts.FamilySchema,
    contracts.FamilyMemberSchema,
    contracts.BabySchema,
    contracts.BabyMemberSchema,
    contracts.FeedingRecordSchema,
    contracts.SleepRecordSchema,
    contracts.DiaperRecordSchema,
    contracts.FoodRecordSchema,
    contracts.SupplementRecordSchema,
    contracts.TimelineEntrySchema,
    contracts.GrowthMeasurementSchema,
    contracts.GrowthRecordSchema,
    contracts.FeedingEventSchema,
    contracts.DiaperEventSchema,
    contracts.SleepEventSchema,
    contracts.TimelineEventSchema,
    contracts.MedicalReportSchema,
    contracts.VaccineScheduleItemSchema,
    contracts.VaccineRecordSchema,
    contracts.VaccineCatalogItemSchema,
    contracts.VaccineCatalogResponseSchema,
    contracts.VoiceLogBabySchema,
    contracts.VoiceLogSchema,
    contracts.CreateVoiceLogRequestSchema,
    contracts.VoiceLogResponseSchema,
    contracts.VoiceLogListResponseSchema,
    contracts.VoiceLogUnreadResponseSchema,
    contracts.VoiceLogQueryResponseSchema,
    contracts.VoiceLogListQuerySchema,
    contracts.AcknowledgeVoiceLogRequestSchema,
    contracts.RecordSnapshotSchema,
    contracts.AiSessionSchema,
    contracts.AiMessageSchema,
    contracts.AiRunSchema,
    contracts.SyncCommandSchema,
    contracts.SyncCommandResultItemSchema,
    contracts.SyncChangeItemSchema,
    contracts.SyncSnapshotSchema,
    contracts.AttachmentSchema,
    contracts.NotificationItemSchema,
    contracts.FormulaProductSchema,
    contracts.FoodLibraryItemSchema,
    contracts.FoodGuidelineItemSchema,
    contracts.FoodPlanSchema,
    contracts.DevelopmentMilestoneSchema,
    contracts.ActivityRecommendationSchema,
    contracts.WarningSignSchema,
    contracts.BookSchema,
    contracts.AppConfigSchema,
    contracts.OAuthServerMetadataSchema,
    contracts.OAuthProtectedResourceMetadataSchema,
    contracts.McpRpcRequestSchema,
    contracts.McpRpcResponseSchema,
  ];

  for (const schema of sharedSchemas) {
    if (schema && schema.$id) {
      app.addSchema(schema);
    }
  }

  // Register routes
  for (const route of contracts.ROUTE_DEFINITIONS) {
    const fastifyPath = route.path;

    const response = Object.fromEntries(
      Object.entries(route.responses).map(([status, responseSchema]) => {
        const mediaTypes = route.responseContentTypes?.[Number(status)];
        if (!mediaTypes) return [status, responseSchema];
        if (mediaTypes.length === 0 || mediaTypes.some((mediaType) => typeof mediaType !== "string" || mediaType.length === 0)) {
          throw new Error(`Route ${route.operationId} has invalid response content types for ${status}`);
        }
        return [status, {
          ...(typeof responseSchema.description === "string" ? { description: responseSchema.description } : {}),
          content: Object.fromEntries(mediaTypes.map((mediaType) => [mediaType, { schema: responseSchema }])),
        }];
      }),
    );

    const schema = {
      operationId: route.operationId,
      summary: route.summary,
      tags: route.tags,
      response,
      "x-implementation-status": route.implementationStatus,
    };

    if (route.body) schema.body = route.body;
    if (route.params) schema.params = route.params;
    if (route.querystring) schema.querystring = route.querystring;
    if (route.headers) schema.headers = route.headers;

    app.route({
      method: route.method,
      url: fastifyPath,
      schema,
      handler: async (_request, reply) => {
        return reply.status(501).send({ error: { code: "NOT_IMPLEMENTED", message: "Placeholder contract route" } });
      },
    });
  }

  await app.ready();
  return app;
}

export async function generateCanonicalOpenApi() {
  const app = await buildContractApp();
  const rawSpec = app.swagger();
  const spec = transformOpenApi(rawSpec);

  // Validate operationId uniqueness and OpenAPI version
  if (spec.openapi !== "3.0.3") {
    throw new Error(`Invalid OpenAPI version: expected 3.0.3, got ${spec.openapi}`);
  }

  const operationIds = new Set();
  const duplicateOperationIds = [];

  for (const [pathKey, pathItem] of Object.entries(spec.paths || {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!operation || typeof operation !== "object") continue;
      if (["get", "post", "put", "patch", "delete", "options", "head"].includes(method)) {
        const opId = operation.operationId;
        if (!opId) {
          throw new Error(`Missing operationId on route [${method.toUpperCase()}] ${pathKey}`);
        }
        if (operationIds.has(opId)) {
          duplicateOperationIds.push(opId);
        }
        operationIds.add(opId);
      }
    }
  }

  if (duplicateOperationIds.length > 0) {
    throw new Error(`Duplicate operationIds found in spec: ${duplicateOperationIds.join(", ")}`);
  }

  return spec;
}
