import type { PrismaClient } from "@growdesk/database";
import {
  ScopedSupplementRepository,
  type SupplementRecordEntity,
  RecordNotFoundError,
  BabyAccessDeniedError,
} from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import type {
  CreateSupplementRequest,
  UpdateSupplementRequest,
  SupplementRecord,
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

export function mapEntityToSupplementRecord(entity: SupplementRecordEntity): SupplementRecord {
  const toIso = (d: Date | string): string =>
    typeof d === "string" ? new Date(d).toISOString() : d.toISOString();

  return {
    id: entity.id,
    babyId: entity.babyId,
    familyId: entity.familyId,
    supplementName: entity.supplementName,
    productId: entity.productId,
    occurredAt: toIso(entity.occurredAt),
    amount: entity.amount,
    dose: entity.dose?.toString() ?? null,
    unitName: entity.unitName,
    notes: entity.notes,
    recordedByUserId: entity.recordedByUserId,
    version: entity.version.toString(),
    createdAt: toIso(entity.createdAt),
    updatedAt: toIso(entity.updatedAt),
  };
}

export class SupplementService {
  private readonly repo: ScopedSupplementRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.repo = new ScopedSupplementRepository(prisma);
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

  async listSupplementRecords(
    principal: UserPrincipal,
    babyId: string,
    pagination: KeysetPaginationQuery = {}
  ): Promise<PaginatedResult<SupplementRecord>> {
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
      data: pageItems.map(mapEntityToSupplementRecord),
      page: {
        nextCursor,
      },
    };
  }

  async getSupplementRecord(
    principal: UserPrincipal,
    babyId: string,
    id: string
  ): Promise<SupplementRecord> {
    const familyId = await this.resolveBabyFamily(babyId);
    const record = await this.repo.findById(principal, familyId, babyId, id);
    if (!record) {
      throw new RecordNotFoundError("supplement_record", id);
    }
    return mapEntityToSupplementRecord(record);
  }

  async createSupplementRecord(
    principal: UserPrincipal,
    babyId: string,
    body: CreateSupplementRequest,
    idempotencyKey?: string
  ): Promise<SupplementRecord> {
    const familyId = await this.resolveBabyFamily(babyId);

    const commandId = idempotencyKey || crypto.randomUUID();
    const id = crypto.randomUUID();
    const occurredAt = new Date(body.occurredAt);

    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          operation: "create",
          entityType: "supplement",
          familyId,
          babyId,
          supplementName: body.supplementName,
          productId: body.productId ?? null,
          occurredAt: occurredAt.toISOString(),
          amount: body.amount ?? null,
          dose: body.dose ?? null,
          unitName: body.unitName ?? null,
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
      supplementName: body.supplementName,
      productId: body.productId ?? null,
      occurredAt,
      amount: body.amount ?? null,
      dose: body.dose ?? null,
      unitName: body.unitName ?? null,
      notes: body.notes ?? null,
      source: "ui_manual",
      sourceAgent: null,
    });

    return mapEntityToSupplementRecord(result.result);
  }

  async updateSupplementRecord(
    principal: UserPrincipal,
    babyId: string,
    id: string,
    body: UpdateSupplementRequest,
    idempotencyKey?: string
  ): Promise<SupplementRecord> {
    const familyId = await this.resolveBabyFamily(babyId);

    const commandId = idempotencyKey || crypto.randomUUID();
    const baseVersion = parseInt(body.baseVersion, 10);
    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : undefined;

    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          operation: "update",
          entityType: "supplement",
          id,
          baseVersion,
          familyId,
          babyId,
          supplementName: body.supplementName,
          productId: body.productId,
          occurredAt: occurredAt?.toISOString(),
          amount: body.amount,
          dose: body.dose,
          unitName: body.unitName,
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
      supplementName: body.supplementName,
      productId: body.productId,
      occurredAt,
      amount: body.amount,
      dose: body.dose,
      unitName: body.unitName,
      notes: body.notes,
    });

    return mapEntityToSupplementRecord(result.result);
  }

  async deleteSupplementRecord(
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
          entityType: "supplement",
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
