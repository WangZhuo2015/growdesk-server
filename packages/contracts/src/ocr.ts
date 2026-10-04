import { Type, type Static } from "@sinclair/typebox";
import { Nullable, UuidString, DateString, DecimalString } from "./common.js";

const ConfidenceSchema = Nullable(Type.Number({ minimum: 0, maximum: 1 }));

export const OcrTextEvidenceSchema = Type.Object({
  value: Nullable(Type.String({ maxLength: 4000 })),
  confidence: ConfidenceSchema,
  uncertainty: Type.String({ maxLength: 1000 }),
}, { additionalProperties: false });
export type OcrTextEvidence = Static<typeof OcrTextEvidenceSchema>;

export const OcrDateEvidenceSchema = Type.Object({
  value: Nullable(DateString),
  confidence: ConfidenceSchema,
  uncertainty: Type.String({ maxLength: 1000 }),
}, { additionalProperties: false });

export const OcrDecimalEvidenceSchema = Type.Object({
  value: Nullable(DecimalString),
  sourceValue: Nullable(Type.String({ maxLength: 200 })),
  sourceUnit: Nullable(Type.String({ maxLength: 40 })),
  confidence: ConfidenceSchema,
  uncertainty: Type.String({ maxLength: 1000 }),
}, { additionalProperties: false });

export const OcrValueEvidenceSchema = Type.Object({
  value: Type.Union([Type.String({ maxLength: 1000 }), Type.Number(), Type.Null()]),
  confidence: ConfidenceSchema,
  uncertainty: Type.String({ maxLength: 1000 }),
}, { additionalProperties: false });

export const MedicalOcrCategorySchema = Type.Union([
  Type.Literal("blood"),
  Type.Literal("growth"),
  Type.Literal("trace_element"),
  Type.Literal("allergy"),
  Type.Literal("general"),
]);
export type MedicalOcrCategory = Static<typeof MedicalOcrCategorySchema>;

export const MedicalOcrStatusSchema = Type.Union([
  Type.Literal("normal"),
  Type.Literal("high"),
  Type.Literal("low"),
  Type.Literal("abnormal"),
  Type.Literal("positive"),
  Type.Literal("negative"),
]);

export const MedicalOcrItemDraftSchema = Type.Object({
  name: OcrTextEvidenceSchema,
  value: OcrValueEvidenceSchema,
  unit: OcrTextEvidenceSchema,
  referenceRange: OcrTextEvidenceSchema,
  status: Type.Object({
    value: Nullable(MedicalOcrStatusSchema),
    confidence: ConfidenceSchema,
    uncertainty: Type.String({ maxLength: 1000 }),
  }, { additionalProperties: false }),
  interpretation: OcrTextEvidenceSchema,
}, { additionalProperties: false });
export type MedicalOcrItemDraft = Static<typeof MedicalOcrItemDraftSchema>;

export const MedicalOcrGrowthDraftSchema = Type.Object({
  weightKg: OcrDecimalEvidenceSchema,
  heightCm: OcrDecimalEvidenceSchema,
  headCircumferenceCm: OcrDecimalEvidenceSchema,
}, { additionalProperties: false });

export const MedicalOcrDraftSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  kind: Type.Literal("medical"),
  attachmentId: UuidString,
  modelSource: Type.String({ minLength: 1, maxLength: 128 }),
  sourceText: Type.String({ maxLength: 200000 }),
  title: OcrTextEvidenceSchema,
  category: Type.Object({
    value: Nullable(MedicalOcrCategorySchema),
    confidence: ConfidenceSchema,
    uncertainty: Type.String({ maxLength: 1000 }),
  }, { additionalProperties: false }),
  reportDate: OcrDateEvidenceSchema,
  hospital: OcrTextEvidenceSchema,
  department: OcrTextEvidenceSchema,
  doctorNotes: OcrTextEvidenceSchema,
  items: Type.Array(MedicalOcrItemDraftSchema, { maxItems: 500 }),
  growthData: Nullable(MedicalOcrGrowthDraftSchema),
}, { $id: "MedicalOcrDraft", additionalProperties: false });
export type MedicalOcrDraft = Static<typeof MedicalOcrDraftSchema>;

export const GrowthOcrDraftSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  kind: Type.Literal("growth"),
  attachmentId: UuidString,
  modelSource: Type.String({ minLength: 1, maxLength: 128 }),
  sourceText: Type.String({ maxLength: 200000 }),
  measurementDate: OcrDateEvidenceSchema,
  weightKg: OcrDecimalEvidenceSchema,
  heightCm: OcrDecimalEvidenceSchema,
  headCircumferenceCm: OcrDecimalEvidenceSchema,
}, { $id: "GrowthOcrDraft", additionalProperties: false });
export type GrowthOcrDraft = Static<typeof GrowthOcrDraftSchema>;

export const CreateGrowthOcrRunRequestSchema = Type.Object({
  babyId: UuidString,
  attachmentId: UuidString,
}, { $id: "CreateGrowthOcrRunRequest", additionalProperties: false });
export type CreateGrowthOcrRunRequest = Static<typeof CreateGrowthOcrRunRequestSchema>;

export const GrowthOcrRunResponseSchema = Type.Object({
  data: Type.Object({
    runId: UuidString,
    status: Type.Literal("queued"),
  }, { additionalProperties: false }),
}, { $id: "GrowthOcrRunResponse", additionalProperties: false });
export type GrowthOcrRunResponse = Static<typeof GrowthOcrRunResponseSchema>;
