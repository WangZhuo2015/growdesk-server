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
    // Promoted legacy vaccine graph IDs are source-stable strings (for
    // example `vac_hepb`), not necessarily UUIDs.
    vaccineId: Nullable(Type.String({ minLength: 1, maxLength: 128 })),
    doseNumber: Nullable(Type.Integer({ minimum: 1, maximum: 12 })),
    legacyName: Nullable(Type.String({ maxLength: 200 })),
    legacyDose: Nullable(Type.String({ maxLength: 100 })),
    administeredDate: DateString,
    scheduledDate: Nullable(DateString),
    completedDate: Nullable(DateString),
    isCompleted: Type.Boolean(),
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
    vaccineId: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 128 }))),
    doseNumber: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
    legacyName: Type.Optional(Nullable(Type.String({ maxLength: 200 }))),
    legacyDose: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
    administeredDate: DateString,
    scheduledDate: Type.Optional(Nullable(DateString)),
    completedDate: Type.Optional(Nullable(DateString)),
    isCompleted: Type.Optional(Type.Boolean()),
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

export const VaccineSelectionSchema = Type.Object(
  {
    id: UuidString,
    familyId: UuidString,
    babyId: UuidString,
    vaccineId: Type.String({ minLength: 1, maxLength: 128 }),
    doseNumber: Type.Integer({ minimum: 1, maximum: 12 }),
    selected: Type.Boolean(),
    completed: Type.Boolean(),
    version: Type.Integer({ minimum: 1 }),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "VaccineSelection", additionalProperties: false },
);

export type VaccineSelection = Static<typeof VaccineSelectionSchema>;

export const VaccineSelectionListResponseSchema = Type.Object(
  { data: Type.Array(VaccineSelectionSchema) },
  { $id: "VaccineSelectionListResponse", additionalProperties: false },
);

export type VaccineSelectionListResponse = Static<typeof VaccineSelectionListResponseSchema>;

export const UpsertVaccineSelectionRequestSchema = Type.Object(
  {
    // The legacy Web key is vaccineCode (for example `vac_hepb`), while the
    // normalized graph uses the UUID primary key. The service resolves both
    // forms and always returns the normalized UUID in VaccineSelection.
    vaccineId: Type.String({ minLength: 1, maxLength: 128 }),
    doseNumber: Type.Integer({ minimum: 1, maximum: 12 }),
    selected: Type.Optional(Type.Boolean()),
    completed: Type.Optional(Type.Boolean()),
    baseVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { $id: "UpsertVaccineSelectionRequest", additionalProperties: false },
);

export type UpsertVaccineSelectionRequest = Static<typeof UpsertVaccineSelectionRequestSchema>;

export const VaccineCatalogItemSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    vaccineCode: Type.String(),
    name: Type.String(),
    shortName: Nullable(Type.String()),
    englishName: Nullable(Type.String()),
    programType: Type.String(),
    legacyLabel: Nullable(Type.String()),
    sexRestriction: Type.String(),
    chinaNational: Type.Boolean(),
    diseases: Nullable(Type.Unknown()),
    targetPopulation: Nullable(Type.String()),
    policyEffectiveDate: Nullable(DateString),
    policyVersion: Nullable(Type.String()),
    routineHealthyChildOption: Type.Boolean(),
    manualReviewRequired: Type.Boolean(),
    marketStatus: Nullable(Type.String()),
    productBrandName: Nullable(Type.String()),
    productManufacturer: Nullable(Type.String()),
    productApprovalNumber: Nullable(Type.String()),
    jiangsuNotes: Nullable(Type.String()),
    suzhouNotes: Nullable(Type.String()),
    catchUpSupported: Type.Boolean(),
    catchUpRules: Nullable(Type.Unknown()),
    simultaneousVaccination: Nullable(Type.String()),
    substitutionRules: Nullable(Type.Unknown()),
    contraindications: Nullable(Type.Unknown()),
    precautions: Nullable(Type.Unknown()),
    specialPopulations: Nullable(Type.Unknown()),
    regionalOverrides: Nullable(Type.Unknown()),
    regimenOptions: Nullable(Type.Unknown()),
    sourceRefsJson: Nullable(Type.Unknown()),
    doses: Type.Array(Type.Unknown()),
  },
  { $id: "VaccineCatalogItem", additionalProperties: false },
);

export const VaccineCatalogResponseSchema = Type.Object(
  {
    national: Type.Array(Type.Ref(VaccineCatalogItemSchema)),
    nonProgram: Type.Array(Type.Ref(VaccineCatalogItemSchema)),
    provincial: Type.Array(Type.Ref(VaccineCatalogItemSchema)),
    strategyGroups: Type.Array(Type.Unknown()),
    schedule: Type.Array(Type.Unknown()),
    engineRules: Type.Array(Type.Unknown()),
    dataRelease: Nullable(Type.Unknown()),
  },
  { $id: "VaccineCatalogResponse", additionalProperties: false },
);

export type VaccineCatalogResponse = Static<typeof VaccineCatalogResponseSchema>;
