import type { PrismaClient } from "@growdesk/database";
import {
  ScopedFeedingRepository,
  type FeedingRecordEntity,
  RecordNotFoundError,
  BabyAccessDeniedError,
  FamilyAccessDeniedError,
} from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import type {
  CreateFeedingRequest,
  UpdateFeedingRequest,
  FeedingRecord,
  FeedingType,
} from "@growdesk/contracts";
import crypto from "node:crypto";
import { readRecordVersion } from "../routes/record-version.js";

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

export function mapEntityToFeedingRecord(entity: FeedingRecordEntity): FeedingRecord {
  const toIso = (d: Date | string): string =>
    typeof d === "string" ? new Date(d).toISOString() : d.toISOString();

  return {
    id: entity.id,
    babyId: entity.babyId,
    familyId: entity.familyId,
    feedingType: (["breast", "bottle", "formula", "mixed"].includes(entity.feedingType)
      ? entity.feedingType
      : "formula") as FeedingType,
    occurredAt: toIso(entity.occurredAt),
    amountMl: entity.amountMl,
    leftMinutes: entity.leftMinutes,
    rightMinutes: entity.rightMinutes,
    spitUp: entity.spitUp === "true" || entity.spitUp === "1" || entity.spitUp === "mild",
    formulaProductId: entity.formulaProductId,
    notes: entity.notes,
    source: entity.source,
    sourceAgent: entity.sourceAgent,
    version: entity.version.toString(),
    createdAt: toIso(entity.createdAt),
    updatedAt: toIso(entity.updatedAt),
  };
}

export class FeedingService {
  private readonly repo: ScopedFeedingRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.repo = new ScopedFeedingRepository(prisma);
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

  async listFeedingRecords(
    principal: UserPrincipal,
    babyId: string,
    pagination: KeysetPaginationQuery = {}
  ): Promise<PaginatedResult<FeedingRecord>> {
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

    // Query limit + 1 to calculate nextCursor
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
      data: pageItems.map(mapEntityToFeedingRecord),
      page: {
        nextCursor,
      },
    };
  }

  async getFeedingRecord(
    principal: UserPrincipal,
    babyId: string,
    id: string
  ): Promise<FeedingRecord> {
    const familyId = await this.resolveBabyFamily(babyId);
    const record = await this.repo.findById(principal, familyId, babyId, id);
    if (!record) {
      throw new RecordNotFoundError("feeding_record", id);
    }
    return mapEntityToFeedingRecord(record);
  }

  async createFeedingRecord(
    principal: UserPrincipal,
    babyId: string,
    body: CreateFeedingRequest,
    idempotencyKey?: string
  ): Promise<FeedingRecord> {
    const familyId = await this.resolveBabyFamily(babyId);

    // Validate formula product family boundary if provided
    if (body.formulaProductId) {
      const product = await this.prisma.formulaProduct.findUnique({
        where: { id: body.formulaProductId },
        select: { familyId: true, deletedAt: true },
      });
      if (!product || product.familyId !== familyId || product.deletedAt !== null) {
        const error = new Error(`Formula product '${body.formulaProductId}' does not belong to family or was deleted`);
        (error as { statusCode?: number; code?: string }).statusCode = 400;
        (error as { statusCode?: number; code?: string }).code = "FORMULA_PRODUCT_NOT_FOUND";
        throw error;
      }
    }

    const commandId = idempotencyKey || crypto.randomUUID();
    const id = crypto.randomUUID();
    const occurredAt = new Date(body.occurredAt);

    // Canonical request hash for idempotency checking
    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          operation: "create",
          entityType: "feeding",
          familyId,
          babyId,
          feedingType: body.feedingType,
          occurredAt: occurredAt.toISOString(),
          amountMl: body.amountMl ?? null,
          leftMinutes: body.leftMinutes ?? null,
          rightMinutes: body.rightMinutes ?? null,
          formulaProductId: body.formulaProductId ?? null,
          spitUp: body.spitUp ?? false,
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
      feedingType: body.feedingType,
      occurredAt,
      amountMl: body.amountMl ?? null,
      leftMinutes: body.leftMinutes ?? null,
      rightMinutes: body.rightMinutes ?? null,
      spitUp: body.spitUp ? "true" : "false",
      formulaProductId: body.formulaProductId ?? null,
      notes: body.notes ?? null,
      source: body.source ?? "ui_manual",
      sourceAgent: body.sourceAgent ?? null,
    });

    return mapEntityToFeedingRecord(result.result);
  }

  async updateFeedingRecord(
    principal: UserPrincipal,
    babyId: string,
    id: string,
    body: UpdateFeedingRequest,
    idempotencyKey?: string
  ): Promise<FeedingRecord> {
    const familyId = await this.resolveBabyFamily(babyId);

    // Validate formula product family boundary if provided
    if (body.formulaProductId) {
      const product = await this.prisma.formulaProduct.findUnique({
        where: { id: body.formulaProductId },
        select: { familyId: true, deletedAt: true },
      });
      if (!product || product.familyId !== familyId || product.deletedAt !== null) {
        const error = new Error(`Formula product '${body.formulaProductId}' does not belong to family or was deleted`);
        (error as { statusCode?: number; code?: string }).statusCode = 400;
        (error as { statusCode?: number; code?: string }).code = "FORMULA_PRODUCT_NOT_FOUND";
        throw error;
      }
    }

    const commandId = idempotencyKey || crypto.randomUUID();
    const baseVersion = readRecordVersion(body.baseVersion);
    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : undefined;

    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          operation: "update",
          entityType: "feeding",
          id,
          baseVersion,
          familyId,
          babyId,
          feedingType: body.feedingType,
          occurredAt: occurredAt?.toISOString(),
          amountMl: body.amountMl,
          leftMinutes: body.leftMinutes,
          rightMinutes: body.rightMinutes,
          formulaProductId: body.formulaProductId,
          spitUp: body.spitUp,
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
      feedingType: body.feedingType,
      occurredAt,
      amountMl: body.amountMl,
      leftMinutes: body.leftMinutes,
      rightMinutes: body.rightMinutes,
      spitUp: body.spitUp !== undefined ? (body.spitUp ? "true" : "false") : undefined,
      formulaProductId: body.formulaProductId,
      notes: body.notes,
    });

    return mapEntityToFeedingRecord(result.result);
  }

  async deleteFeedingRecord(
    principal: UserPrincipal,
    babyId: string,
    id: string,
    baseVersion: number,
    idempotencyKey?: string
  ): Promise<{ success: true; id: string }> {
    const familyId = await this.resolveBabyFamily(babyId);

    // The repository checks the client's version and the entity scope inside the UoW.
    // A pre-read of the latest version would defeat optimistic locking and receipt replay.
    readRecordVersion(String(baseVersion));

    const commandId = idempotencyKey || crypto.randomUUID();
    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          operation: "delete",
          entityType: "feeding",
          id,
          familyId,
          babyId,
          baseVersion,
        })
      )
      .digest("hex");

    await this.repo.delete(principal, {
      commandId,
      requestHash,
      id,
      familyId,
      babyId,
      baseVersion,
    });

    return { success: true, id };
  }
}
