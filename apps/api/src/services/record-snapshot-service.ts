import crypto from "node:crypto";
import type { PrismaClient, Prisma } from "@growdesk/database";
import {
  BabyAccessDeniedError,
  ConcurrencyConflictError,
  DatabaseError,
  FamilyAccessDeniedError,
  RecordNotFoundError,
} from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import type {
  RecordSnapshot,
  RecordSnapshotEntityType,
  RecordSnapshotListQuery,
} from "@growdesk/contracts";

export const RECORD_SNAPSHOT_ENTITY_TYPES: readonly RecordSnapshotEntityType[] = [
  "feeding",
  "sleep",
  "diaper",
  "food",
  "growth",
  "medical_report",
  "vaccine",
  "food_plan",
  "supplement",
];

type TransactionClient = Prisma.TransactionClient;

type SnapshotTarget = {
  id: string;
  familyId: string;
  babyId: string;
  deletedAt?: Date | null;
  version: number | bigint;
  [key: string]: unknown;
};

type DeleteResult = {
  success: true;
  id: string;
  deleted: true;
  snapshotId: string;
  entityType: RecordSnapshotEntityType;
  version: string;
};

type RestoreResult = {
  success: true;
  snapshotId: string;
  restoredId: string;
  entityType: RecordSnapshotEntityType;
  version?: string;
  replayed?: boolean;
};

type SnapshotSource = {
  source?: string;
  sourceAgent?: string | null;
};

function unsupported(entityType: string): never {
  throw new DatabaseError(
    `Record snapshot type is not safely supported by the canonical backend: ${entityType}`,
    "UNSUPPORTED_SNAPSHOT_ENTITY",
    422,
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
  return `{${entries.join(",")}}`;
}

function hashJson(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function jsonSafe(value: unknown): Prisma.JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new DatabaseError("Snapshot contains a non-finite number", "SNAPSHOT_INVALID_PAYLOAD", 500);
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item));

  const objectValue = value as { toJSON?: () => unknown; constructor?: { name?: string } };
  if (objectValue.constructor?.name === "Decimal" && typeof objectValue.toJSON === "function") {
    return jsonSafe(objectValue.toJSON());
  }

  const output: Record<string, Prisma.JsonValue> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item !== undefined) output[key] = jsonSafe(item);
  }
  return output;
}

function asTarget(row: unknown): SnapshotTarget | null {
  return row === null || row === undefined ? null : row as SnapshotTarget;
}

function restoreComparable(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(restoreComparable);
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "deletedAt" || key === "updatedAt" || key === "version" || key === "restoredAt") continue;
    result[key] = restoreComparable(item);
  }
  return result;
}

function parseFoodPlanSnapshot(
  payload: Prisma.JsonValue,
  familyId: string,
  babyId: string,
  entityId: string,
): { id: string; familyId: string; babyId: string; planData: Prisma.InputJsonValue; version: bigint; createdAt: Date; updatedAt: Date } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DatabaseError("Food plan snapshot payload is invalid", "SNAPSHOT_INVALID_PAYLOAD", 409);
  }
  const row = payload as Record<string, unknown>;
  if (row.id !== entityId || row.familyId !== familyId || row.babyId !== babyId || row.planData === undefined) {
    throw new DatabaseError("Food plan snapshot scope or payload is invalid", "SNAPSHOT_INVALID_PAYLOAD", 409);
  }
  const versionText = typeof row.version === "string" || typeof row.version === "number" ? String(row.version) : "";
  if (!/^[0-9]+$/.test(versionText)) throw new DatabaseError("Food plan snapshot version is invalid", "SNAPSHOT_INVALID_PAYLOAD", 409);
  const createdAt = new Date(typeof row.createdAt === "string" ? row.createdAt : "");
  const updatedAt = new Date(typeof row.updatedAt === "string" ? row.updatedAt : "");
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime()) || updatedAt < createdAt) {
    throw new DatabaseError("Food plan snapshot timestamps are invalid", "SNAPSHOT_INVALID_PAYLOAD", 409);
  }
  return {
    id: entityId,
    familyId,
    babyId,
    planData: row.planData as Prisma.InputJsonValue,
    version: BigInt(versionText),
    createdAt,
    updatedAt,
  };
}

function timelineEntityType(entityType: RecordSnapshotEntityType): string {
  return entityType === "medical_report" ? "medical" : entityType;
}

async function lockFamilyState(tx: TransactionClient, familyId: string): Promise<bigint> {
  await tx.$executeRaw`
    INSERT INTO public.family_sync_states (family_id, epoch, cursor, created_at, updated_at)
    VALUES (${familyId}, ${crypto.randomUUID()}, 0, NOW(), NOW())
    ON CONFLICT (family_id) DO NOTHING
  `;
  const rows = await tx.$queryRaw<Array<{ cursor: bigint }>>`
    SELECT cursor FROM public.family_sync_states WHERE family_id = ${familyId} FOR UPDATE
  `;
  return rows[0]?.cursor ?? 0n;
}

async function assertBabyScope(
  tx: TransactionClient,
  principal: UserPrincipal,
  babyId: string,
  requireWrite: boolean,
): Promise<string> {
  const baby = await tx.baby.findUnique({
    where: { id: babyId },
    select: { familyId: true, deletedAt: true },
  });
  if (!baby || baby.deletedAt !== null) throw new BabyAccessDeniedError(babyId, "BABY_NOT_FOUND");

  const familyMember = await tx.familyMember.findUnique({
    where: {
      uq_family_members_family_user: {
        familyId: baby.familyId,
        userId: principal.userId,
      },
    },
    select: { status: true, role: true, deletedAt: true },
  });
  if (!familyMember || familyMember.status !== "active" || familyMember.deletedAt !== null) {
    throw new FamilyAccessDeniedError(baby.familyId);
  }
  if (requireWrite && familyMember.role === "viewer") throw new FamilyAccessDeniedError(baby.familyId);

  const babyMember = await tx.babyMember.findUnique({
    where: {
      uq_baby_members_user_baby: {
        userId: principal.userId,
        babyId,
      },
    },
    select: { familyId: true, status: true, role: true, deletedAt: true },
  });
  if (
    !babyMember ||
    babyMember.familyId !== baby.familyId ||
    babyMember.status !== "active" ||
    babyMember.deletedAt !== null ||
    (requireWrite && babyMember.role === "viewer")
  ) {
    throw new BabyAccessDeniedError(babyId, requireWrite ? "BABY_WRITE_DENIED" : "BABY_ACCESS_DENIED");
  }
  return baby.familyId;
}

async function lockTarget(tx: TransactionClient, entityType: RecordSnapshotEntityType, entityId: string, familyId: string, babyId: string): Promise<void> {
  switch (entityType) {
    case "feeding":
      await tx.$queryRaw`SELECT id FROM public.feeding_records WHERE id = ${entityId} AND family_id = ${familyId} AND baby_id = ${babyId} FOR UPDATE`;
      return;
    case "sleep":
      await tx.$queryRaw`SELECT id FROM public.sleep_records WHERE id = ${entityId} AND family_id = ${familyId} AND baby_id = ${babyId} FOR UPDATE`;
      return;
    case "diaper":
      await tx.$queryRaw`SELECT id FROM public.diaper_records WHERE id = ${entityId} AND family_id = ${familyId} AND baby_id = ${babyId} FOR UPDATE`;
      return;
    case "food":
      await tx.$queryRaw`SELECT id FROM public.food_records WHERE id = ${entityId} AND family_id = ${familyId} AND baby_id = ${babyId} FOR UPDATE`;
      return;
    case "growth":
      await tx.$queryRaw`SELECT id FROM public.growth_measurements WHERE id = ${entityId} AND family_id = ${familyId} AND baby_id = ${babyId} FOR UPDATE`;
      return;
    case "medical_report":
      await tx.$queryRaw`SELECT id FROM public.medical_reports WHERE id = ${entityId} AND family_id = ${familyId} AND baby_id = ${babyId} FOR UPDATE`;
      return;
    case "vaccine":
      await tx.$queryRaw`SELECT id FROM public.vaccine_records WHERE id = ${entityId} AND family_id = ${familyId} AND baby_id = ${babyId} FOR UPDATE`;
      return;
    case "supplement":
      await tx.$queryRaw`SELECT id FROM public.supplement_records WHERE id = ${entityId} AND family_id = ${familyId} AND baby_id = ${babyId} FOR UPDATE`;
      return;
    case "food_plan":
      await tx.$queryRaw`SELECT id FROM public.baby_food_plans WHERE id = ${entityId} AND family_id = ${familyId} AND baby_id = ${babyId} FOR UPDATE`;
      return;
  }
}

async function findTarget(tx: TransactionClient, entityType: RecordSnapshotEntityType, entityId: string, familyId: string, babyId: string): Promise<SnapshotTarget | null> {
  switch (entityType) {
    case "feeding":
      return asTarget(await tx.feedingRecord.findFirst({ where: { id: entityId, familyId, babyId } }));
    case "sleep":
      return asTarget(await tx.sleepRecord.findFirst({ where: { id: entityId, familyId, babyId } }));
    case "diaper":
      return asTarget(await tx.diaperRecord.findFirst({ where: { id: entityId, familyId, babyId } }));
    case "food":
      return asTarget(await tx.foodRecord.findFirst({ where: { id: entityId, familyId, babyId } }));
    case "growth":
      return asTarget(await tx.growthMeasurement.findFirst({ where: { id: entityId, familyId, babyId } }));
    case "medical_report":
      return asTarget(await tx.medicalReport.findFirst({ where: { id: entityId, familyId, babyId } }));
    case "vaccine":
      return asTarget(await tx.vaccineRecord.findFirst({ where: { id: entityId, familyId, babyId } }));
    case "supplement":
      return asTarget(await tx.supplementRecord.findFirst({ where: { id: entityId, familyId, babyId } }));
    case "food_plan":
      return asTarget(await tx.babyFoodPlan.findFirst({ where: { id: entityId, familyId, babyId } }));
  }
}

async function markDeleted(tx: TransactionClient, entityType: RecordSnapshotEntityType, entityId: string, at: Date): Promise<SnapshotTarget> {
  const data = { deletedAt: at, updatedAt: at, version: { increment: 1 } };
  switch (entityType) {
    case "feeding": return asTarget(await tx.feedingRecord.update({ where: { id: entityId }, data }))!;
    case "sleep": return asTarget(await tx.sleepRecord.update({ where: { id: entityId }, data }))!;
    case "diaper": return asTarget(await tx.diaperRecord.update({ where: { id: entityId }, data }))!;
    case "food": return asTarget(await tx.foodRecord.update({ where: { id: entityId }, data }))!;
    case "growth": return asTarget(await tx.growthMeasurement.update({ where: { id: entityId }, data }))!;
    case "medical_report": return asTarget(await tx.medicalReport.update({ where: { id: entityId }, data }))!;
    case "vaccine": return asTarget(await tx.vaccineRecord.update({ where: { id: entityId }, data }))!;
    case "supplement": return asTarget(await tx.supplementRecord.update({ where: { id: entityId }, data }))!;
    case "food_plan": unsupported(entityType);
  }
}

async function clearDeleted(tx: TransactionClient, entityType: RecordSnapshotEntityType, entityId: string, at: Date): Promise<SnapshotTarget> {
  const data = { deletedAt: null, updatedAt: at, version: { increment: 1 } };
  switch (entityType) {
    case "feeding": return asTarget(await tx.feedingRecord.update({ where: { id: entityId }, data }))!;
    case "sleep": return asTarget(await tx.sleepRecord.update({ where: { id: entityId }, data }))!;
    case "diaper": return asTarget(await tx.diaperRecord.update({ where: { id: entityId }, data }))!;
    case "food": return asTarget(await tx.foodRecord.update({ where: { id: entityId }, data }))!;
    case "growth": return asTarget(await tx.growthMeasurement.update({ where: { id: entityId }, data }))!;
    case "medical_report": return asTarget(await tx.medicalReport.update({ where: { id: entityId }, data }))!;
    case "vaccine": return asTarget(await tx.vaccineRecord.update({ where: { id: entityId }, data }))!;
    case "supplement": return asTarget(await tx.supplementRecord.update({ where: { id: entityId }, data }))!;
    case "food_plan": unsupported(entityType);
  }
}

function mapSnapshot(row: {
  id: string;
  familyId: string;
  babyId: string;
  userId: string | null;
  source: string;
  sourceAgent: string | null;
  action: string;
  entityType: string;
  entityId: string;
  payload: Prisma.JsonValue;
  payloadHash: string;
  sourceSystem: string | null;
  sourceBatchId: string | null;
  sourceTable: string | null;
  sourceId: string | null;
  sourceHash: string | null;
  mappingVersion: string | null;
  restored: boolean;
  restoredAt: Date | null;
  createdAt: Date;
}): RecordSnapshot {
  return {
    id: row.id,
    familyId: row.familyId,
    babyId: row.babyId,
    userId: row.userId,
    source: row.source,
    sourceAgent: row.sourceAgent,
    action: row.action,
    entityType: row.entityType as RecordSnapshotEntityType,
    entityId: row.entityId,
    payload: row.payload,
    payloadHash: row.payloadHash,
    sourceSystem: row.sourceSystem,
    sourceBatchId: row.sourceBatchId,
    sourceTable: row.sourceTable,
    sourceId: row.sourceId,
    sourceHash: row.sourceHash,
    mappingVersion: row.mappingVersion,
    restored: row.restored,
    restoredAt: row.restoredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export class RecordSnapshotService {
  constructor(private readonly prisma: PrismaClient) {}

  async deleteWithSnapshot(
    principal: UserPrincipal,
    babyId: string,
    entityType: RecordSnapshotEntityType,
    entityId: string,
    baseVersion?: number,
    idempotencyKey?: string,
    source: SnapshotSource = {},
  ): Promise<DeleteResult> {
    const familyId = await this.prisma.$transaction(async (tx) => {
      const scopeFamilyId = await assertBabyScope(tx, principal, babyId, true);
      const currentCursor = await lockFamilyState(tx, scopeFamilyId);
      const requestHash = hashJson({ operation: "delete_with_snapshot", familyId: scopeFamilyId, babyId, entityType, entityId, baseVersion: baseVersion ?? null });
      if (idempotencyKey) {
        const receipt = await tx.idempotencyReceipt.findUnique({ where: { pk_idempotency_receipts: { actorId: principal.userId, scopeId: scopeFamilyId, commandId: idempotencyKey } } });
        if (receipt) {
          if (receipt.requestHash !== requestHash) throw new DatabaseError("Idempotency key reused with a different snapshot delete", "IDEMPOTENCY_KEY_REUSED", 409);
          return receipt.responseBody as DeleteResult;
        }
      }

      await lockTarget(tx, entityType, entityId, scopeFamilyId, babyId);
      const existing = await findTarget(tx, entityType, entityId, scopeFamilyId, babyId);
      if (!existing || (existing.deletedAt !== undefined && existing.deletedAt !== null)) throw new RecordNotFoundError(entityType, entityId);
      if (baseVersion !== undefined && Number(existing.version) !== baseVersion) {
        throw new ConcurrencyConflictError(`Version conflict on ${entityType}:${entityId}`);
      }

      const now = new Date();
      const payload = jsonSafe(existing);
      const payloadHash = hashJson(payload);
      const snapshotId = crypto.randomUUID();
      await tx.recordSnapshot.create({
        data: {
          id: snapshotId,
          familyId: scopeFamilyId,
          babyId,
          userId: principal.userId,
          source: source.source ?? "mcp",
          sourceAgent: source.sourceAgent ?? null,
          action: "delete",
          entityType,
          entityId,
          payload: payload as Prisma.InputJsonValue,
          payloadHash,
          restored: false,
          createdAt: now,
        },
      });

      // BabyFoodPlan has no tombstone columns and is unique per baby.  Its
      // canonical delete is a physical delete inside the same transaction as
      // the snapshot; restore will recreate the exact row only when the slot
      // is still empty.
      const deleted = entityType === "food_plan"
        ? asTarget(await tx.babyFoodPlan.delete({ where: { id: entityId } }))!
        : await markDeleted(tx, entityType, entityId, now);
      await tx.timelineEntry.updateMany({
        where: { familyId: scopeFamilyId, babyId, entityType: timelineEntityType(entityType), entityId },
        data: { deletedAt: now, version: { increment: 1 }, updatedAt: now },
      });
      const result: DeleteResult = {
        success: true,
        id: entityId,
        deleted: true,
        snapshotId,
        entityType,
        version: String(deleted.version),
      };
      const nextCursor = currentCursor + 1n;
      await tx.familySyncState.update({ where: { familyId: scopeFamilyId }, data: { cursor: nextCursor, updatedAt: now } });
      await tx.familyChange.create({
        data: {
          familyId: scopeFamilyId,
          cursor: nextCursor,
          entityType: timelineEntityType(entityType),
          entityId,
          version: Number(deleted.version),
          op: "delete",
          payload: { id: entityId, babyId, snapshotId },
          schemaVersion: 1,
          createdAt: now,
        },
      });
      if (idempotencyKey) {
        await tx.idempotencyReceipt.create({
          data: {
            actorId: principal.userId,
            scopeId: scopeFamilyId,
            commandId: idempotencyKey,
            requestHash,
            resultCode: 200,
            resultSummary: { version: Number(deleted.version), familyCursor: nextCursor.toString() },
            responseBody: result,
            completedAt: now,
          },
        });
      }
      return result;
    });
    return familyId;
  }

  async listSnapshots(
    principal: UserPrincipal,
    babyId: string,
    query: RecordSnapshotListQuery = {},
  ): Promise<{ data: RecordSnapshot[]; page: { nextCursor: string | null } }> {
    const familyId = await this.prisma.$transaction((tx) => assertBabyScope(tx, principal, babyId, false));
    const limit = Math.min(query.limit ?? 50, 200);
    let cursorWhere: { OR: Array<{ createdAt: { lt: Date } } | { createdAt: Date; id: { lt: string } }> } | undefined;
    if (query.cursor) {
      let decoded: string;
      try {
        decoded = Buffer.from(query.cursor, "base64url").toString("utf8");
      } catch {
        throw new DatabaseError("Invalid record snapshot cursor", "INVALID_CURSOR", 400);
      }
      const separator = decoded.lastIndexOf("|");
      const createdAtText = separator > 0 ? decoded.slice(0, separator) : "";
      const cursorId = separator > 0 ? decoded.slice(separator + 1) : "";
      const createdAt = new Date(createdAtText);
      if (!cursorId || Number.isNaN(createdAt.getTime())) {
        throw new DatabaseError("Invalid record snapshot cursor", "INVALID_CURSOR", 400);
      }
      cursorWhere = { OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: cursorId } }] };
    }
    const rows = await this.prisma.recordSnapshot.findMany({
      where: { familyId, babyId, ...(query.entityType ? { entityType: query.entityType } : {}), ...cursorWhere },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const pageRows = rows.length > limit ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    return {
      data: pageRows.map(mapSnapshot),
      page: { nextCursor: rows.length > limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString("base64url") : null },
    };
  }

  async getSnapshot(principal: UserPrincipal, babyId: string, snapshotId: string): Promise<RecordSnapshot> {
    const familyId = await this.prisma.$transaction((tx) => assertBabyScope(tx, principal, babyId, false));
    const row = await this.prisma.recordSnapshot.findFirst({ where: { id: snapshotId, familyId, babyId } });
    if (!row) throw new RecordNotFoundError("record_snapshot", snapshotId);
    return mapSnapshot(row);
  }

  async restore(
    principal: UserPrincipal,
    babyId: string,
    options: { snapshotId?: string; entityType?: RecordSnapshotEntityType },
  ): Promise<RestoreResult> {
    return await this.prisma.$transaction(async (tx) => {
      const familyId = await assertBabyScope(tx, principal, babyId, true);
      const currentCursor = await lockFamilyState(tx, familyId);
      let snapshot = options.snapshotId
        ? await tx.recordSnapshot.findFirst({ where: { id: options.snapshotId, familyId, babyId } })
        : await tx.recordSnapshot.findFirst({ where: { familyId, babyId, action: "delete", restored: false, ...(options.entityType ? { entityType: options.entityType } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      if (!snapshot) throw new RecordNotFoundError("record_snapshot", options.snapshotId ?? "latest");

      // Serialize explicit replays on the snapshot itself. A concurrent
      // restore may complete while this transaction waits, so re-read after
      // acquiring the row lock before deciding whether this is a replay.
      await tx.$queryRaw`
        SELECT id FROM public.record_snapshots
        WHERE id = ${snapshot.id} AND family_id = ${familyId} AND baby_id = ${babyId}
        FOR UPDATE
      `;
      snapshot = await tx.recordSnapshot.findFirst({ where: { id: snapshot.id, familyId, babyId } });
      if (!snapshot) throw new RecordNotFoundError("record_snapshot", options.snapshotId ?? "latest");
      if (snapshot.action !== "delete") throw new DatabaseError("Only delete snapshots can be restored", "UNSUPPORTED_SNAPSHOT_ACTION", 422);
      if (!RECORD_SNAPSHOT_ENTITY_TYPES.includes(snapshot.entityType as RecordSnapshotEntityType)) unsupported(snapshot.entityType);

      const payload = jsonSafe(snapshot.payload);
      if (hashJson(payload) !== snapshot.payloadHash) throw new DatabaseError("Snapshot payload integrity check failed", "SNAPSHOT_TAMPERED", 409);
      if (snapshot.restored) {
        return { success: true, snapshotId: snapshot.id, restoredId: snapshot.entityId, entityType: snapshot.entityType as RecordSnapshotEntityType, replayed: true };
      }

      const entityType = snapshot.entityType as RecordSnapshotEntityType;
      await lockTarget(tx, entityType, snapshot.entityId, familyId, babyId);
      const current = await findTarget(tx, entityType, snapshot.entityId, familyId, babyId);
      if (entityType === "food_plan") {
        // There is no tombstone column on BabyFoodPlan.  Lock the parent baby
        // row so an absent unique slot cannot race a concurrent restore/save.
        await tx.$queryRaw`SELECT id FROM public.babies WHERE id = ${babyId} AND family_id = ${familyId} FOR UPDATE`;
        if (current) throw new ConcurrencyConflictError(`Cannot restore ${entityType}:${snapshot.entityId}; the row is active`);
      } else {
        if (!current) throw new RecordNotFoundError(entityType, snapshot.entityId);
        if (current.deletedAt === null) throw new ConcurrencyConflictError(`Cannot restore ${entityType}:${snapshot.entityId}; the row is active`);

        const currentPayload = jsonSafe(current);
        if (canonicalJson(restoreComparable(currentPayload)) !== canonicalJson(restoreComparable(payload))) {
          throw new ConcurrencyConflictError(`Cannot restore ${entityType}:${snapshot.entityId}; the row no longer matches its snapshot`);
        }
      }

      const now = new Date();
      const restored = entityType === "food_plan"
        ? asTarget(await tx.babyFoodPlan.create({ data: parseFoodPlanSnapshot(payload, familyId, babyId, snapshot.entityId) }))!
        : await clearDeleted(tx, entityType, snapshot.entityId, now);
      await tx.timelineEntry.updateMany({
        where: { familyId, babyId, entityType: timelineEntityType(entityType), entityId: snapshot.entityId },
        data: { deletedAt: null, version: { increment: 1 }, updatedAt: now },
      });
      const nextCursor = currentCursor + 1n;
      await tx.familySyncState.update({ where: { familyId }, data: { cursor: nextCursor, updatedAt: now } });
      await tx.familyChange.create({
        data: {
          familyId,
          cursor: nextCursor,
          entityType: timelineEntityType(entityType),
          entityId: snapshot.entityId,
          version: Number(restored.version),
          op: "upsert",
          payload: { id: snapshot.entityId, babyId, snapshotId: snapshot.id, restored: true },
          schemaVersion: 1,
          createdAt: now,
        },
      });
      await tx.recordSnapshot.update({ where: { id: snapshot.id }, data: { restored: true, restoredAt: now } });
      return {
        success: true,
        snapshotId: snapshot.id,
        restoredId: snapshot.entityId,
        entityType,
        version: String(restored.version),
      };
    });
  }
}
