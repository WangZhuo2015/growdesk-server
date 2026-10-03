import { Type, type Static } from "@sinclair/typebox";
import {
  Nullable,
  DateTimeString,
  BigIntString,
  UuidString,
} from "./common.js";

// ==========================================
// 1. Sync Commands (Offline Mutation Queue)
// ==========================================

export const SyncCommandEntityTypeSchema = Type.Union([
  Type.Literal("feeding"),
  Type.Literal("sleep"),
  Type.Literal("diaper"),
  Type.Literal("foodLog"),
  Type.Literal("supplementRecord"),
  Type.Literal("growthMeasurement"),
]);

export type SyncCommandEntityType = Static<typeof SyncCommandEntityTypeSchema>;

export const SyncCommandOperationSchema = Type.Union([
  Type.Literal("create"),
  Type.Literal("update"),
  Type.Literal("delete"),
  Type.Literal("restore"),
]);

export type SyncCommandOperation = Static<typeof SyncCommandOperationSchema>;

export const SyncCommandSchema = Type.Object(
  {
    commandId: UuidString,
    familyId: UuidString,
    babyId: UuidString,
    entityType: SyncCommandEntityTypeSchema,
    entityId: UuidString,
    operation: SyncCommandOperationSchema,
    baseVersion: Nullable(BigIntString),
    clientCreatedAt: DateTimeString,
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { $id: "SyncCommand", additionalProperties: false }
);

export type SyncCommand = Static<typeof SyncCommandSchema>;

export const SyncCommandBatchRequestSchema = Type.Object(
  {
    commands: Type.Array(SyncCommandSchema, { minItems: 1, maxItems: 50 }),
  },
  { $id: "SyncCommandBatchRequest", additionalProperties: false }
);

export type SyncCommandBatchRequest = Static<typeof SyncCommandBatchRequestSchema>;

export const SyncCommandStatusSchema = Type.Union([
  Type.Literal("applied"),
  Type.Literal("conflict"),
  Type.Literal("error"),
  Type.Literal("replayed"),
]);

export type SyncCommandStatus = Static<typeof SyncCommandStatusSchema>;

export const SyncCommandResultItemSchema = Type.Object(
  {
    commandId: UuidString,
    status: SyncCommandStatusSchema,
    entityId: UuidString,
    version: Nullable(BigIntString),
    familyCursor: Nullable(BigIntString),
    conflict: Type.Optional(
      Type.Object(
        {
          currentVersion: BigIntString,
          currentEntity: Type.Unknown(),
          reason: Type.String(),
        },
        { additionalProperties: false }
      )
    ),
    error: Type.Optional(
      Type.Object(
        {
          code: Type.String(),
          message: Type.String(),
        },
        { additionalProperties: false }
      )
    ),
  },
  { $id: "SyncCommandResultItem", additionalProperties: false }
);

export type SyncCommandResultItem = Static<typeof SyncCommandResultItemSchema>;

export const SyncCommandBatchResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        results: Type.Array(SyncCommandResultItemSchema),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "SyncCommandBatchResponse", additionalProperties: false }
);

export type SyncCommandBatchResponse = Static<typeof SyncCommandBatchResponseSchema>;

// Device-bound offline sync is opt-in. Enrollment never accepts a client
// supplied status or generation; both are assigned by the server.
export const DeviceSyncBindingStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("revoked"),
]);

export const DeviceSyncBindingSchema = Type.Object(
  {
    id: UuidString,
    userId: UuidString,
    installationId: Type.String({ minLength: 1, maxLength: 128 }),
    localVaultId: Type.String({ minLength: 1, maxLength: 128 }),
    familyId: UuidString,
    status: DeviceSyncBindingStatusSchema,
    generation: BigIntString,
    consentVersion: Type.String({ minLength: 1, maxLength: 64 }),
    createdAt: DateTimeString,
    updatedAt: DateTimeString,
    activatedAt: Nullable(DateTimeString),
  },
  { $id: "DeviceSyncBinding", additionalProperties: false }
);

export type DeviceSyncBinding = Static<typeof DeviceSyncBindingSchema>;

export const DeviceSyncBindingEnrollmentRequestSchema = Type.Object(
  {
    installationId: Type.String({ minLength: 1, maxLength: 128 }),
    localVaultId: Type.String({ minLength: 1, maxLength: 128 }),
    familyId: UuidString,
    consentVersion: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { $id: "DeviceSyncBindingEnrollmentRequest", additionalProperties: false }
);

export type DeviceSyncBindingEnrollmentRequest = Static<typeof DeviceSyncBindingEnrollmentRequestSchema>;

export const DeviceSyncBindingResponseSchema = Type.Object(
  { data: DeviceSyncBindingSchema },
  { $id: "DeviceSyncBindingResponse", additionalProperties: false }
);

export const DeviceSyncBindingListResponseSchema = Type.Object(
  { data: Type.Array(DeviceSyncBindingSchema, { maxItems: 500 }) },
  { $id: "DeviceSyncBindingListResponse", additionalProperties: false }
);

export const DeviceSyncBindingGenerationRequestSchema = Type.Object(
  { generation: BigIntString },
  { $id: "DeviceSyncBindingGenerationRequest", additionalProperties: false }
);

export type DeviceSyncBindingGenerationRequest = Static<typeof DeviceSyncBindingGenerationRequestSchema>;

export const DeviceSyncImportChunkDescriptorSchema = Type.Object(
  {
    chunkId: UuidString,
    index: Type.Integer({ minimum: 0, maximum: 9999 }),
    requestHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    itemCount: Type.Integer({ minimum: 1, maximum: 50 }),
  },
  { $id: "DeviceSyncImportChunkDescriptor", additionalProperties: false }
);

export const DeviceSyncImportPlanRequestSchema = Type.Object(
  {
    importId: UuidString,
    generation: BigIntString,
    consentVersion: Type.String({ minLength: 1, maxLength: 64 }),
    manifestHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    chunks: Type.Array(DeviceSyncImportChunkDescriptorSchema, { maxItems: 10000 }),
  },
  { $id: "DeviceSyncImportPlanRequest", additionalProperties: false }
);

export type DeviceSyncImportPlanRequest = Static<typeof DeviceSyncImportPlanRequestSchema>;

export const DeviceSyncImportChunkRequestSchema = Type.Object(
  {
    chunkId: UuidString,
    commands: Type.Array(SyncCommandSchema, { minItems: 1, maxItems: 50 }),
  },
  { $id: "DeviceSyncImportChunkRequest", additionalProperties: false }
);

export type DeviceSyncImportChunkRequest = Static<typeof DeviceSyncImportChunkRequestSchema>;

export const DeviceSyncImportChunkStateSchema = Type.Object(
  {
    chunkId: UuidString,
    index: Type.Integer({ minimum: 0, maximum: 9999 }),
    requestHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    itemCount: Type.Integer({ minimum: 1, maximum: 50 }),
    status: Type.Union([Type.Literal("pending"), Type.Literal("applied")]),
  },
  { $id: "DeviceSyncImportChunkState", additionalProperties: false }
);

export const DeviceSyncImportPlanSchema = Type.Object(
  {
    id: UuidString,
    bindingId: UuidString,
    generation: BigIntString,
    consentVersion: Type.String({ minLength: 1, maxLength: 64 }),
    manifestHash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    status: Type.Union([Type.Literal("pending"), Type.Literal("activated")]),
    chunks: Type.Array(DeviceSyncImportChunkStateSchema, { maxItems: 10000 }),
    createdAt: DateTimeString,
    activatedAt: Nullable(DateTimeString),
    activatedGeneration: Nullable(BigIntString),
  },
  { $id: "DeviceSyncImportPlan", additionalProperties: false }
);

export const DeviceSyncImportPlanResponseSchema = Type.Object(
  { data: DeviceSyncImportPlanSchema },
  { $id: "DeviceSyncImportPlanResponse", additionalProperties: false }
);

export const DeviceSyncImportChunkResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        importId: UuidString,
        chunkId: UuidString,
        status: Type.Union([Type.Literal("applied"), Type.Literal("replayed")]),
        results: Type.Array(SyncCommandResultItemSchema, { minItems: 1, maxItems: 50 }),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "DeviceSyncImportChunkResponse", additionalProperties: false }
);

export type DeviceSyncImportChunkResponse = Static<typeof DeviceSyncImportChunkResponseSchema>;

// ==========================================
// 2. Incremental Change Feed
// ==========================================

export const SyncChangeItemSchema = Type.Object(
  {
    cursor: BigIntString,
    entityType: Type.String(),
    entityId: UuidString,
    version: BigIntString,
    operation: Type.Union([Type.Literal("upsert"), Type.Literal("delete")]),
    payload: Type.Record(Type.String(), Type.Unknown()),
  },
  { $id: "SyncChangeItem", additionalProperties: false }
);

export type SyncChangeItem = Static<typeof SyncChangeItemSchema>;

export const FamilyChangesResponseSchema = Type.Object(
  {
    scope: Type.Literal("family"),
    epoch: UuidString,
    changes: Type.Array(SyncChangeItemSchema),
    nextCursor: Type.String(),
    highWater: BigIntString,
    hasMore: Type.Boolean(),
  },
  { $id: "FamilyChangesResponse", additionalProperties: false }
);

export type FamilyChangesResponse = Static<typeof FamilyChangesResponseSchema>;

export const UserChangesResponseSchema = Type.Object(
  {
    scope: Type.Literal("user"),
    epoch: UuidString,
    changes: Type.Array(SyncChangeItemSchema),
    nextCursor: Type.String(),
    highWater: BigIntString,
    hasMore: Type.Boolean(),
  },
  { $id: "UserChangesResponse", additionalProperties: false }
);

export type UserChangesResponse = Static<typeof UserChangesResponseSchema>;

// ==========================================
// 3. Sync Snapshots (Bootstrap)
// ==========================================

export const CreateSyncSnapshotResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        snapshotId: UuidString,
        status: Type.Literal("queued"),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "CreateSyncSnapshotResponse", additionalProperties: false }
);

export type CreateSyncSnapshotResponse = Static<typeof CreateSyncSnapshotResponseSchema>;

const SyncSnapshotMetadataProperties = {
  id: UuidString,
  scope: Type.String(),
  epoch: UuidString,
  highWater: BigIntString,
  pageCount: Type.Integer({ minimum: 0 }),
  expiresAt: DateTimeString,
};

export const SyncSnapshotSchema = Type.Union(
  [
    Type.Object(
      {
        ...SyncSnapshotMetadataProperties,
        status: Type.Literal("ready"),
        nextCursor: Type.String({ minLength: 1 }),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        ...SyncSnapshotMetadataProperties,
        status: Type.Union([
          Type.Literal("queued"),
          Type.Literal("processing"),
          Type.Literal("failed"),
        ]),
      },
      { additionalProperties: false }
    ),
  ],
  { $id: "SyncSnapshot" }
);

export type SyncSnapshot = Static<typeof SyncSnapshotSchema>;

export const SyncSnapshotResponseSchema = Type.Object(
  {
    data: SyncSnapshotSchema,
  },
  { $id: "SyncSnapshotResponse", additionalProperties: false }
);

export type SyncSnapshotResponse = Static<typeof SyncSnapshotResponseSchema>;

export const SyncSnapshotPageContentSchema = Type.Object(
  {
    entityType: Type.String(),
    data: Type.Array(Type.Record(Type.String(), Type.Unknown())),
  },
  { $id: "SyncSnapshotPageContent", additionalProperties: false }
);

export const SyncSnapshotPageResponseSchema = Type.Object(
  {
    data: Type.Object(
      {
        snapshotId: UuidString,
        page: Type.Integer({ minimum: 0 }),
        pageCount: Type.Integer({ minimum: 1 }),
        highWater: BigIntString,
        content: SyncSnapshotPageContentSchema,
        contentJSON: Type.String(),
        sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
      },
      { additionalProperties: false }
    ),
  },
  { $id: "SyncSnapshotPageResponse", additionalProperties: false }
);

export type SyncSnapshotPageResponse = Static<typeof SyncSnapshotPageResponseSchema>;
