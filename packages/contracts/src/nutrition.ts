import { Type, type Static } from "@sinclair/typebox";
import {
  Nullable,
  DateTimeString,
  DecimalString,
  UuidString,
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
    babyId: UuidString,
    planData: Type.Record(Type.String(), Type.Unknown()),
    updatedAt: DateTimeString,
  },
  { $id: "FoodPlan", additionalProperties: false }
);

export type FoodPlan = Static<typeof FoodPlanSchema>;

export const SaveFoodPlanRequestSchema = Type.Object(
  {
    planData: Type.Record(Type.String(), Type.Unknown()),
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
