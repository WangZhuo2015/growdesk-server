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
