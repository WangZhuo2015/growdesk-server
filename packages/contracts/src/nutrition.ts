import { Type, type Static } from "@sinclair/typebox";
import {
  Nullable,
  DateTimeString,
  DecimalString,
  UuidString,
  BigIntString,
  PaginatedEnvelope,
} from "./common.js";

// ==========================================
// 1. Formula Products
// ==========================================

export const FormulaProductSchema = Type.Object(
  {
    id: UuidString,
    familyId: UuidString,
    brand: Type.String({ minLength: 1, maxLength: 100 }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    stage: Nullable(Type.String({ maxLength: 50 })),
    scoopGrams: Nullable(DecimalString),
    waterMlPerScoop: Nullable(DecimalString),
    // The Web compatibility layer needs the persisted nutrition/product
    // metadata when resolving a feeding's formulaProduct relation. These are
    // read-only projections of existing FormulaProduct columns.
    reconstitutionRatio: Nullable(DecimalString),
    servingSizeUnit: Type.String({ minLength: 1, maxLength: 50 }),
    nutrientsJson: Nullable(Type.Unknown()),
    notes: Nullable(Type.String({ maxLength: 1000 })),
    isActive: Type.Boolean(),
    isDefault: Type.Boolean(),
    isArchived: Type.Boolean(),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "FormulaProduct", additionalProperties: false }
);

export type FormulaProduct = Static<typeof FormulaProductSchema>;

export const FormulaProductListQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String({ description: "Keyset cursor to fetch next page" })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50, description: "Page size" })),
    includeArchived: Type.Optional(Type.Boolean({ description: "Include archived products for historical relations" })),
  },
  { $id: "FormulaProductListQuery", additionalProperties: false },
);

export type FormulaProductListQuery = Static<typeof FormulaProductListQuerySchema>;

export const CreateFormulaProductRequestSchema = Type.Object(
  {
    brand: Type.String({ minLength: 1, maxLength: 100 }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    stage: Type.Optional(Nullable(Type.String({ maxLength: 50 }))),
    scoopGrams: Type.Optional(Nullable(DecimalString)),
    waterMlPerScoop: Type.Optional(Nullable(DecimalString)),
  },
  { $id: "CreateFormulaProductRequest", additionalProperties: false }
);

export type CreateFormulaProductRequest = Static<typeof CreateFormulaProductRequestSchema>;

export const UpdateFormulaProductRequestSchema = Type.Object(
  {
    brand: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    stage: Type.Optional(Nullable(Type.String({ maxLength: 50 }))),
    scoopGrams: Type.Optional(Nullable(DecimalString)),
    waterMlPerScoop: Type.Optional(Nullable(DecimalString)),
    isArchived: Type.Optional(Type.Boolean()),
  },
  { $id: "UpdateFormulaProductRequest", additionalProperties: false }
);

export type UpdateFormulaProductRequest = Static<typeof UpdateFormulaProductRequestSchema>;

export const FormulaProductResponseSchema = Type.Object(
  {
    data: FormulaProductSchema,
  },
  { $id: "FormulaProductResponse", additionalProperties: false }
);

export type FormulaProductResponse = Static<typeof FormulaProductResponseSchema>;

export const FormulaProductListResponseSchema = PaginatedEnvelope(FormulaProductSchema, {
  $id: "FormulaProductListResponse",
});

export type FormulaProductListResponse = Static<typeof FormulaProductListResponseSchema>;

// ==========================================
// 1b. Supplement products and schedules
// ==========================================

/**
 * The old Web stores these records in BabyFoodPlan.planData.  They are now
 * first-class family/baby scoped rows so a migrated tenant remains visible to
 * every client and does not depend on a JSON compatibility projection.
 */
export const SupplementProductSchema = Type.Object(
  {
    // Legacy promotion preserves source-stable IDs (for example
    // `test_sv_product_d3`) rather than rewriting every Web reference.
    id: Type.String({ minLength: 1, maxLength: 128 }),
    familyId: UuidString,
    name: Type.String({ minLength: 1, maxLength: 200 }),
    brand: Nullable(Type.String({ maxLength: 100 })),
    dosageForm: Nullable(Type.String({ maxLength: 50 })),
    unitName: Type.String({ minLength: 1, maxLength: 50 }),
    defaultDose: DecimalString,
    nutrientsJson: Nullable(Type.Unknown()),
    notes: Nullable(Type.String()),
    isActive: Type.Boolean(),
    isArchived: Type.Boolean(),
    version: Type.Integer({ minimum: 1 }),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "SupplementProduct", additionalProperties: false },
);

export type SupplementProduct = Static<typeof SupplementProductSchema>;

export const SupplementProductListQuerySchema = Type.Object(
  {
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    includeArchived: Type.Optional(Type.Boolean()),
  },
  { $id: "SupplementProductListQuery", additionalProperties: false },
);

export type SupplementProductListQuery = Static<typeof SupplementProductListQuerySchema>;

export const CreateSupplementProductRequestSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    brand: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
    dosageForm: Type.Optional(Nullable(Type.String({ maxLength: 50 }))),
    unitName: Type.String({ minLength: 1, maxLength: 50 }),
    defaultDose: Type.Optional(DecimalString),
    nutrientsJson: Type.Optional(Nullable(Type.Unknown())),
    notes: Type.Optional(Nullable(Type.String())),
  },
  { $id: "CreateSupplementProductRequest", additionalProperties: false },
);

export type CreateSupplementProductRequest = Static<typeof CreateSupplementProductRequestSchema>;

export const UpdateSupplementProductRequestSchema = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    brand: Type.Optional(Nullable(Type.String({ maxLength: 100 }))),
    dosageForm: Type.Optional(Nullable(Type.String({ maxLength: 50 }))),
    unitName: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
    defaultDose: Type.Optional(DecimalString),
    nutrientsJson: Type.Optional(Nullable(Type.Unknown())),
    notes: Type.Optional(Nullable(Type.String())),
    isActive: Type.Optional(Type.Boolean()),
    isArchived: Type.Optional(Type.Boolean()),
    baseVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { $id: "UpdateSupplementProductRequest", additionalProperties: false },
);

export type UpdateSupplementProductRequest = Static<typeof UpdateSupplementProductRequestSchema>;

export const SupplementProductResponseSchema = Type.Object(
  { data: SupplementProductSchema },
  { $id: "SupplementProductResponse", additionalProperties: false },
);

export const SupplementProductListResponseSchema = PaginatedEnvelope(SupplementProductSchema, {
  $id: "SupplementProductListResponse",
});

export type SupplementProductListResponse = Static<typeof SupplementProductListResponseSchema>;

export const SupplementScheduleSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 128 }),
    familyId: UuidString,
    babyId: UuidString,
    productId: Type.String({ minLength: 1, maxLength: 128 }),
    product: SupplementProductSchema,
    frequency: Type.String({ minLength: 1, maxLength: 32 }),
    customDays: Nullable(Type.Unknown()),
    targetDose: DecimalString,
    reminderTime: Nullable(Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" })),
    isActive: Type.Boolean(),
    startDate: Nullable(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
    notes: Nullable(Type.String()),
    version: Type.Integer({ minimum: 1 }),
    isCompletedToday: Type.Boolean(),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "SupplementSchedule", additionalProperties: false },
);

export type SupplementSchedule = Static<typeof SupplementScheduleSchema>;

export const SupplementScheduleResponseSchema = Type.Object(
  { data: SupplementScheduleSchema },
  { $id: "SupplementScheduleResponse", additionalProperties: false },
);

export const SupplementScheduleListQuerySchema = Type.Object(
  { date: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })) },
  { $id: "SupplementScheduleListQuery", additionalProperties: false },
);

export type SupplementScheduleListQuery = Static<typeof SupplementScheduleListQuerySchema>;

export const CreateSupplementScheduleRequestSchema = Type.Object(
  {
    id: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
    productId: Type.String({ minLength: 1, maxLength: 128 }),
    frequency: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    customDays: Type.Optional(Nullable(Type.Unknown())),
    targetDose: Type.Optional(DecimalString),
    reminderTime: Type.Optional(Nullable(Type.String({ pattern: "^(?:[01]\\d|2[0-3]):[0-5]\\d$" }))),
    isActive: Type.Optional(Type.Boolean()),
    startDate: Type.Optional(Nullable(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" }))),
    notes: Type.Optional(Nullable(Type.String())),
    baseVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { $id: "CreateSupplementScheduleRequest", additionalProperties: false },
);

export type CreateSupplementScheduleRequest = Static<typeof CreateSupplementScheduleRequestSchema>;

export const SupplementScheduleListResponseSchema = PaginatedEnvelope(SupplementScheduleSchema, {
  $id: "SupplementScheduleListResponse",
});

export type SupplementScheduleListResponse = Static<typeof SupplementScheduleListResponseSchema>;

// ==========================================
// 2. Food Library & Guidelines
// ==========================================

export const FoodAllergenRiskSchema = Type.Union([
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
]);

export type FoodAllergenRisk = Static<typeof FoodAllergenRiskSchema>;

/**
 * Food-library requests are family scoped. The optional field keeps the
 * single-family legacy client wire-compatible; the API resolves it only when
 * the authenticated principal has exactly one active family.
 */
export const FoodLibraryItemsQuerySchema = Type.Object(
  {
    familyId: Type.Optional(UuidString),
  },
  { $id: "FoodLibraryItemsQuery", additionalProperties: false },
);

export type FoodLibraryItemsQuery = Static<typeof FoodLibraryItemsQuerySchema>;

export const FoodLibraryItemSchema = Type.Object(
  {
    id: Type.String(),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    category: Type.String({ minLength: 1, maxLength: 50 }),
    allergenRisk: FoodAllergenRiskSchema,
    recommendedAgeMonths: Type.Integer({ minimum: 0 }),
    familyStatus: Type.Optional(
      Type.Object(
        {
          tried: Type.Boolean(),
          reaction: Nullable(Type.String()),
        },
        { additionalProperties: false }
      )
    ),
  },
  { $id: "FoodLibraryItem", additionalProperties: false }
);

export type FoodLibraryItem = Static<typeof FoodLibraryItemSchema>;

export const CreateFoodLibraryItemRequestSchema = Type.Object(
  {
    familyId: Type.Optional(UuidString),
    /** Legacy create-as-tried flow; persisted as the family-scoped status row. */
    tried: Type.Optional(Type.Boolean()),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    category: Type.String({ minLength: 1, maxLength: 50 }),
    allergenRisk: FoodAllergenRiskSchema,
    recommendedAgeMonths: Type.Integer({ minimum: 0 }),
    // Optional legacy compatibility: create the item with an explicit family
    // "tried" status in one step (old Web marks custom foods tried on create).
    tried: Type.Optional(Type.Boolean()),
  },
  { $id: "CreateFoodLibraryItemRequest", additionalProperties: false }
);

export type CreateFoodLibraryItemRequest = Static<typeof CreateFoodLibraryItemRequestSchema>;

export const FoodLibraryItemListResponseSchema = Type.Object(
  {
    data: Type.Array(FoodLibraryItemSchema),
  },
  { $id: "FoodLibraryItemListResponse", additionalProperties: false }
);

export type FoodLibraryItemListResponse = Static<typeof FoodLibraryItemListResponseSchema>;

export const FoodGuidelineItemSchema = Type.Object(
  {
    monthAge: Type.Integer({ minimum: 0 }),
    title: Type.String(),
    content: Type.String(),
    forbiddenFoods: Type.Array(Type.String()),
  },
  { $id: "FoodGuidelineItem", additionalProperties: false }
);

export type FoodGuidelineItem = Static<typeof FoodGuidelineItemSchema>;

export const FoodGuidelinesResponseSchema = Type.Object(
  {
    data: Type.Array(FoodGuidelineItemSchema),
  },
  { $id: "FoodGuidelinesResponse", additionalProperties: false }
);

export type FoodGuidelinesResponse = Static<typeof FoodGuidelinesResponseSchema>;

// ==========================================
// 3. Baby Food Plan
// ==========================================

export const FoodPlanSchema = Type.Object(
  {
    id: Nullable(UuidString),
    babyId: UuidString,
    planData: Type.Record(Type.String(), Type.Unknown()),
    createdAt: Nullable(DateTimeString),
    updatedAt: DateTimeString,
    version: BigIntString,
  },
  { $id: "FoodPlan", additionalProperties: false }
);

export type FoodPlan = Static<typeof FoodPlanSchema>;

export const SaveFoodPlanRequestSchema = Type.Object(
  {
    planData: Type.Record(Type.String(), Type.Unknown()),
    baseVersion: BigIntString,
  },
  { $id: "SaveFoodPlanRequest", additionalProperties: false }
);

export type SaveFoodPlanRequest = Static<typeof SaveFoodPlanRequestSchema>;

export const FoodPlanResponseSchema = Type.Object(
  {
    data: FoodPlanSchema,
  },
  { $id: "FoodPlanResponse", additionalProperties: false }
);

export type FoodPlanResponse = Static<typeof FoodPlanResponseSchema>;
