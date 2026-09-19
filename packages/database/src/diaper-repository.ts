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

export interface CreateDiaperInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly diaperType: string;
  readonly occurredAt: Date;
  readonly poopColor?: string | null;
  readonly poopConsistency?: string | null;
  readonly notes?: string | null;
  readonly source?: string;
  readonly sourceAgent?: string | null;
}

export interface UpdateDiaperInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly baseVersion: number;
  readonly diaperType?: string;
  readonly occurredAt?: Date;
  readonly poopColor?: string | null;
  readonly poopConsistency?: string | null;
  readonly notes?: string | null;
}

export interface DeleteDiaperInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly baseVersion: number;
}

export interface DiaperRecordEntity {
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly diaperType: string;
  readonly occurredAt: Date;
  readonly poopColor: string | null;
  readonly poopConsistency: string | null;
  readonly notes: string | null;
  readonly source: string;
  readonly sourceAgent: string | null;
  readonly recordedByUserId: string | null;
  readonly version: number;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function mapDiaperRow(row: {
  id: string;
  familyId: string;
  babyId: string;
  diaperType: string;
  occurredAt: Date;
  poopColor: string | null;
  poopConsistency: string | null;
  notes: string | null;
  source: string;
  sourceAgent: string | null;
  recordedByUserId: string | null;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): DiaperRecordEntity {
  return {
    ...row,
  };
}

function sameDate(actual: Date | null, expected: Date | null | undefined): boolean {
  if (actual === null || expected === null || expected === undefined) {
    return actual === (expected ?? null);
  }
  return actual.getTime() === expected.getTime();
}

export class DiaperRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    principal: UserPrincipal,
    input: CreateDiaperInput
  ): Promise<CommandExecutionResult<DiaperRecordEntity>> {
    return await executeFamilyUnitOfWork<DiaperRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "create",
      entityType: "diaper",
      entityId: input.id,
      baseVersion: null,
      getExistingVersion: async (tx) => {
        const row = await tx.diaperRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true },
        });
        return row?.version ?? null;
      },
      findLegacyReplay: async (tx): Promise<LegacyReplayResult<DiaperRecordEntity> | null> => {
        const legacyRows = await tx.diaperRecord.findMany({
          where: {
            familyId: input.familyId,
            babyId: input.babyId,
            legacyClientId: input.commandId,
          },
          orderBy: { id: "asc" },
        });
        if (legacyRows.length === 0) return null;
        if (legacyRows.some((row) => row.deletedAt !== null)) {
          throw new LegacyIdempotencyGoneError(input.commandId);
        }
        if (legacyRows.length !== 1) {
          throw new IdempotencyKeyReusedError(input.commandId);
        }

        const row = legacyRows[0];
        if (!row) throw new IdempotencyKeyReusedError(input.commandId);
        const sameFields =
          row.diaperType === input.diaperType &&
          sameDate(row.occurredAt, input.occurredAt) &&
          row.poopColor === (input.poopColor ?? null) &&
          row.poopConsistency === (input.poopConsistency ?? null) &&
          row.notes === (input.notes ?? null);
        if (!sameFields) {
          throw new IdempotencyKeyReusedError(input.commandId);
        }

        return { result: mapDiaperRow(row), version: row.version };
      },
      execute: async (tx, meta) => {
        const row = await tx.diaperRecord.create({
          data: {
            id: input.id,
            familyId: input.familyId,
            babyId: input.babyId,
            diaperType: input.diaperType,
            occurredAt: input.occurredAt,
            poopColor: input.poopColor ?? null,
            poopConsistency: input.poopConsistency ?? null,
            notes: input.notes ?? null,
            source: input.source ?? "manual",
            sourceAgent: input.sourceAgent ?? null,
            recordedByUserId: principal.userId,
            version: meta.nextVersion,
          },
        });

        const entity = mapDiaperRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            diaperType: entity.diaperType,
            occurredAt: entity.occurredAt.toISOString(),
            poopColor: entity.poopColor,
            poopConsistency: entity.poopConsistency,
            version: entity.version,
          },
          summary: `Diaper: ${entity.diaperType}`,
          occurredAt: entity.occurredAt,
        };
      },
    });
  }

  async update(
    principal: UserPrincipal,
    input: UpdateDiaperInput
  ): Promise<CommandExecutionResult<DiaperRecordEntity>> {
    return await executeFamilyUnitOfWork<DiaperRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "update",
      entityType: "diaper",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.diaperRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row || row.deletedAt !== null) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const existing = await tx.diaperRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
        });
        if (!existing || existing.deletedAt !== null) {
          throw new RecordNotFoundError("diaper_record", input.id);
        }

        const data: Prisma.DiaperRecordUncheckedUpdateInput = {
          version: meta.nextVersion,
          updatedAt: new Date(),
        };

        if (input.diaperType !== undefined) {
          data.diaperType = input.diaperType;
        }
        if (input.occurredAt !== undefined) {
          data.occurredAt = input.occurredAt;
        }
        if (input.poopColor !== undefined) {
          data.poopColor = input.poopColor;
        }
        if (input.poopConsistency !== undefined) {
          data.poopConsistency = input.poopConsistency;
        }
        if (input.notes !== undefined) {
          data.notes = input.notes;
        }

        const row = await tx.diaperRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data,
        });

        const entity = mapDiaperRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            diaperType: entity.diaperType,
            occurredAt: entity.occurredAt.toISOString(),
            poopColor: entity.poopColor,
            poopConsistency: entity.poopConsistency,
            version: entity.version,
          },
          summary: `Updated diaper: ${entity.diaperType}`,
          occurredAt: entity.occurredAt,
        };
      },
    });
  }

  async delete(
    principal: UserPrincipal,
    input: DeleteDiaperInput
  ): Promise<CommandExecutionResult<DiaperRecordEntity>> {
    return await executeFamilyUnitOfWork<DiaperRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "delete",
      entityType: "diaper",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.diaperRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row || row.deletedAt !== null) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const row = await tx.diaperRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data: {
            version: meta.nextVersion,
            deletedAt: new Date(),
            updatedAt: new Date(),
          },
        });

        const entity = mapDiaperRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            deleted: true,
            version: entity.version,
          },
          summary: `Deleted diaper: ${entity.id}`,
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
  ): Promise<CommandExecutionResult<DiaperRecordEntity>> {
    return await executeFamilyUnitOfWork<DiaperRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "restore",
      entityType: "diaper",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.diaperRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const row = await tx.diaperRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data: {
            version: meta.nextVersion,
            deletedAt: null,
            updatedAt: new Date(),
          },
        });

        const entity = mapDiaperRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            diaperType: entity.diaperType,
            occurredAt: entity.occurredAt.toISOString(),
            poopColor: entity.poopColor,
            poopConsistency: entity.poopConsistency,
            version: entity.version,
          },
          summary: `Restored diaper: ${entity.id}`,
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
  ): Promise<DiaperRecordEntity | null> {
    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasFamily) throw new FamilyAccessDeniedError(familyId);

    const hasBaby = principal.babyMemberships?.some(
      (m) => m.userId === principal.userId && m.babyId === babyId && m.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId);

    const row = await this.prisma.diaperRecord.findUnique({
      where: { id },
    });
    if (!row || row.familyId !== familyId || row.babyId !== babyId || row.deletedAt !== null) {
      return null;
    }
    return mapDiaperRow(row);
  }

  async listByBaby(
    principal: UserPrincipal,
    familyId: string,
    babyId: string,
    options: { limit?: number; beforeOccurredAt?: Date; beforeId?: string } = {}
  ): Promise<ReadonlyArray<DiaperRecordEntity>> {
    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasFamily) throw new FamilyAccessDeniedError(familyId);

    const hasBaby = principal.babyMemberships?.some(
      (m) => m.userId === principal.userId && m.babyId === babyId && m.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId);

    // The API returns at most 200 rows; preserve its extra lookahead row.
    const limit = Math.min(options.limit ?? 50, 201);

    const where: Prisma.DiaperRecordWhereInput = {
      familyId,
      babyId,
      deletedAt: null,
    };

    if (options.beforeOccurredAt) {
      if (options.beforeId) {
        where.OR = [
          { occurredAt: { lt: options.beforeOccurredAt } },
          {
            occurredAt: options.beforeOccurredAt,
            id: { lt: options.beforeId },
          },
        ];
      } else {
        where.occurredAt = { lt: options.beforeOccurredAt };
      }
    }

    const rows = await this.prisma.diaperRecord.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: limit,
    });

    return rows.map(mapDiaperRow);
  }
}

export const ScopedDiaperRepository = DiaperRepository;
export type ScopedDiaperRepository = DiaperRepository;
