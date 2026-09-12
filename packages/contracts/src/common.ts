import { Type, FormatRegistry, type TSchema, type Static } from "@sinclair/typebox";

// Register standard formats for standalone Value.Check validation
FormatRegistry.Set("date-time", (value) => typeof value === "string" && !isNaN(Date.parse(value)));
FormatRegistry.Set("date", (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value));
FormatRegistry.Set("uuid", (value) => typeof value === "string" && /^[0-9a-fA-F-]{36}$/.test(value));

/**
 * Helper for nullable schemas compatible with OpenAPI 3.0.3 and Swift OpenAPI Generator.
 */
export const Nullable = <T extends TSchema>(schema: T) =>
  Type.Union([schema, Type.Null()]);

/**
 * Standard API error envelope adhering to 02_BACKEND_CONTRACTS.md specification.
 */
export const ApiErrorEnvelopeSchema = Type.Object(
  {
    error: Type.Object(
      {
        code: Type.String({ description: "Machine-readable error code" }),
        message: Type.String({ description: "Human-readable error description" }),
        details: Type.Optional(Type.Unknown({ description: "Structured error details" })),
        requestId: Type.String({ description: "Unique request tracing identifier" }),
      },
      { additionalProperties: false }
    ),
  },
  {
    $id: "ApiErrorEnvelope",
    description: "Standard API Error Envelope",
    additionalProperties: false,
  }
);

export type ApiErrorEnvelope = Static<typeof ApiErrorEnvelopeSchema>;

/**
 * Generic success envelope: { data: T }
 */
export const SuccessEnvelope = <T extends TSchema>(dataSchema: T, options?: { $id?: string; description?: string }) =>
  Type.Object(
    {
      data: dataSchema,
    },
    {
      ...options,
      additionalProperties: false,
    }
  );

/**
 * Generic keyset paginated envelope: { data: T[], page: { nextCursor: string | null } }
 */
export const PaginatedEnvelope = <T extends TSchema>(itemSchema: T, options?: { $id?: string; description?: string }) =>
  Type.Object(
    {
      data: Type.Array(itemSchema),
      page: Type.Object(
        {
          nextCursor: Nullable(Type.String({ description: "Keyset opaque pagination cursor" })),
        },
        { additionalProperties: false }
      ),
    },
    {
      ...options,
      additionalProperties: false,
    }
  );

/**
 * Common string formats ensuring precision across JS/Swift/PostgreSQL.
 */
export const UuidString = Type.String({ format: "uuid", description: "UUID v4 string" });
export const DateString = Type.String({ format: "date", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "YYYY-MM-DD calendar date" });
export const DateTimeString = Type.String({ format: "date-time", description: "RFC3339 UTC timestamp" });
export const DecimalString = Type.String({ pattern: "^-?\\d+(\\.\\d+)?$", description: "Arbitrary-precision decimal represented as string" });
export const BigIntString = Type.String({ pattern: "^\\d+$", description: "64-bit integer represented as string" });

export const PaginationQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ description: "Keyset cursor to fetch next page" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50, description: "Page size" })),
  },
  { $id: "PaginationQuery", additionalProperties: false }
);

export type PaginationQuery = Static<typeof PaginationQuerySchema>;

export const SuccessStatusResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        success: Type.Literal(true),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "SuccessStatusResponse", additionalProperties: false }
);

export type SuccessStatusResponse = Static<typeof SuccessStatusResponseSchema>;

export const IdParamSchema = Type.Object(
  { id: UuidString },
  { additionalProperties: false }
);

export const IdParam = IdParamSchema;
export type IdParam = Static<typeof IdParamSchema>;

export const FamilyAndMemberParamSchema = Type.Object(
  { id: UuidString, userId: UuidString },
  { additionalProperties: false }
);

export const FamilyAndMemberParam = FamilyAndMemberParamSchema;
export type FamilyAndMemberParam = Static<typeof FamilyAndMemberParamSchema>;

