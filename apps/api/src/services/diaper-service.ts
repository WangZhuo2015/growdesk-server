import type { PrismaClient } from "@growdesk/database";
import {
  ScopedDiaperRepository,
  type DiaperRecordEntity,
  RecordNotFoundError,
  BabyAccessDeniedError,
} from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import type {
  CreateDiaperRequest,
  UpdateDiaperRequest,
  DiaperRecord,
  DiaperType,
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

export function encodeKeysetCursor(occurredAt: Date, id: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeKeysetCursor(cursor: string): { occurredAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const [dateStr, id] = raw.split("|");
    if (!dateStr || !id) return null;
    const occurredAt = new Date(dateStr);
    if (isNaN(occurredAt.getTime())) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}

export function mapEntityToDiaperRecord(entity: DiaperRecordEntity): DiaperRecord {
  const toIso = (d: Date | string): string =>
    typeof d === "string" ? new Date(d).toISOString() : d.toISOString();

  return {
    id: entity.id,
    babyId: entity.babyId,
    familyId: entity.familyId,
    diaperType: (["pee", "poop", "both"].includes(entity.diaperType)
      ? entity.diaperType
      : "both") as DiaperType,
    occurredAt: toIso(entity.occurredAt),
    poopColor: entity.poopColor,
    poopConsistency: entity.poopConsistency,
    notes: entity.notes,
    source: entity.source,
    sourceAgent: entity.sourceAgent,
    version: entity.version.toString(),
    createdAt: toIso(entity.createdAt),
    updatedAt: toIso(entity.updatedAt),
  };
}

export class DiaperService {
  private readonly repo: ScopedDiaperRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.repo = new ScopedDiaperRepository(prisma);
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

  async listDiaperRecords(
    principal: UserPrincipal,
    babyId: string,
    pagination: KeysetPaginationQuery = {}
  ): Promise<PaginatedResult<DiaperRecord>> {
    const familyId = await this.resolveBabyFamily(babyId);
    const limit = Math.min(pagination.limit ?? 50, 200);

    let beforeOccurredAt: Date | undefined;
    let beforeId: string | undefined;

    if (pagination.cursor) {
      const decoded = decodeKeysetCursor(pagination.cursor);
      if (decoded) {
        beforeOccurredAt = decoded.occurredAt;
        beforeId = decoded.id;
      }
    }

    const records = await this.repo.listByBaby(principal, familyId, babyId, {
      limit: limit + 1,
      beforeOccurredAt,
      beforeId,
    });

    const hasMore = records.length > limit;
    const pageItems = hasMore ? records.slice(0, limit) : records;
    let nextCursor: string | null = null;

    if (hasMore && pageItems.length > 0) {
      const lastItem = pageItems[pageItems.length - 1];
      if (lastItem) {
        nextCursor = encodeKeysetCursor(lastItem.occurredAt, lastItem.id);
      }
    }

    return {
      data: pageItems.map(mapEntityToDiaperRecord),
      page: {
        nextCursor,
      },
    };
  }

  async getDiaperRecord(
    principal: UserPrincipal,
    babyId: string,
    id: string
  ): Promise<DiaperRecord> {
    const familyId = await this.resolveBabyFamily(babyId);
    const record = await this.repo.findById(principal, familyId, babyId, id);
    if (!record) {
      throw new RecordNotFoundError("diaper_record", id);
    }
    return mapEntityToDiaperRecord(record);
  }

  async createDiaperRecord(
    principal: UserPrincipal,
    babyId: string,
    body: CreateDiaperRequest,
    idempotencyKey?: string
  ): Promise<DiaperRecord> {
    const familyId = await this.resolveBabyFamily(babyId);

    const commandId = idempotencyKey || crypto.randomUUID();
    const id = crypto.randomUUID();
    const occurredAt = new Date(body.occurredAt);

    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          operation: "create",
          entityType: "diaper",
          familyId,
          babyId,
          diaperType: body.diaperType,
          occurredAt: occurredAt.toISOString(),
          poopColor: body.poopColor ?? null,
          poopConsistency: body.poopConsistency ?? null,
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
      diaperType: body.diaperType,
      occurredAt,
      poopColor: body.poopColor ?? null,
      poopConsistency: body.poopConsistency ?? null,
      notes: body.notes ?? null,
      source: body.source ?? "ui_manual",
      sourceAgent: body.sourceAgent ?? null,
    });

    return mapEntityToDiaperRecord(result.result);
  }

  async updateDiaperRecord(
    principal: UserPrincipal,
    babyId: string,
    id: string,
    body: UpdateDiaperRequest,
    idempotencyKey?: string
  ): Promise<DiaperRecord> {
    const familyId = await this.resolveBabyFamily(babyId);

    const commandId = idempotencyKey || crypto.randomUUID();
    const baseVersion = parseInt(body.baseVersion, 10);
    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : undefined;

    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          operation: "update",
          entityType: "diaper",
          id,
          baseVersion,
          familyId,
          babyId,
          diaperType: body.diaperType,
          occurredAt: occurredAt?.toISOString(),
          poopColor: body.poopColor,
          poopConsistency: body.poopConsistency,
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
      diaperType: body.diaperType,
      occurredAt,
      poopColor: body.poopColor,
      poopConsistency: body.poopConsistency,
      notes: body.notes,
    });

    return mapEntityToDiaperRecord(result.result);
  }

  async deleteDiaperRecord(
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
          entityType: "diaper",
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
