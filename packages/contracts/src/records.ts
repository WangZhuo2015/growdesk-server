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

// ==========================================
// 1. Feeding Records (SH-04F)
// ==========================================

export const FeedingTypeSchema = Type.Union([
  Type.Literal("breast"),
  Type.Literal("bottle"),
  Type.Literal("formula"),
  Type.Literal("mixed"),
]);

export type FeedingType = Static<typeof FeedingTypeSchema>;

export const DeleteFeedingQuerySchema = Type.Object(
  { baseVersion: Type.String({ pattern: "^[1-9]\\d*$", description: "Version observed by the client; never replaced with the latest server version" }) },
  { $id: "DeleteFeedingQuery", additionalProperties: false },
);
export type DeleteFeedingQuery = Static<typeof DeleteFeedingQuerySchema>;

export const FeedingRecordSchema = Type.Object(
  {
    id: UuidString,
    babyId: UuidString,
    familyId: UuidString,
    feedingType: FeedingTypeSchema,
    occurredAt: DateTimeString,
    amountMl: Nullable(DecimalString),
    leftMinutes: Nullable(Type.Integer({ minimum: 0 })),
    rightMinutes: Nullable(Type.Integer({ minimum: 0 })),
    spitUp: Type.Boolean(),
    formulaProductId: Nullable(Type.String()),
    notes: Nullable(Type.String({ maxLength: 1000 })),
    source: Type.String({ default: "ui_manual" }),
    sourceAgent: Nullable(Type.String()),
    recordedByUserId: Type.Optional(Nullable(UuidString)),
    version: BigIntString,
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "FeedingRecord", additionalProperties: false }
);

export type FeedingRecord = Static<typeof FeedingRecordSchema>;

export const CreateFeedingRequestSchema = Type.Object(
  {
    feedingType: FeedingTypeSchema,
    occurredAt: DateTimeString,
    amountMl: Type.Optional(Nullable(DecimalString)),
    leftMinutes: Type.Optional(Nullable(Type.Integer({ minimum: 0 }))),
    rightMinutes: Type.Optional(Nullable(Type.Integer({ minimum: 0 }))),
    spitUp: Type.Optional(Type.Boolean({ default: false })),
    formulaProductId: Type.Optional(Nullable(Type.String())),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
    source: Type.Optional(Type.String({ default: "ui_manual" })),
    sourceAgent: Type.Optional(Nullable(Type.String())),
  },
  { $id: "CreateFeedingRequest", additionalProperties: false }
);

export type CreateFeedingRequest = Static<typeof CreateFeedingRequestSchema>;

export const UpdateFeedingRequestSchema = Type.Object(
  {
    baseVersion: BigIntString,
    feedingType: Type.Optional(FeedingTypeSchema),
    occurredAt: Type.Optional(DateTimeString),
    amountMl: Type.Optional(Nullable(DecimalString)),
    leftMinutes: Type.Optional(Nullable(Type.Integer({ minimum: 0 }))),
    rightMinutes: Type.Optional(Nullable(Type.Integer({ minimum: 0 }))),
    spitUp: Type.Optional(Type.Boolean()),
    formulaProductId: Type.Optional(Nullable(Type.String())),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  },
  { $id: "UpdateFeedingRequest", additionalProperties: false }
);

export type UpdateFeedingRequest = Static<typeof UpdateFeedingRequestSchema>;

export const FeedingRecordResponseSchema = Type.Object(
  {
    data: FeedingRecordSchema,
  },
  { $id: "FeedingRecordResponse", additionalProperties: false }
);

export type FeedingRecordResponse = Static<typeof FeedingRecordResponseSchema>;

export const FeedingListResponseSchema = PaginatedEnvelope(FeedingRecordSchema, {
  $id: "FeedingListResponse",
});

export type FeedingListResponse = Static<typeof FeedingListResponseSchema>;

// ==========================================
// 2. Sleep Records (SH-04S)
// ==========================================

export const SleepTypeSchema = Type.Union([
  Type.Literal("nap"),
  Type.Literal("night"),
]);

export type SleepType = Static<typeof SleepTypeSchema>;

export const SleepRecordSchema = Type.Object(
  {
    id: UuidString,
    babyId: UuidString,
    familyId: UuidString,
    sleepType: SleepTypeSchema,
    startedAt: DateTimeString,
    endedAt: Nullable(DateTimeString),
    nightWakingCount: Type.Integer({ minimum: 0, default: 0 }),
    notes: Nullable(Type.String({ maxLength: 1000 })),
    source: Type.String({ default: "ui_manual" }),
    sourceAgent: Nullable(Type.String()),
    recordedByUserId: Type.Optional(Nullable(UuidString)),
    version: BigIntString,
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "SleepRecord", additionalProperties: false }
);

export type SleepRecord = Static<typeof SleepRecordSchema>;

export const CreateSleepRequestSchema = Type.Object(
  {
    sleepType: SleepTypeSchema,
    startedAt: DateTimeString,
    endedAt: Type.Optional(Nullable(DateTimeString)),
    nightWakingCount: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
    source: Type.Optional(Type.String({ default: "ui_manual" })),
    sourceAgent: Type.Optional(Nullable(Type.String())),
  },
  { $id: "CreateSleepRequest", additionalProperties: false }
);

export type CreateSleepRequest = Static<typeof CreateSleepRequestSchema>;

export const UpdateSleepRequestSchema = Type.Object(
  {
    baseVersion: BigIntString,
    sleepType: Type.Optional(SleepTypeSchema),
    startedAt: Type.Optional(DateTimeString),
    endedAt: Type.Optional(Nullable(DateTimeString)),
    nightWakingCount: Type.Optional(Type.Integer({ minimum: 0 })),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  },
  { $id: "UpdateSleepRequest", additionalProperties: false }
);

export type UpdateSleepRequest = Static<typeof UpdateSleepRequestSchema>;

export const SleepRecordResponseSchema = Type.Object(
  {
    data: SleepRecordSchema,
  },
  { $id: "SleepRecordResponse", additionalProperties: false }
);

export type SleepRecordResponse = Static<typeof SleepRecordResponseSchema>;

export const SleepListResponseSchema = PaginatedEnvelope(SleepRecordSchema, {
  $id: "SleepListResponse",
});

export type SleepListResponse = Static<typeof SleepListResponseSchema>;

// ==========================================
// 3. Diaper Records (SH-04D)
// ==========================================

export const DiaperTypeSchema = Type.Union([
  Type.Literal("pee"),
  Type.Literal("poop"),
  Type.Literal("both"),
]);

export type DiaperType = Static<typeof DiaperTypeSchema>;

export const DiaperRecordSchema = Type.Object(
  {
    id: UuidString,
    babyId: UuidString,
    familyId: UuidString,
    diaperType: DiaperTypeSchema,
    occurredAt: DateTimeString,
    poopColor: Nullable(Type.String()),
    poopConsistency: Nullable(Type.String()),
    notes: Nullable(Type.String({ maxLength: 1000 })),
    source: Type.String({ default: "ui_manual" }),
    sourceAgent: Nullable(Type.String()),
    recordedByUserId: Type.Optional(Nullable(UuidString)),
    version: BigIntString,
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "DiaperRecord", additionalProperties: false }
);

export type DiaperRecord = Static<typeof DiaperRecordSchema>;

export const CreateDiaperRequestSchema = Type.Object(
  {
    diaperType: DiaperTypeSchema,
    occurredAt: DateTimeString,
    poopColor: Type.Optional(Nullable(Type.String())),
    poopConsistency: Type.Optional(Nullable(Type.String())),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
    source: Type.Optional(Type.String({ default: "ui_manual" })),
    sourceAgent: Type.Optional(Nullable(Type.String())),
  },
  { $id: "CreateDiaperRequest", additionalProperties: false }
);

export type CreateDiaperRequest = Static<typeof CreateDiaperRequestSchema>;

export const UpdateDiaperRequestSchema = Type.Object(
  {
    baseVersion: BigIntString,
    diaperType: Type.Optional(DiaperTypeSchema),
    occurredAt: Type.Optional(DateTimeString),
    poopColor: Type.Optional(Nullable(Type.String())),
    poopConsistency: Type.Optional(Nullable(Type.String())),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  },
  { $id: "UpdateDiaperRequest", additionalProperties: false }
);

export type UpdateDiaperRequest = Static<typeof UpdateDiaperRequestSchema>;

export const DiaperRecordResponseSchema = Type.Object(
  {
    data: DiaperRecordSchema,
  },
  { $id: "DiaperRecordResponse", additionalProperties: false }
);

export type DiaperRecordResponse = Static<typeof DiaperRecordResponseSchema>;

export const DiaperListResponseSchema = PaginatedEnvelope(DiaperRecordSchema, {
  $id: "DiaperListResponse",
});

export type DiaperListResponse = Static<typeof DiaperListResponseSchema>;

// ==========================================
// 4. Food Records (SH-04FO)
// ==========================================

export const MealTypeSchema = Type.Union([
  Type.Literal("breakfast"),
  Type.Literal("lunch"),
  Type.Literal("dinner"),
  Type.Literal("snack"),
]);

export type MealType = Static<typeof MealTypeSchema>;

export const FoodReactionSchema = Type.Union([
  Type.Literal("like"),
  Type.Literal("normal"),
  Type.Literal("dislike"),
]);

export type FoodReaction = Static<typeof FoodReactionSchema>;

export const FoodRecordSchema = Type.Object(
  {
    id: UuidString,
    babyId: UuidString,
    familyId: UuidString,
    recordDate: DateString,
    mealType: MealTypeSchema,
    occurredAt: Nullable(DateTimeString),
    foodItemIds: Type.Array(Type.String()),
    portionDescription: Nullable(Type.String()),
    reaction: Nullable(FoodReactionSchema),
    notes: Nullable(Type.String({ maxLength: 1000 })),
    version: BigIntString,
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "FoodRecord", additionalProperties: false }
);

export type FoodRecord = Static<typeof FoodRecordSchema>;

export const CreateFoodRequestSchema = Type.Object(
  {
    recordDate: DateString,
    mealType: MealTypeSchema,
    occurredAt: Type.Optional(Nullable(DateTimeString)),
    foodItemIds: Type.Array(Type.String()),
    portionDescription: Type.Optional(Nullable(Type.String())),
    reaction: Type.Optional(Nullable(FoodReactionSchema)),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  },
  { $id: "CreateFoodRequest", additionalProperties: false }
);

export type CreateFoodRequest = Static<typeof CreateFoodRequestSchema>;

export const UpdateFoodRequestSchema = Type.Object(
  {
    baseVersion: BigIntString,
    recordDate: Type.Optional(DateString),
    mealType: Type.Optional(MealTypeSchema),
    occurredAt: Type.Optional(Nullable(DateTimeString)),
    foodItemIds: Type.Optional(Type.Array(Type.String())),
    portionDescription: Type.Optional(Nullable(Type.String())),
    reaction: Type.Optional(Nullable(FoodReactionSchema)),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  },
  { $id: "UpdateFoodRequest", additionalProperties: false }
);

export type UpdateFoodRequest = Static<typeof UpdateFoodRequestSchema>;

export const FoodRecordResponseSchema = Type.Object(
  {
    data: FoodRecordSchema,
  },
  { $id: "FoodRecordResponse", additionalProperties: false }
);

export type FoodRecordResponse = Static<typeof FoodRecordResponseSchema>;

export const FoodListResponseSchema = PaginatedEnvelope(FoodRecordSchema, {
  $id: "FoodListResponse",
});

export type FoodListResponse = Static<typeof FoodListResponseSchema>;

// ==========================================
// 5. Supplement Records
// ==========================================

export const SupplementRecordSchema = Type.Object(
  {
    id: UuidString,
    babyId: UuidString,
    familyId: UuidString,
    supplementName: Type.String({ minLength: 1, maxLength: 100 }),
    // Promoted legacy product IDs are source-stable strings and may predate
    // UUID enforcement; family/baby scope still comes from the session.
    productId: Nullable(Type.String({ minLength: 1, maxLength: 128 })),
    occurredAt: DateTimeString,
    amount: Nullable(Type.String()),
    dose: Nullable(DecimalString),
    unitName: Nullable(Type.String({ maxLength: 50 })),
    notes: Nullable(Type.String({ maxLength: 1000 })),
    recordedByUserId: Type.Optional(Nullable(UuidString)),
    version: BigIntString,
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
  },
  { $id: "SupplementRecord", additionalProperties: false }
);

export type SupplementRecord = Static<typeof SupplementRecordSchema>;

export const CreateSupplementRequestSchema = Type.Object(
  {
    supplementName: Type.String({ minLength: 1, maxLength: 100 }),
    productId: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 128 }))),
    occurredAt: DateTimeString,
    amount: Type.Optional(Nullable(Type.String())),
    dose: Type.Optional(Nullable(DecimalString)),
    unitName: Type.Optional(Nullable(Type.String({ maxLength: 50 }))),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  },
  { $id: "CreateSupplementRequest", additionalProperties: false }
);

export type CreateSupplementRequest = Static<typeof CreateSupplementRequestSchema>;

export const UpdateSupplementRequestSchema = Type.Object(
  {
    baseVersion: BigIntString,
    supplementName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    productId: Type.Optional(Nullable(Type.String({ minLength: 1, maxLength: 128 }))),
    occurredAt: Type.Optional(DateTimeString),
    amount: Type.Optional(Nullable(Type.String())),
    dose: Type.Optional(Nullable(DecimalString)),
    unitName: Type.Optional(Nullable(Type.String({ maxLength: 50 }))),
    notes: Type.Optional(Nullable(Type.String({ maxLength: 1000 }))),
  },
  { $id: "UpdateSupplementRequest", additionalProperties: false }
);

export type UpdateSupplementRequest = Static<typeof UpdateSupplementRequestSchema>;

export const SupplementRecordResponseSchema = Type.Object(
  {
    data: SupplementRecordSchema,
  },
  { $id: "SupplementRecordResponse", additionalProperties: false }
);

export type SupplementRecordResponse = Static<typeof SupplementRecordResponseSchema>;

export const SupplementListResponseSchema = PaginatedEnvelope(SupplementRecordSchema, {
  $id: "SupplementListResponse",
});

export type SupplementListResponse = Static<typeof SupplementListResponseSchema>;

// ==========================================
// 6. Timeline Entry & Responses
// ==========================================

export const TimelineEntityTypeSchema = Type.Union([
  Type.Literal("feeding"),
  Type.Literal("sleep"),
  Type.Literal("diaper"),
  Type.Literal("food"),
  Type.Literal("supplement"),
  Type.Literal("growth"),
  Type.Literal("medical"),
  Type.Literal("vaccine"),
]);

export type TimelineEntityType = Static<typeof TimelineEntityTypeSchema>;

export const TimelineEntrySchema = Type.Object(
  {
    id: UuidString,
    babyId: UuidString,
    entityType: TimelineEntityTypeSchema,
    entityId: UuidString,
    occurredAt: DateTimeString,
    summary: Type.String(),
    version: BigIntString,
  },
  { $id: "TimelineEntry", additionalProperties: false }
);

export type TimelineEntry = Static<typeof TimelineEntrySchema>;

export const TimelineResponseSchema = PaginatedEnvelope(TimelineEntrySchema, {
  $id: "TimelineResponse",
});

export type TimelineResponse = Static<typeof TimelineResponseSchema>;

// ==========================================
// 7. Discriminated Timeline Event Schemas (Compatible with Swift OpenAPI Generator)
// ==========================================

export const FeedingEventSchema = Type.Object(
  {
    kind: Type.Literal("feeding"),
    id: Type.String(),
    volumeMl: Type.Number(),
  },
  { $id: "FeedingEvent", additionalProperties: false }
);

export type FeedingEvent = Static<typeof FeedingEventSchema>;

export const DiaperEventSchema = Type.Object(
  {
    kind: Type.Literal("diaper"),
    id: Type.String(),
    wet: Type.Boolean(),
    dirty: Type.Boolean(),
  },
  { $id: "DiaperEvent", additionalProperties: false }
);

export type DiaperEvent = Static<typeof DiaperEventSchema>;

export const SleepEventSchema = Type.Object(
  {
    kind: Type.Literal("sleep"),
    id: Type.String(),
    durationMinutes: Type.Number(),
  },
  { $id: "SleepEvent", additionalProperties: false }
);

export type SleepEvent = Static<typeof SleepEventSchema>;

export const TimelineEventSchema = Type.Union(
  [FeedingEventSchema, DiaperEventSchema, SleepEventSchema],
  {
    $id: "TimelineEvent",
    discriminator: { propertyName: "kind" },
    description: "Discriminated union of timeline events",
  }
);

export type TimelineEvent = Static<typeof TimelineEventSchema>;

export const DeleteRecordResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        id: UuidString,
        deleted: Type.Literal(true),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "DeleteRecordResponse", additionalProperties: false }
);

export type DeleteRecordResponse = Static<typeof DeleteRecordResponseSchema>;

// Durable MCP/Web undo snapshots. The payload is intentionally opaque at the
// HTTP boundary; only the server may interpret it during a scoped restore.
export const RecordSnapshotEntityTypeSchema = Type.Union([
  Type.Literal("feeding"),
  Type.Literal("sleep"),
  Type.Literal("diaper"),
  Type.Literal("food"),
  Type.Literal("growth"),
  Type.Literal("medical_report"),
  Type.Literal("vaccine"),
  Type.Literal("food_plan"),
  Type.Literal("supplement"),
]);

export type RecordSnapshotEntityType = Static<typeof RecordSnapshotEntityTypeSchema>;

export const RecordSnapshotSchema = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 200 }),
    familyId: UuidString,
    babyId: UuidString,
    userId: Nullable(UuidString),
    source: Type.String(),
    sourceAgent: Nullable(Type.String()),
    action: Type.String(),
    entityType: RecordSnapshotEntityTypeSchema,
    entityId: Type.String({ minLength: 1 }),
    payload: Type.Unknown(),
    payloadHash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
    sourceSystem: Type.Optional(Nullable(Type.String())),
    sourceBatchId: Type.Optional(Nullable(Type.String({ pattern: "^[0-9a-f]{64}$" }))),
    sourceTable: Type.Optional(Nullable(Type.String())),
    sourceId: Type.Optional(Nullable(Type.String())),
    sourceHash: Type.Optional(Nullable(Type.String({ pattern: "^[0-9a-f]{64}$" }))),
    mappingVersion: Type.Optional(Nullable(Type.String())),
    restored: Type.Boolean(),
    restoredAt: Nullable(DateTimeString),
    createdAt: DateTimeString,
  },
  { $id: "RecordSnapshot", additionalProperties: false },
);

export type RecordSnapshot = Static<typeof RecordSnapshotSchema>;

export const RecordSnapshotListQuerySchema = Type.Object(
  {
    entityType: Type.Optional(RecordSnapshotEntityTypeSchema),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200, default: 50 })),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  },
  { $id: "RecordSnapshotListQuery", additionalProperties: false },
);

export type RecordSnapshotListQuery = Static<typeof RecordSnapshotListQuerySchema>;

export const RecordSnapshotDeleteRequestSchema = Type.Object(
  {
    baseVersion: Type.Optional(BigIntString),
  },
  { $id: "RecordSnapshotDeleteRequest", additionalProperties: false },
);

export type RecordSnapshotDeleteRequest = Static<typeof RecordSnapshotDeleteRequestSchema>;

export const RecordSnapshotDeleteResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        success: Type.Literal(true),
        id: Type.String(),
        deleted: Type.Literal(true),
        snapshotId: Type.String(),
        entityType: RecordSnapshotEntityTypeSchema,
        version: BigIntString,
      },
      { additionalProperties: false },
    ),
  },
  { $id: "RecordSnapshotDeleteResponse", additionalProperties: false },
);

export type RecordSnapshotDeleteResponse = Static<typeof RecordSnapshotDeleteResponseSchema>;

export const RecordSnapshotRestoreRequestSchema = Type.Object(
  {
    snapshotId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    entityType: Type.Optional(RecordSnapshotEntityTypeSchema),
  },
  { $id: "RecordSnapshotRestoreRequest", additionalProperties: false },
);

export type RecordSnapshotRestoreRequest = Static<typeof RecordSnapshotRestoreRequestSchema>;

export const RecordSnapshotRestoreResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        success: Type.Literal(true),
        snapshotId: Type.String(),
        restoredId: Type.String(),
        entityType: RecordSnapshotEntityTypeSchema,
        version: Type.Optional(BigIntString),
        replayed: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
  },
  { $id: "RecordSnapshotRestoreResponse", additionalProperties: false },
);

export type RecordSnapshotRestoreResponse = Static<typeof RecordSnapshotRestoreResponseSchema>;

export const RecordSnapshotListResponseSchema = PaginatedEnvelope(RecordSnapshotSchema, {
  $id: "RecordSnapshotListResponse",
});

export type RecordSnapshotListResponse = Static<typeof RecordSnapshotListResponseSchema>;
