import { Type, type Static } from "@sinclair/typebox";
import {
  Nullable,
  DateTimeString,
  DateString,
  DecimalString,
  BigIntString,
  UuidString,
  PaginatedEnvelope,
} from "./common.js";

/**
 * GrowthRecordSchema compatible with Swift OpenAPI generator check.
 */
export const GrowthRecordSchema = Type.Object(
  {
    id: UuidString,
    babyId: Type.String(),
    familyId: Type.String(),
    heightCm: Type.String({ description: "Decimal string with precision 1, e.g. 75.5" }),
    weightKg: Type.String({ description: "Decimal string with precision 2, e.g. 9.40" }),
    headCircumferenceCm: Nullable(Type.String({ description: "Decimal string or null" })),
    recordedAt: DateTimeString,
    version: Type.String({ description: "Entity version as string" }),
  },
  { $id: "GrowthRecord", additionalProperties: false }
);

export type GrowthRecord = Static<typeof GrowthRecordSchema>;

export const GrowthMeasurementSchema = Type.Object(
  {
    id: UuidString,
    babyId: UuidString,
    familyId: UuidString,
    measurementDate: DateString,
    weightKg: Nullable(DecimalString),
    heightCm: Nullable(DecimalString),
    headCircumferenceCm: Nullable(DecimalString),
    attachmentId: Nullable(Type.String()),
    notes: Nullable(Type.String({ maxLength: 1000 })),
    version: BigIntString,
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
    // Read-only fields promoted from imported legacy growth rows.  This is a
    // deliberately small whitelist; the source JSONB metadata is never part
    // of the public growth response.
    legacyDate: Type.Optional(Nullable(DateString)),
    legacyAgeInMonths: Type.Optional(Nullable(Type.Integer({ minimum: 0 }))),
    legacyAgeLabel: Type.Optional(Nullable(Type.String())),
    legacyPercentile: Type.Optional(Nullable(Type.Integer({ minimum: 0, maximum: 100 }))),
    legacyClientId: Type.Optional(Nullable(Type.String())),
    legacyRecordedById: Type.Optional(Nullable(Type.String())),
    legacySource: Type.Optional(Nullable(Type.String())),
    legacySourceAgent: Type.Optional(Nullable(Type.String())),
  },
  { $id: "GrowthMeasurement", additionalProperties: false }
);

export type GrowthMeasurement = Static<typeof GrowthMeasurementSchema>;

export const CreateGrowthMeasurementRequestSchema = Type.Object(
  {
    measurementDate: DateString,
    weightKg: Type.Optional(Nullable(DecimalString)),
    heightCm: Type.Optional(Nullable(DecimalString)),
    headCircumferenceCm: Type.Optional(Nullable(DecimalString)),
    attachmentId: Type.Optional(Nullable(Type.String())),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  },
  { $id: "CreateGrowthMeasurementRequest", additionalProperties: false }
);

export type CreateGrowthMeasurementRequest = Static<typeof CreateGrowthMeasurementRequestSchema>;

export const UpdateGrowthMeasurementRequestSchema = Type.Object(
  {
    baseVersion: BigIntString,
    measurementDate: Type.Optional(DateString),
    weightKg: Type.Optional(Nullable(DecimalString)),
    heightCm: Type.Optional(Nullable(DecimalString)),
    headCircumferenceCm: Type.Optional(Nullable(DecimalString)),
    attachmentId: Type.Optional(Nullable(Type.String())),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  },
  { $id: "UpdateGrowthMeasurementRequest", additionalProperties: false }
);

export type UpdateGrowthMeasurementRequest = Static<typeof UpdateGrowthMeasurementRequestSchema>;

export const GrowthMeasurementResponseSchema = Type.Object(
  {
    data: GrowthMeasurementSchema,
  },
  { $id: "GrowthMeasurementResponse", additionalProperties: false }
);

export type GrowthMeasurementResponse = Static<typeof GrowthMeasurementResponseSchema>;

export const GrowthMeasurementListResponseSchema = PaginatedEnvelope(GrowthMeasurementSchema, {
  $id: "GrowthMeasurementListResponse",
});

export type GrowthMeasurementListResponse = Static<typeof GrowthMeasurementListResponseSchema>;

export const WhoPercentilePointSchema = Type.Object(
  {
    monthAge: Type.Number(),
    p3: DecimalString,
    p15: DecimalString,
    p50: DecimalString,
    p85: DecimalString,
    p97: DecimalString,
  },
  { additionalProperties: false }
);

export const GrowthChartResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        measurements: Type.Array(GrowthMeasurementSchema),
        whoPercentiles: Type.Object(
          {
            weightForAge: Type.Array(WhoPercentilePointSchema),
            heightForAge: Type.Array(WhoPercentilePointSchema),
            headCircumferenceForAge: Type.Array(WhoPercentilePointSchema),
          },
          { additionalProperties: false }
        ),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "GrowthChartResponse", additionalProperties: false }
);

export type GrowthChartResponse = Static<typeof GrowthChartResponseSchema>;
