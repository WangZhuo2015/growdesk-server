import { PrismaClient, Prisma } from "./generated/client.js";
import { UserPrincipal } from "@growdesk/domain";
import {
  executeFamilyUnitOfWork,
  CommandExecutionResult,
  LegacyIdempotencyGoneError,
  LegacyReplayResult,
} from "./unit-of-work.js";
import {
  FamilyAccessDeniedError,
  BabyAccessDeniedError,
  RecordNotFoundError,
  IdempotencyKeyReusedError,
} from "./errors.js";

export interface CreateFeedingInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly feedingType: string;
  readonly occurredAt: Date;
  readonly amountMl?: string | number | null;
  readonly leftMinutes?: number | null;
  readonly rightMinutes?: number | null;
  readonly durationMinutes?: number | null;
  readonly spitUp?: string | null;
  readonly formulaProductId?: string | null;
  readonly notes?: string | null;
  readonly source?: string;
  readonly sourceAgent?: string | null;
}

export interface UpdateFeedingInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly baseVersion: number;
  readonly feedingType?: string;
  readonly occurredAt?: Date;
  readonly amountMl?: string | number | null;
  readonly leftMinutes?: number | null;
  readonly rightMinutes?: number | null;
  readonly durationMinutes?: number | null;
  readonly spitUp?: string | null;
  readonly formulaProductId?: string | null;
  readonly notes?: string | null;
}

export interface DeleteFeedingInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly baseVersion: number;
}

export interface FeedingRecordEntity {
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly feedingType: string;
  readonly occurredAt: Date;
  readonly amountMl: string | null;
  readonly leftMinutes: number | null;
  readonly rightMinutes: number | null;
  readonly durationMinutes: number | null;
  readonly spitUp: string | null;
  readonly formulaProductId: string | null;
  readonly notes: string | null;
  readonly source: string;
  readonly sourceAgent: string | null;
  readonly recordedByUserId: string | null;
  readonly version: number;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function mapFeedingRow(row: {
  id: string;
  familyId: string;
  babyId: string;
  feedingType: string;
  occurredAt: Date;
  amountMl: Prisma.Decimal | null;
  leftMinutes: number | null;
  rightMinutes: number | null;
  durationMinutes: number | null;
  spitUp: string | null;
  formulaProductId: string | null;
  notes: string | null;
  source: string;
  sourceAgent: string | null;
  recordedByUserId: string | null;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): FeedingRecordEntity {
  return {
    ...row,
    amountMl: row.amountMl ? row.amountMl.toString() : null,
  };
}

function sameDate(actual: Date | null, expected: Date | null | undefined): boolean {
  if (actual === null || expected === null || expected === undefined) {
    return actual === (expected ?? null);
  }
  return actual.getTime() === expected.getTime();
}

function decimalText(value: Prisma.Decimal | string | number | null | undefined): string | null {
  return value === null || value === undefined ? null : new Prisma.Decimal(value.toString()).toString();
}

function sameDecimal(actual: Prisma.Decimal | null, expected: string | number | null | undefined): boolean {
  return decimalText(actual) === decimalText(expected);
}

export class FeedingRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    principal: UserPrincipal,
    input: CreateFeedingInput
  ): Promise<CommandExecutionResult<FeedingRecordEntity>> {
    return await executeFamilyUnitOfWork<FeedingRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "create",
      entityType: "feeding",
      entityId: input.id,
      baseVersion: null,
      getExistingVersion: async (tx) => {
        const row = await tx.feedingRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true },
        });
        return row?.version ?? null;
      },
      findLegacyReplay: async (tx): Promise<LegacyReplayResult<FeedingRecordEntity> | null> => {
        const legacyRows = await tx.feedingRecord.findMany({
          where: {
            familyId: input.familyId,
            babyId: input.babyId,
            legacyClientId: input.commandId,
          },
          orderBy: { id: "asc" },
        });
        if (legacyRows.length === 0) return null;

        // A deleted imported row is a tombstone for the old key.  Do not
        // revive it or create a replacement under the same client id.
        if (legacyRows.some((row) => row.deletedAt !== null)) {
          throw new LegacyIdempotencyGoneError(input.commandId);
        }
        if (legacyRows.length !== 1) {
          throw new IdempotencyKeyReusedError(input.commandId);
        }

        const row = legacyRows[0];
        if (!row) throw new IdempotencyKeyReusedError(input.commandId);
        const sameFields =
          row.feedingType === input.feedingType &&
          sameDate(row.occurredAt, input.occurredAt) &&
          sameDecimal(row.amountMl, input.amountMl) &&
          row.leftMinutes === (input.leftMinutes ?? null) &&
          row.rightMinutes === (input.rightMinutes ?? null) &&
          row.durationMinutes === (input.durationMinutes ?? null) &&
          row.spitUp === (input.spitUp ?? "false") &&
          row.formulaProductId === (input.formulaProductId ?? null) &&
          row.notes === (input.notes ?? null);
        if (!sameFields) {
          throw new IdempotencyKeyReusedError(input.commandId);
        }

        return { result: mapFeedingRow(row), version: row.version };
      },
      execute: async (tx, meta) => {
        const row = await tx.feedingRecord.create({
          data: {
            id: input.id,
            familyId: input.familyId,
            babyId: input.babyId,
            feedingType: input.feedingType,
            occurredAt: input.occurredAt,
            amountMl: input.amountMl !== undefined && input.amountMl !== null
              ? new Prisma.Decimal(input.amountMl.toString())
              : null,
            leftMinutes: input.leftMinutes ?? null,
            rightMinutes: input.rightMinutes ?? null,
            durationMinutes: input.durationMinutes ?? null,
            spitUp: input.spitUp ?? null,
            formulaProductId: input.formulaProductId ?? null,
            notes: input.notes ?? null,
            source: input.source ?? "manual",
            sourceAgent: input.sourceAgent ?? null,
            recordedByUserId: principal.userId,
            version: meta.nextVersion,
          },
        });

        const entity = mapFeedingRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            feedingType: entity.feedingType,
            occurredAt: entity.occurredAt.toISOString(),
            amountMl: entity.amountMl,
            version: entity.version,
          },
          summary: `Feeding: ${entity.feedingType}${entity.amountMl ? ` ${entity.amountMl}ml` : ""}`,
          occurredAt: entity.occurredAt,
        };
      },
    });
  }

  async update(
    principal: UserPrincipal,
    input: UpdateFeedingInput
  ): Promise<CommandExecutionResult<FeedingRecordEntity>> {
    return await executeFamilyUnitOfWork<FeedingRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "update",
      entityType: "feeding",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.feedingRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row || row.deletedAt !== null) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const data: Prisma.FeedingRecordUncheckedUpdateInput = {
          version: meta.nextVersion,
          updatedAt: new Date(),
        };
        if (input.feedingType !== undefined) data.feedingType = input.feedingType;
        if (input.occurredAt !== undefined) data.occurredAt = input.occurredAt;
        if (input.amountMl !== undefined) {
          data.amountMl = input.amountMl !== null ? new Prisma.Decimal(input.amountMl.toString()) : null;
        }
        if (input.leftMinutes !== undefined) data.leftMinutes = input.leftMinutes;
        if (input.rightMinutes !== undefined) data.rightMinutes = input.rightMinutes;
        if (input.durationMinutes !== undefined) data.durationMinutes = input.durationMinutes;
        if (input.spitUp !== undefined) data.spitUp = input.spitUp;
        if (input.formulaProductId !== undefined) data.formulaProductId = input.formulaProductId;
        if (input.notes !== undefined) data.notes = input.notes;

        const row = await tx.feedingRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data,
        });

        const entity = mapFeedingRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            feedingType: entity.feedingType,
            occurredAt: entity.occurredAt.toISOString(),
            amountMl: entity.amountMl,
            version: entity.version,
          },
          summary: `Updated feeding: ${entity.feedingType}${entity.amountMl ? ` ${entity.amountMl}ml` : ""}`,
          occurredAt: entity.occurredAt,
        };
      },
    });
  }

  async delete(
    principal: UserPrincipal,
    input: DeleteFeedingInput
  ): Promise<CommandExecutionResult<FeedingRecordEntity>> {
    return await executeFamilyUnitOfWork<FeedingRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "delete",
      entityType: "feeding",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.feedingRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row || row.deletedAt !== null) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const row = await tx.feedingRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data: {
            version: meta.nextVersion,
            deletedAt: new Date(),
            updatedAt: new Date(),
          },
        });

        const entity = mapFeedingRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            deleted: true,
            version: entity.version,
          },
          summary: `Deleted feeding: ${entity.id}`,
          occurredAt: entity.occurredAt,
        };
      },
    });
  }

  async restore(
    principal: UserPrincipal,
    input: {
      commandId: string;
      requestHash: string;
      id: string;
      familyId: string;
      babyId: string;
      baseVersion: number;
    }
  ): Promise<CommandExecutionResult<FeedingRecordEntity>> {
    return await executeFamilyUnitOfWork<FeedingRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "restore",
      entityType: "feeding",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.feedingRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const row = await tx.feedingRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data: {
            version: meta.nextVersion,
            deletedAt: null,
            updatedAt: new Date(),
          },
        });

        const entity = mapFeedingRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            feedingType: entity.feedingType,
            occurredAt: entity.occurredAt.toISOString(),
            amountMl: entity.amountMl,
            version: entity.version,
          },
          summary: `Restored feeding: ${entity.id}`,
          occurredAt: entity.occurredAt,
        };
      },
    });
  }

  async findById(
    principal: UserPrincipal,
    familyId: string,
    babyId: string,
    id: string
  ): Promise<FeedingRecordEntity | null> {
    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasFamily) throw new FamilyAccessDeniedError(familyId);

    const hasBaby = principal.babyMemberships?.some(
      (m) => m.userId === principal.userId && m.babyId === babyId && m.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId);

    const row = await this.prisma.feedingRecord.findUnique({
      where: { id },
    });
    if (!row || row.familyId !== familyId || row.babyId !== babyId || row.deletedAt !== null) {
      return null;
    }
    return mapFeedingRow(row);
  }

  async listByBaby(
    principal: UserPrincipal,
    familyId: string,
    babyId: string,
    options: { limit?: number; beforeOccurredAt?: Date; beforeId?: string } = {}
  ): Promise<ReadonlyArray<FeedingRecordEntity>> {
    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasFamily) throw new FamilyAccessDeniedError(familyId);

    const hasBaby = principal.babyMemberships?.some(
      (m) => m.userId === principal.userId && m.babyId === babyId && m.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId);

    // Service requests page size + 1 as a sentinel, including at the public 200 limit.
    const limit = Math.min(options.limit ?? 50, 201);

    const where: Prisma.FeedingRecordWhereInput = {
      familyId,
      babyId,
      deletedAt: null,
    };

    if (options.beforeOccurredAt) {
      if (options.beforeId) {
        where.OR = [
          { occurredAt: { lt: options.beforeOccurredAt } },
          { occurredAt: options.beforeOccurredAt, id: { lt: options.beforeId } },
        ];
      } else {
        where.occurredAt = { lt: options.beforeOccurredAt };
      }
    }

    const rows = await this.prisma.feedingRecord.findMany({
      where,
      orderBy: [
        { occurredAt: "desc" },
        { id: "desc" },
      ],
      take: limit,
    });

    return rows.map(mapFeedingRow);
  }
}

export { FeedingRepository as ScopedFeedingRepository };
