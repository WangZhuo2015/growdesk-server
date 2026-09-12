import Fastify from "fastify";
import swagger from "@fastify/swagger";
import { Type, Static } from "@sinclair/typebox";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper for nullable schema compatible with OpenAPI 3.0.3
const Nullable = <T extends ReturnType<typeof Type.Any>>(schema: T) =>
  Type.Unsafe<Static<T> | null>({ ...schema, nullable: true });

// Standard Api Error Schema
export const ApiErrorEnvelopeSchema = Type.Object(
  {
    error: Type.Object({
      code: Type.String(),
      message: Type.String(),
      details: Type.Optional(Type.Unknown()),
      requestId: Type.String(),
    }),
  },
  { $id: "ApiErrorEnvelope", description: "Standard API Error Envelope" }
);

// Growth Record with Decimal as decimal string and ISO date-time
export const GrowthRecordSchema = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    babyId: Type.String(),
    familyId: Type.String(),
    heightCm: Type.String({ description: "Decimal string with precision 1, e.g. 75.5" }),
    weightKg: Type.String({ description: "Decimal string with precision 2, e.g. 9.45" }),
    headCircumferenceCm: Nullable(Type.String({ description: "Decimal string or null" })),
    recordedAt: Type.String({ format: "date-time" }),
    version: Type.String({ description: "Entity version as string" }),
  },
  { $id: "GrowthRecord", additionalProperties: false }
);

// Discriminated union example
export const FeedingEventSchema = Type.Object(
  {
    kind: Type.Literal("feeding"),
    id: Type.String(),
    volumeMl: Type.Number(),
  },
  { $id: "FeedingEvent", additionalProperties: false }
);

export const DiaperEventSchema = Type.Object(
  {
    kind: Type.Literal("diaper"),
    id: Type.String(),
    wet: Type.Boolean(),
    dirty: Type.Boolean(),
  },
  { $id: "DiaperEvent", additionalProperties: false }
);

export const SleepEventSchema = Type.Object(
  {
    kind: Type.Literal("sleep"),
    id: Type.String(),
    durationMinutes: Type.Number(),
  },
  { $id: "SleepEvent", additionalProperties: false }
);

export const TimelineEventSchema = Type.Union(
  [FeedingEventSchema, DiaperEventSchema, SleepEventSchema],
  {
    $id: "TimelineEvent",
    discriminator: { propertyName: "kind" },
    description: "Discriminated union of timeline events",
  }
);

export const NullableSampleSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    note: Nullable(Type.String()),
    tag: Type.Optional(Type.String()),
  },
  { $id: "NullableSample", additionalProperties: false }
);

/**
 * Centralized OpenAPI export transformer
 * Converts TypeBox anyOf unions with discriminator into OpenAPI 3.0.3 oneOf with $refs,
 * ensuring clean Swift enum generation in Swift OpenAPI Generator.
 */
export function transformOpenApi(spec: any): any {
  const transformed = JSON.parse(JSON.stringify(spec));
  const schemas = transformed.components?.schemas || {};

  // Build mapping from discriminator value (e.g. kind: "feeding") to schema name (e.g. "FeedingEvent")
  const discriminatorMap: Record<string, string> = {};
  for (const [name, schema] of Object.entries<any>(schemas)) {
    if (schema.type === "object" && schema.properties?.kind?.enum?.[0]) {
      discriminatorMap[schema.properties.kind.enum[0]] = name;
    }
  }

  function transformNode(node: any) {
    if (!node || typeof node !== "object") return;

    if (node.discriminator && Array.isArray(node.anyOf)) {
      const mapping: Record<string, string> = {};
      node.oneOf = node.anyOf.map((subSchema: any) => {
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

    for (const key of Object.keys(node)) {
      transformNode(node[key]);
    }
  }

  transformNode(transformed);
  return transformed;
}

export async function buildFastifyApp() {
  const app = Fastify({
    logger: false,
    ajv: {
      customOptions: {
        keywords: ["discriminator"],
      },
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(swagger, {
    openapi: {
      openapi: "3.0.3",
      info: {
        title: "GrowDesk API BOOT-01 Scratch Spec",
        version: "0.1.0",
        description: "OpenAPI 3.0.3 export test for Swift OpenAPI Generator compatibility",
      },
      servers: [
        {
          url: "http://127.0.0.1:3000/api/v1",
          description: "Local test server",
        },
      ],
    },
    refResolver: {
      buildLocalReference(json, _baseUri, _fragment, i) {
        return json.$id || (json.title as string) || `def-${i}`;
      },
    },
  });

  app.addSchema(ApiErrorEnvelopeSchema);
  app.addSchema(GrowthRecordSchema);
  app.addSchema(FeedingEventSchema);
  app.addSchema(DiaperEventSchema);
  app.addSchema(SleepEventSchema);
  app.addSchema(TimelineEventSchema);
  app.addSchema(NullableSampleSchema);

  // Route 1: Growth Record GET
  app.get(
    "/sample/growth/:id",
    {
      schema: {
        operationId: "getGrowthRecord",
        params: Type.Object({
          id: Type.String({ format: "uuid" }),
        }),
        response: {
          200: Type.Object({ data: Type.Ref(GrowthRecordSchema) }),
          404: Type.Ref(ApiErrorEnvelopeSchema),
          409: Type.Ref(ApiErrorEnvelopeSchema),
        },
      },
    },
    async (request, reply) => {
      return reply.send({
        data: {
          id: request.params.id,
          babyId: "test_baby_01",
          familyId: "test_family_01",
          heightCm: "76.2",
          weightKg: "9.85",
          headCircumferenceCm: null,
          recordedAt: new Date().toISOString(),
          version: "1",
        },
      });
    }
  );

  // Route 2: Timeline event creation with discriminated union
  app.post(
    "/sample/timeline",
    {
      schema: {
        operationId: "createTimelineEvent",
        body: Type.Ref(TimelineEventSchema),
        response: {
          200: Type.Object({ data: Type.Ref(TimelineEventSchema) }),
          400: Type.Ref(ApiErrorEnvelopeSchema),
        },
      },
    },
    async (request, reply) => {
      return reply.send({
        data: request.body,
      });
    }
  );

  // Route 3: Nullable & absent test
  app.get(
    "/sample/nullable",
    {
      schema: {
        operationId: "getNullableSample",
        response: {
          200: Type.Object({ data: Type.Ref(NullableSampleSchema) }),
        },
      },
    },
    async (_request, reply) => {
      return reply.send({
        data: {
          id: "sample-1",
          name: "Sample Item",
          note: null,
        },
      });
    }
  );

  // Register standard error handler to format validation & runtime errors matching ApiErrorEnvelope
  app.setErrorHandler((error, request, reply) => {
    const requestId =
      (request.headers["x-request-id"] as string) ||
      (request.id as string) ||
      "req_test_sample_01";

    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: "VALIDATION_FAILED",
          message: error.message,
          details: error.validation,
          requestId,
        },
      });
    }

    const statusCode = error.statusCode || 500;
    return reply.status(statusCode).send({
      error: {
        code: error.code || "INTERNAL_SERVER_ERROR",
        message: error.message,
        requestId,
      },
    });
  });

  await app.ready();
  return app;
}

async function main() {
  console.log("Initializing Fastify 5 with TypeBox and Swagger...");
  const app = await buildFastifyApp();
  const rawSpec = app.swagger();
  const openapiSpec = transformOpenApi(rawSpec);
  const outputPath = path.resolve(__dirname, "openapi.json");
  await fs.writeFile(outputPath, JSON.stringify(openapiSpec, null, 2), "utf-8");

  console.log(`Successfully exported OpenAPI 3.0.3 spec to: ${outputPath}`);
  console.log(`OpenAPI version: ${openapiSpec.openapi}`);
  console.log(`Endpoints defined: ${Object.keys(openapiSpec.paths || {}).join(", ")}`);

  // Simple smoke check on schema contents
  if (openapiSpec.openapi !== "3.0.3") {
    throw new Error(`Expected OpenAPI 3.0.3 but got ${openapiSpec.openapi}`);
  }
  const paths = openapiSpec.paths || {};
  if (!paths["/sample/growth/{id}"] || !paths["/sample/timeline"] || !paths["/sample/nullable"]) {
    throw new Error("Missing expected routes in generated OpenAPI spec");
  }

  // Automated inject tests to verify 200 and 400 serialization behavior
  console.log("Testing app.inject for valid POST /sample/timeline...");
  const validRes = await app.inject({
    method: "POST",
    url: "/sample/timeline",
    payload: {
      kind: "feeding",
      id: "feed_01",
      volumeMl: 150,
    },
  });
  if (validRes.statusCode !== 200) {
    throw new Error(`Expected 200 for valid timeline payload but got ${validRes.statusCode}: ${validRes.body}`);
  }
  console.log("Valid POST /sample/timeline response: 200 OK");

  console.log("Testing app.inject for invalid payload POST /sample/timeline (P2 fix verification)...");
  const invalidRes = await app.inject({
    method: "POST",
    url: "/sample/timeline",
    headers: {
      "x-request-id": "req_sample_test_01",
    },
    payload: {
      kind: "bogus",
      id: "test_event",
    },
  });
  if (invalidRes.statusCode !== 400) {
    throw new Error(`Expected 400 for invalid timeline payload but got ${invalidRes.statusCode}: ${invalidRes.body}`);
  }
  const errorBody = invalidRes.json();
  if (
    !errorBody.error ||
    errorBody.error.code !== "VALIDATION_FAILED" ||
    typeof errorBody.error.message !== "string" ||
    errorBody.error.requestId !== "req_sample_test_01" ||
    !Array.isArray(errorBody.error.details) ||
    errorBody.error.details.length === 0
  ) {
    throw new Error(`Invalid error envelope format in 400 response: ${invalidRes.body}`);
  }
  console.log("Invalid POST /sample/timeline returned 400 with matching ApiErrorEnvelope:", JSON.stringify(errorBody));

  console.log("Fastify 5 + TypeBox + Swagger export & injection check: ALL PASSED");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Swagger export failed:", err);
    process.exit(1);
  });
}
