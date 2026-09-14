import { Type, type Static } from "@sinclair/typebox";
import {
  Nullable,
  DecimalString,
  DateTimeString,
  DateString,
  BigIntString,
  UuidString,
  PaginatedEnvelope,
} from "./common.js";

// ==========================================
// 1. Medical Reports
// ==========================================

export const MedicalReportItemSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 100 }),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  value: Type.Union([Type.String({ maxLength: 1000 }), Type.Number()]),
  unit: Type.Optional(Type.String({ maxLength: 100 })),
  referenceRange: Type.Optional(Type.String({ maxLength: 500 })),
  status: Type.Union(["normal", "high", "low", "abnormal", "positive", "negative"].map(value => Type.Literal(value))),
  interpretation: Type.Optional(Type.String({ maxLength: 2000 })),
}, { additionalProperties: false });

export const MedicalReportSchema = Type.Object(
  {
    id: UuidString,
    babyId: UuidString,
    familyId: UuidString,
    items: Type.Optional(Type.Array(MedicalReportItemSchema, { maxItems: 500 })),
    reportDate: DateString,
    title: Type.String({ minLength: 1, maxLength: 100 }),
    hospital: Nullable(Type.String({ maxLength: 100 })),
    department: Nullable(Type.String({ maxLength: 100 })),
    diagnosis: Nullable(Type.String({ maxLength: 500 })),
    attachmentIds: Type.Array(Type.String()),
    notes: Nullable(Type.String({ maxLength: 2000 })),
    version: BigIntString,
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "MedicalReport", additionalProperties: false }
);

export type MedicalReport = Static<typeof MedicalReportSchema>;

export const CreateMedicalReportRequestSchema = Type.Object(
  {
    items: Type.Optional(Type.Array(MedicalReportItemSchema, { maxItems: 500 })),
    growthData: Type.Optional(Type.Object({
      weightKg: Type.Optional(DecimalString), heightCm: Type.Optional(DecimalString), headCircumferenceCm: Type.Optional(DecimalString),
    }, { additionalProperties: false, minProperties: 1 })),
    reportDate: DateString,
    title: Type.String({ minLength: 1, maxLength: 100 }),
    hospital: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
    department: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
    diagnosis: Type.Optional(Nullable(Type.String({ maxLength: 500 }))),
    attachmentIds: Type.Optional(Type.Array(Type.String())),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  },
  { $id: "CreateMedicalReportRequest", additionalProperties: false }
);

export type CreateMedicalReportRequest = Static<typeof CreateMedicalReportRequestSchema>;

export const UpdateMedicalReportRequestSchema = Type.Object(
  {
    baseVersion: BigIntString,
    items: Type.Optional(Type.Array(MedicalReportItemSchema, { maxItems: 500 })),
    reportDate: Type.Optional(DateString),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    hospital: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
    department: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
    diagnosis: Type.Optional(Nullable(Type.String({ maxLength: 500 }))),
    attachmentIds: Type.Optional(Type.Array(Type.String())),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 2000 }))),
  },
  { $id: "UpdateMedicalReportRequest", additionalProperties: false }
);

export type UpdateMedicalReportRequest = Static<typeof UpdateMedicalReportRequestSchema>;

export const MedicalReportResponseSchema = Type.Object(
  {
    data: MedicalReportSchema,
  },
  { $id: "MedicalReportResponse", additionalProperties: false }
);

export type MedicalReportResponse = Static<typeof MedicalReportResponseSchema>;

export const MedicalReportListResponseSchema = PaginatedEnvelope(MedicalReportSchema, {
  $id: "MedicalReportListResponse",
});

export type MedicalReportListResponse = Static<typeof MedicalReportListResponseSchema>;

export const CreateMedicalOcrRunRequestSchema = Type.Object(
  {
    attachmentId: UuidString,
  },
  { $id: "CreateMedicalOcrRunRequest", additionalProperties: false }
);

export type CreateMedicalOcrRunRequest = Static<typeof CreateMedicalOcrRunRequestSchema>;

export const MedicalOcrRunResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        runId: UuidString,
        status: Type.Literal("queued"),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "MedicalOcrRunResponse", additionalProperties: false }
);

export type MedicalOcrRunResponse = Static<typeof MedicalOcrRunResponseSchema>;

// ==========================================
// 2. Vaccines
// ==========================================

export const VaccineScheduleItemSchema = Type.Object(
  {
    id: Type.String(),
    vaccineCode: Type.String(),
    name: Type.String(),
    recommendedAgeMonths: Type.Integer({ minimum: 0 }),
    doseNumber: Type.Integer({ minimum: 1 }),
    mandatory: Type.Boolean(),
  },
  { $id: "VaccineScheduleItem", additionalProperties: false }
);

export type VaccineScheduleItem = Static<typeof VaccineScheduleItemSchema>;

export const VaccineScheduleResponseSchema = Type.Object(
  {
    data: Type.Array(VaccineScheduleItemSchema),
  },
  { $id: "VaccineScheduleResponse", additionalProperties: false }
);

export type VaccineScheduleResponse = Static<typeof VaccineScheduleResponseSchema>;

export const VaccineRecordSchema = Type.Object(
  {
    id: UuidString,
    babyId: UuidString,
    familyId: UuidString,
    vaccineCode: Type.String(),
    administeredDate: DateString,
    clinic: Nullable(Type.String()),
    batchNumber: Nullable(Type.String()),
    notes: Nullable(Type.String({ maxLength: 1000 })),
    version: BigIntString,
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "VaccineRecord", additionalProperties: false }
);

export type VaccineRecord = Static<typeof VaccineRecordSchema>;

export const CreateVaccineRecordRequestSchema = Type.Object(
  {
    vaccineCode: Type.String(),
    administeredDate: DateString,
    clinic: Type.Optional(Nullable(Type.String())),
    batchNumber: Type.Optional(Nullable(Type.String())),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  },
  { $id: "CreateVaccineRecordRequest", additionalProperties: false }
);

export type CreateVaccineRecordRequest = Static<typeof CreateVaccineRecordRequestSchema>;

export const VaccineRecordResponseSchema = Type.Object(
  {
    data: VaccineRecordSchema,
  },
  { $id: "VaccineRecordResponse", additionalProperties: false }
);

export type VaccineRecordResponse = Static<typeof VaccineRecordResponseSchema>;

export const VaccineListResponseSchema = Type.Object(
  {
    data: Type.Array(VaccineRecordSchema),
  },
  { $id: "VaccineListResponse", additionalProperties: false }
);

export type VaccineListResponse = Static<typeof VaccineListResponseSchema>;
