import type { PrismaClient } from "@growdesk/database";
import {
  ScopedSleepRepository,
  type SleepRecordEntity,
  RecordNotFoundError,
  BabyAccessDeniedError,
} from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import type {
  CreateSleepRequest,
  UpdateSleepRequest,
  SleepRecord,
  SleepType,
} from "@growdesk/contracts";
import crypto from "node:crypto";

export interface KeysetPaginationQuery {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface PaginatedResult<T> {
  readonly data: T[];
  readonly page: {
    readonly nextCursor: string | null;
  };
}

export function encodeKeysetCursor(startedAt: Date, id: string): string {
  return Buffer.from(`${startedAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeKeysetCursor(cursor: string): { startedAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const [dateStr, id] = raw.split("|");
    if (!dateStr || !id) return null;
    const startedAt = new Date(dateStr);
    if (isNaN(startedAt.getTime())) return null;
    return { startedAt, id };
  } catch {
    return null;
  }
}

export function mapEntityToSleepRecord(entity: SleepRecordEntity): SleepRecord {
  const toIso = (d: Date | string): string =>
    typeof d === "string" ? new Date(d).toISOString() : d.toISOString();

  return {
    id: entity.id,
    babyId: entity.babyId,
    familyId: entity.familyId,
    sleepType: (["nap", "night"].includes(entity.sleepType)
      ? entity.sleepType
      : "nap") as SleepType,
    startedAt: toIso(entity.startedAt),
    endedAt: entity.endedAt ? toIso(entity.endedAt) : null,
    nightWakingCount: entity.nightWakingCount,
    notes: entity.notes,
    source: entity.source,
    sourceAgent: entity.sourceAgent,
    recordedByUserId: entity.recordedByUserId,
    version: entity.version.toString(),
    createdAt: toIso(entity.createdAt),
    updatedAt: toIso(entity.updatedAt),
  };
}

export class SleepService {
  private readonly repo: ScopedSleepRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.repo = new ScopedSleepRepository(prisma);
  }

  private async resolveBabyFamily(babyId: string): Promise<string> {
    const baby = await this.prisma.baby.findUnique({
      where: { id: babyId },
      select: { familyId: true, deletedAt: true },
    });
    if (!baby || baby.deletedAt !== null) {
      throw new BabyAccessDeniedError(babyId, "BABY_NOT_FOUND");
    }
    return baby.familyId;
  }

  async listSleepRecords(
    principal: UserPrincipal,
    babyId: string,
    pagination: KeysetPaginationQuery = {}
  ): Promise<PaginatedResult<SleepRecord>> {
    const familyId = await this.resolveBabyFamily(babyId);
    const limit = Math.min(pagination.limit ?? 50, 200);

    let beforeStartedAt: Date | undefined;
    let beforeId: string | undefined;

    if (pagination.cursor) {
      const decoded = decodeKeysetCursor(pagination.cursor);
      if (decoded) {
        beforeStartedAt = decoded.startedAt;
        beforeId = decoded.id;
      }
    }

    const records = await this.repo.listByBaby(principal, familyId, babyId, {
      limit: limit + 1,
      beforeStartedAt,
      beforeId,
    });

    const hasMore = records.length > limit;
    const pageItems = hasMore ? records.slice(0, limit) : records;
    let nextCursor: string | null = null;

    if (hasMore && pageItems.length > 0) {
      const lastItem = pageItems[pageItems.length - 1];
      if (lastItem) {
        nextCursor = encodeKeysetCursor(lastItem.startedAt, lastItem.id);
      }
    }

    return {
      data: pageItems.map(mapEntityToSleepRecord),
      page: {
        nextCursor,
      },
    };
  }

  async getSleepRecord(
    principal: UserPrincipal,
    babyId: string,
    id: string
  ): Promise<SleepRecord> {
    const familyId = await this.resolveBabyFamily(babyId);
    const record = await this.repo.findById(principal, familyId, babyId, id);
    if (!record) {
      throw new RecordNotFoundError("sleep_record", id);
    }
    return mapEntityToSleepRecord(record);
  }

  async getActiveSleepRecord(
    principal: UserPrincipal,
    babyId: string
  ): Promise<SleepRecord | null> {
    const familyId = await this.resolveBabyFamily(babyId);
    const record = await this.repo.findActiveByBaby(principal, familyId, babyId);
    if (!record) return null;
    return mapEntityToSleepRecord(record);
  }

  async createSleepRecord(
    principal: UserPrincipal,
    babyId: string,
    body: CreateSleepRequest,
    idempotencyKey?: string
  ): Promise<SleepRecord> {
    const familyId = await this.resolveBabyFamily(babyId);

    const startedAt = new Date(body.startedAt);
    const endedAt = body.endedAt ? new Date(body.endedAt) : null;

    if (endedAt && endedAt < startedAt) {
      const error = new Error("endedAt cannot be earlier than startedAt");
      (error as { statusCode?: number; code?: string }).statusCode = 400;
      (error as { statusCode?: number; code?: string }).code = "INVALID_SLEEP_INTERVAL";
      throw error;
    }

    const commandId = idempotencyKey || crypto.randomUUID();
    const id = crypto.randomUUID();

    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          operation: "create",
          entityType: "sleep",
          familyId,
          babyId,
          sleepType: body.sleepType,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt?.toISOString() ?? null,
          nightWakingCount: body.nightWakingCount ?? 0,
          notes: body.notes ?? null,
        })
      )
      .digest("hex");

    const result = await this.repo.create(principal, {
      commandId,
      requestHash,
      id,
      familyId,
      babyId,
      sleepType: body.sleepType,
      startedAt,
      endedAt,
      nightWakingCount: body.nightWakingCount ?? 0,
      notes: body.notes ?? null,
      source: body.source ?? "ui_manual",
      sourceAgent: body.sourceAgent ?? null,
    });

    return mapEntityToSleepRecord(result.result);
  }

  async updateSleepRecord(
    principal: UserPrincipal,
    babyId: string,
    id: string,
    body: UpdateSleepRequest,
    idempotencyKey?: string
  ): Promise<SleepRecord> {
    const familyId = await this.resolveBabyFamily(babyId);

    const commandId = idempotencyKey || crypto.randomUUID();
    const baseVersion = parseInt(body.baseVersion, 10);
    const startedAt = body.startedAt ? new Date(body.startedAt) : undefined;
    const endedAt = body.endedAt !== undefined ? (body.endedAt ? new Date(body.endedAt) : null) : undefined;

    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          operation: "update",
          entityType: "sleep",
          id,
          baseVersion,
          familyId,
          babyId,
          sleepType: body.sleepType,
          startedAt: startedAt?.toISOString(),
          endedAt: endedAt ? endedAt.toISOString() : endedAt === null ? null : undefined,
          nightWakingCount: body.nightWakingCount,
          notes: body.notes,
        })
      )
      .digest("hex");

    const result = await this.repo.update(principal, {
      commandId,
      requestHash,
      id,
      familyId,
      babyId,
      baseVersion,
      sleepType: body.sleepType,
      startedAt,
      endedAt,
      nightWakingCount: body.nightWakingCount,
      notes: body.notes,
    });

    return mapEntityToSleepRecord(result.result);
  }

  async deleteSleepRecord(
    principal: UserPrincipal,
    babyId: string,
    id: string,
    baseVersion: number,
    idempotencyKey?: string
  ): Promise<{ success: true; id: string; version: string }> {
    const familyId = await this.resolveBabyFamily(babyId);

    const commandId = idempotencyKey || crypto.randomUUID();
    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          operation: "delete",
          entityType: "sleep",
          id,
          baseVersion,
          familyId,
          babyId,
        })
      )
      .digest("hex");

    const result = await this.repo.delete(principal, {
      commandId,
      requestHash,
      id,
      familyId,
      babyId,
      baseVersion,
    });

    return {
      success: true,
      id: result.result.id,
      version: result.result.version.toString(),
    };
  }
}
