import { Type, type Static } from "@sinclair/typebox";
import {
  Nullable,
  DateTimeString,
  DateString,
  DecimalString,
  UuidString,
  BigIntString,
  PaginatedEnvelope,
  SuccessEnvelope,
} from "./common.js";

// ==========================================
// 1. Formula Products
// ==========================================

/** A nutrient value as declared on a product label; amounts are per declared basis. */
export const NutritionProfileMeasurementSchema = Type.Object(
  {
    amount: Type.Union([
      Type.Number({ minimum: 0, maximum: 1000000000000 }),
      Type.String({ pattern: "^(?:0|[1-9]\\d*)(?:\\.\\d+)?$", maxLength: 40 }),
    ]),
    unit: Type.String({ minLength: 1, maxLength: 24 }),
  },
  { $id: "NutritionProfileMeasurement", additionalProperties: false }
);

/**
 * The IDs are extensible so clients can preserve label nutrients that this
 * pinned calculator does not yet evaluate. The server calculates only its
 * versioned reference IDs and reports all other values as outside coverage.
 */
export const NutritionProfileSchema = Type.Record(
  Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9 _-]*$" }),
  NutritionProfileMeasurementSchema,
  { $id: "NutritionProfile", maxProperties: 64 }
);

export const FormulaServingSizeUnitSchema = Type.Union([
  Type.Literal("per_100g"),
  Type.Literal("per_100ml"),
  Type.Literal("per_100kJ"),
]);

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
    version: Type.Integer({ minimum: 1 }),
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
    reconstitutionRatio: Type.Optional(Nullable(DecimalString)),
    servingSizeUnit: Type.Optional(FormulaServingSizeUnitSchema),
    nutrientsJson: Type.Optional(Nullable(NutritionProfileSchema)),
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
    reconstitutionRatio: Type.Optional(Nullable(DecimalString)),
    servingSizeUnit: Type.Optional(FormulaServingSizeUnitSchema),
    nutrientsJson: Type.Optional(Nullable(NutritionProfileSchema)),
    baseVersion: Type.Optional(Type.Integer({
      minimum: 1,
      description: "Required when changing nutrient profile/serving basis, or changing scoop/water reconstitution inputs while a profile exists.",
    })),
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

export const FamilyFoodStatusValueSchema = Type.Union([
  Type.Literal("tried"),
  Type.Literal("to_try"),
]);

export type FamilyFoodStatusValue = Static<typeof FamilyFoodStatusValueSchema>;

export const FoodTextureByAgeSchema = Type.Object(
  {
    ageMinMonths: Nullable(Type.Integer({ minimum: 0, maximum: 120 })),
    ageMaxMonths: Nullable(Type.Integer({ minimum: 0, maximum: 120 })),
    texture: Type.String({ minLength: 1, maxLength: 500 }),
  },
  { $id: "FoodTextureByAge", additionalProperties: false },
);

export const FoodDataSourceSchema = Type.Object(
  {
    asOf: DateString,
    scope: Type.String({ minLength: 1, maxLength: 32 }),
    evidenceConflict: Type.Boolean(),
  },
  { $id: "FoodDataSource", additionalProperties: false },
);

export const FoodLibraryItemSchema = Type.Object(
  {
    id: Type.String(),
    /** Server-owned catalog classification; absent on older servers means unknown, not editable. */
    isCustom: Type.Optional(Type.Boolean()),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    icon: Type.String({ minLength: 1, maxLength: 32 }),
    category: Type.String({ minLength: 1, maxLength: 50 }),
    foodGroup: Nullable(Type.String({ maxLength: 50 })),
    status: FamilyFoodStatusValueSchema,
    firstAddedDate: Nullable(DateString),
    acceptance: Type.Integer({ minimum: 0, maximum: 5 }),
    allergenRisk: FoodAllergenRiskSchema,
    recommendedAgeMonths: Type.Integer({ minimum: 0 }),
    recommendedFromMonth: Nullable(Type.Integer({ minimum: 0, maximum: 120 })),
    recommendedToMonth: Nullable(Type.Integer({ minimum: 0, maximum: 120 })),
    exactMonthEvidence: Type.Boolean(),
    guidance: Nullable(Type.String({ maxLength: 2000 })),
    isCommonAllergen: Nullable(Type.Boolean()),
    allergenIntroductionGuidance: Nullable(Type.String({ maxLength: 2000 })),
    highRiskInfantNeedsMedicalAdvice: Nullable(Type.Boolean()),
    chokingRisk: Type.Boolean(),
    chokingNotes: Nullable(Type.String({ maxLength: 2000 })),
    preparation: Type.Array(Type.String({ maxLength: 1000 }), { maxItems: 30 }),
    avoidBeforeMonths: Nullable(Type.Integer({ minimum: 0, maximum: 120 })),
    nutrition: Type.Array(Type.String({ maxLength: 200 }), { maxItems: 32 }),
    textureByAge: Type.Array(FoodTextureByAgeSchema, { maxItems: 32 }),
    notes: Nullable(Type.String({ maxLength: 2000 })),
    sourceRefs: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 }),
    dataSource: Type.Optional(FoodDataSourceSchema),
    /** Custom numeric profiles use values per 100 g; legacy descriptive nutritionJson remains separate. */
    nutritionBasis: Type.Optional(Nullable(Type.Literal("per_100g"))),
    nutrientsJson: Type.Optional(Nullable(NutritionProfileSchema)),
    version: Type.Integer({ minimum: 1 }),
    familyStatus: Type.Optional(
      Type.Object(
        {
          tried: Type.Boolean(),
          status: FamilyFoodStatusValueSchema,
          firstAddedDate: Nullable(DateString),
          acceptance: Type.Integer({ minimum: 0, maximum: 5 }),
          reaction: Nullable(Type.String({ maxLength: 32 })),
          version: Type.Integer({ minimum: 1 }),
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
    status: Type.Optional(FamilyFoodStatusValueSchema),
    firstAddedDate: Type.Optional(Nullable(DateString)),
    acceptance: Type.Optional(Type.Integer({ minimum: 0, maximum: 5 })),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    icon: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })),
    category: Type.String({ minLength: 1, maxLength: 50 }),
    allergenRisk: FoodAllergenRiskSchema,
    recommendedAgeMonths: Type.Integer({ minimum: 0 }),
    nutritionBasis: Type.Optional(Type.Literal("per_100g")),
    nutrientsJson: Type.Optional(Nullable(NutritionProfileSchema)),
  },
  { $id: "CreateFoodLibraryItemRequest", additionalProperties: false }
);

export type CreateFoodLibraryItemRequest = Static<typeof CreateFoodLibraryItemRequestSchema>;

export const UpdateFoodLibraryItemRequestSchema = Type.Object(
  {
    /** Null clears the custom family's numeric nutrient profile. */
    nutrientsJson: Nullable(NutritionProfileSchema),
    baseVersion: Type.Integer({ minimum: 1 }),
  },
  { $id: "UpdateFoodLibraryItemRequest", additionalProperties: false }
);

export type UpdateFoodLibraryItemRequest = Static<typeof UpdateFoodLibraryItemRequestSchema>;

export const UpdateFamilyFoodStatusRequestSchema = Type.Object(
  {
    status: FamilyFoodStatusValueSchema,
    firstAddedDate: Nullable(DateString),
    acceptance: Type.Integer({ minimum: 0, maximum: 5 }),
    reaction: Type.Optional(Nullable(Type.String({ maxLength: 32 }))),
    baseVersion: Type.Integer({ minimum: 0 }),
  },
  { $id: "UpdateFamilyFoodStatusRequest", additionalProperties: false },
);

export type UpdateFamilyFoodStatusRequest = Static<typeof UpdateFamilyFoodStatusRequestSchema>;

export const FamilyFoodStatusResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        id: Type.String({ minLength: 1, maxLength: 128 }),
        familyId: UuidString,
        foodId: Type.String({ minLength: 1, maxLength: 64 }),
        tried: Type.Boolean(),
        status: FamilyFoodStatusValueSchema,
        firstAddedDate: Nullable(DateString),
        acceptance: Type.Integer({ minimum: 0, maximum: 5 }),
        reaction: Nullable(Type.String({ maxLength: 32 })),
        version: Type.Integer({ minimum: 1 }),
        updatedAt: DateTimeString,
      },
      { additionalProperties: false },
    ),
  },
  { $id: "FamilyFoodStatusResponse", additionalProperties: false },
);

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

// ==========================================
// 4. Server-calculated nutrition analysis
// ==========================================

export const NutritionAnalysisQuerySchema = Type.Object(
  {
    date: DateString,
    datasetVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { $id: "NutritionAnalysisQuery", additionalProperties: false },
);

export const NutritionTrendsQuerySchema = Type.Object(
  {
    from: DateString,
    to: DateString,
    datasetVersion: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
  },
  { $id: "NutritionTrendsQuery", additionalProperties: false },
);

const NutritionCategorySchema = Type.Union([
  Type.Literal("macro"),
  Type.Literal("vitamin"),
  Type.Literal("mineral"),
  Type.Literal("fatty_acid"),
  Type.Literal("other"),
]);

const NutritionCoverageStatusSchema = Type.Union([
  Type.Literal("no_logged_source"),
  Type.Literal("calculated"),
  Type.Literal("estimated"),
  Type.Literal("partial"),
  Type.Literal("unknown"),
]);

const NutritionSourceContributionSchema = Type.Object(
  {
    sourceId: Type.String({ minLength: 1, maxLength: 256 }),
    sourceName: Type.String({ maxLength: 512 }),
    sourceType: Type.Union([
      Type.Literal("formula"),
      Type.Literal("supplement"),
      Type.Literal("breastmilk"),
      Type.Literal("food"),
    ]),
    amount: DecimalString,
    unit: Type.String({ minLength: 1, maxLength: 32 }),
    basis: Type.Union([Type.Literal("product_calculation"), Type.Literal("legacy_estimate")]),
    assumptions: Type.Array(Type.String({ maxLength: 255 })),
  },
  { $id: "NutritionSourceContribution", additionalProperties: false },
);

export const NutritionNutrientValueSchema = Type.Object(
  {
    nutrientId: Type.String({ minLength: 1, maxLength: 64 }),
    name: Type.String({ minLength: 1, maxLength: 100 }),
    unit: Type.String({ minLength: 1, maxLength: 32 }),
    category: NutritionCategorySchema,
    formulaCalculatedAmount: DecimalString,
    supplementCalculatedAmount: DecimalString,
    breastmilkEstimatedAmount: DecimalString,
    foodCalculatedAmount: DecimalString,
    foodEstimatedAmount: DecimalString,
    calculatedAmount: DecimalString,
    estimatedAmount: DecimalString,
    knownSubtotalAmount: DecimalString,
    targetAmount: Nullable(DecimalString),
    targetType: Nullable(Type.Union([Type.Literal("RNI"), Type.Literal("AI")])),
    ulAmount: Nullable(DecimalString),
    knownSubtotalAchievementRate: Nullable(DecimalString),
    knownProductAmountExceedsUL: Nullable(Type.Boolean()),
    sources: Type.Array(NutritionSourceContributionSchema),
    coverage: Type.Object(
      {
        status: NutritionCoverageStatusSchema,
        calculatedSourceCount: Type.Integer({ minimum: 0 }),
        estimatedSourceCount: Type.Integer({ minimum: 0 }),
        unknownSourceCount: Type.Integer({ minimum: 0 }),
      },
      { additionalProperties: false },
    ),
  },
  { $id: "NutritionNutrientValue", additionalProperties: false },
);

export const NutritionAnalysisDataSchema = Type.Object(
  {
    babyId: UuidString,
    familyId: UuidString,
    date: DateString,
    timeZone: Type.String({ minLength: 1, maxLength: 100 }),
    localDayStartAt: DateTimeString,
    localDayEndExclusiveAt: DateTimeString,
    ageMonths: Nullable(Type.Integer({ minimum: 0 })),
    ageGroup: Type.Union([
      Type.Literal("unknown_age"),
      Type.Literal("0-6m"),
      Type.Literal("6-12m"),
      Type.Literal("1-3y"),
      Type.Literal("unsupported_over_36m"),
    ]),
    referenceDataset: Type.Object(
      {
        version: Type.String(),
        sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
        validationStatus: Type.Literal("legacy_values_not_independently_cross_checked"),
        driSource: Type.String(),
        foodSource: Type.String(),
        breastmilkSource: Type.String(),
      },
      { additionalProperties: false },
    ),
    summary: Type.Object(
      {
        formulaMl: DecimalString,
        breastmilkRecordedMl: DecimalString,
        breastmilkEstimatedMl: DecimalString,
        knownMilkSubtotalMl: DecimalString,
        supplementRecordCount: Type.Integer({ minimum: 0 }),
        foodRecordCount: Type.Integer({ minimum: 0 }),
        foodsLogged: Type.Array(Type.String({ maxLength: 255 })),
      },
      { additionalProperties: false },
    ),
    coverage: Type.Object(
      {
        feedingRecordCount: Type.Integer({ minimum: 0 }),
        supplementRecordCount: Type.Integer({ minimum: 0 }),
        foodRecordCount: Type.Integer({ minimum: 0 }),
        calculatedSourceCount: Type.Integer({ minimum: 0 }),
        estimatedSourceCount: Type.Integer({ minimum: 0 }),
        unknownSourceCount: Type.Integer({ minimum: 0 }),
        unsupportedUnitCount: Type.Integer({ minimum: 0 }),
        unsupportedFoodCount: Type.Integer({ minimum: 0 }),
        logCompleteness: Type.Literal("unverified"),
        notes: Type.Array(Type.String({ maxLength: 500 })),
      },
      { additionalProperties: false },
    ),
    nutrients: Type.Array(NutritionNutrientValueSchema),
  },
  { $id: "NutritionAnalysisData", additionalProperties: false },
);

export const NutritionAnalysisResponseSchema = SuccessEnvelope(NutritionAnalysisDataSchema, {
  $id: "NutritionAnalysisResponse",
});

export const NutritionTrendAverageSchema = Type.Object(
  {
    nutrientId: Type.String({ minLength: 1, maxLength: 64 }),
    calculatedAmountPerDay: DecimalString,
    estimatedAmountPerDay: DecimalString,
    knownSubtotalPerDay: DecimalString,
    averageTargetAmount: Nullable(DecimalString),
    targetDaysCount: Type.Integer({ minimum: 0, maximum: 90 }),
    targetCoverageRatio: DecimalString,
    averageKnownSubtotalAchievementRate: Nullable(DecimalString),
    unit: Type.String({ minLength: 1, maxLength: 32 }),
  },
  { $id: "NutritionTrendAverage", additionalProperties: false },
);

export const NutritionTrendsDataSchema = Type.Object(
  {
    babyId: UuidString,
    familyId: UuidString,
    from: DateString,
    to: DateString,
    daysCount: Type.Integer({ minimum: 1, maximum: 90 }),
    timeZone: Type.String({ minLength: 1, maxLength: 100 }),
    referenceDataset: NutritionAnalysisDataSchema.properties.referenceDataset,
    daily: Type.Array(NutritionAnalysisDataSchema),
    averages: Type.Array(NutritionTrendAverageSchema),
    coverage: Type.Object(
      {
        logCompleteness: Type.Literal("unverified"),
        notes: Type.Array(Type.String({ maxLength: 500 })),
      },
      { additionalProperties: false },
    ),
  },
  { $id: "NutritionTrendsData", additionalProperties: false },
);

export const NutritionTrendsResponseSchema = SuccessEnvelope(NutritionTrendsDataSchema, {
  $id: "NutritionTrendsResponse",
});
