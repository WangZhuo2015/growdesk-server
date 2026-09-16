import { PrismaClient, Prisma } from "./generated/client.js";
import { UserPrincipal } from "@growdesk/domain";
import { executeFamilyUnitOfWork, CommandExecutionResult } from "./unit-of-work.js";
import { FamilyAccessDeniedError, BabyAccessDeniedError, RecordNotFoundError } from "./errors.js";

export interface CreateSleepInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly sleepType: string;
  readonly startedAt: Date;
  readonly endedAt?: Date | null;
  readonly nightWakingCount?: number;
  readonly notes?: string | null;
  readonly source?: string;
  readonly sourceAgent?: string | null;
}

export interface UpdateSleepInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly baseVersion: number;
  readonly sleepType?: string;
  readonly startedAt?: Date;
  readonly endedAt?: Date | null;
  readonly nightWakingCount?: number;
  readonly notes?: string | null;
}

export interface DeleteSleepInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly baseVersion: number;
}

export interface SleepRecordEntity {
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly sleepType: string;
  readonly startedAt: Date;
  readonly endedAt: Date | null;
  readonly nightWakingCount: number;
  readonly notes: string | null;
  readonly source: string;
  readonly sourceAgent: string | null;
  readonly recordedByUserId: string | null;
  readonly version: number;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function mapSleepRow(row: {
  id: string;
  familyId: string;
  babyId: string;
  sleepType: string;
  startedAt: Date;
  endedAt: Date | null;
  nightWakingCount: number;
  notes: string | null;
  source: string;
  sourceAgent: string | null;
  recordedByUserId: string | null;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): SleepRecordEntity {
  return {
    ...row,
  };
}

export class SleepRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    principal: UserPrincipal,
    input: CreateSleepInput
  ): Promise<CommandExecutionResult<SleepRecordEntity>> {
    return await executeFamilyUnitOfWork<SleepRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "create",
      entityType: "sleep",
      entityId: input.id,
      baseVersion: null,
      getExistingVersion: async (tx) => {
        const row = await tx.sleepRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true },
        });
        return row?.version ?? null;
      },
      execute: async (tx, meta) => {
        // If creating an ongoing/active sleep (endedAt is null), check if one already exists
        if (!input.endedAt) {
          const activeSleep = await tx.sleepRecord.findFirst({
            where: {
              babyId: input.babyId,
              endedAt: null,
              deletedAt: null,
            },
            select: { id: true },
          });
          if (activeSleep) {
            const error = new Error(`An active sleep record (${activeSleep.id}) already exists for baby '${input.babyId}'`);
            (error as { statusCode?: number; code?: string }).statusCode = 409;
            (error as { statusCode?: number; code?: string }).code = "ACTIVE_SLEEP_EXISTS";
            throw error;
          }
        }

        const row = await tx.sleepRecord.create({
          data: {
            id: input.id,
            familyId: input.familyId,
            babyId: input.babyId,
            sleepType: input.sleepType,
            startedAt: input.startedAt,
            endedAt: input.endedAt ?? null,
            nightWakingCount: input.nightWakingCount ?? 0,
            notes: input.notes ?? null,
            source: input.source ?? "manual",
            sourceAgent: input.sourceAgent ?? null,
            recordedByUserId: principal.userId,
            version: meta.nextVersion,
          },
        });

        const entity = mapSleepRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            sleepType: entity.sleepType,
            startedAt: entity.startedAt.toISOString(),
            endedAt: entity.endedAt?.toISOString() ?? null,
            nightWakingCount: entity.nightWakingCount,
            version: entity.version,
          },
          summary: `Sleep: ${entity.sleepType}${entity.endedAt ? " (finished)" : " (in progress)"}`,
          occurredAt: entity.startedAt,
        };
      },
    });
  }

  async update(
    principal: UserPrincipal,
    input: UpdateSleepInput
  ): Promise<CommandExecutionResult<SleepRecordEntity>> {
    return await executeFamilyUnitOfWork<SleepRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "update",
      entityType: "sleep",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.sleepRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row || row.deletedAt !== null) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const existing = await tx.sleepRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
        });
        if (!existing || existing.deletedAt !== null) {
          throw new RecordNotFoundError("sleep_record", input.id);
        }

        // Validate time ordering if updating either startedAt or endedAt
        const effectiveStartedAt = input.startedAt ?? existing.startedAt;
        const effectiveEndedAt = input.endedAt !== undefined ? input.endedAt : existing.endedAt;
        if (effectiveEndedAt && effectiveEndedAt < effectiveStartedAt) {
          const error = new Error("endedAt cannot be earlier than startedAt");
          (error as { statusCode?: number; code?: string }).statusCode = 400;
          (error as { statusCode?: number; code?: string }).code = "INVALID_SLEEP_INTERVAL";
          throw error;
        }

        // If setting endedAt to null, ensure no other active sleep exists
        if (input.endedAt === null && existing.endedAt !== null) {
          const otherActive = await tx.sleepRecord.findFirst({
            where: {
              babyId: input.babyId,
              id: { not: input.id },
              endedAt: null,
              deletedAt: null,
            },
            select: { id: true },
          });
          if (otherActive) {
            const error = new Error(`Another active sleep record (${otherActive.id}) already exists`);
            (error as { statusCode?: number; code?: string }).statusCode = 409;
            (error as { statusCode?: number; code?: string }).code = "ACTIVE_SLEEP_EXISTS";
            throw error;
          }
        }

        const data: Prisma.SleepRecordUncheckedUpdateInput = {
          version: meta.nextVersion,
          updatedAt: new Date(),
        };

        if (input.sleepType !== undefined) {
          data.sleepType = input.sleepType;
        }
        if (input.startedAt !== undefined) {
          data.startedAt = input.startedAt;
        }
        if (input.endedAt !== undefined) {
          data.endedAt = input.endedAt;
        }
        if (input.nightWakingCount !== undefined) {
          data.nightWakingCount = input.nightWakingCount;
        }
        if (input.notes !== undefined) {
          data.notes = input.notes;
        }

        const row = await tx.sleepRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data,
        });

        const entity = mapSleepRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            sleepType: entity.sleepType,
            startedAt: entity.startedAt.toISOString(),
            endedAt: entity.endedAt?.toISOString() ?? null,
            nightWakingCount: entity.nightWakingCount,
            version: entity.version,
          },
          summary: `Updated sleep: ${entity.sleepType}${entity.endedAt ? " (finished)" : " (in progress)"}`,
          occurredAt: entity.startedAt,
        };
      },
    });
  }

  async delete(
    principal: UserPrincipal,
    input: DeleteSleepInput
  ): Promise<CommandExecutionResult<SleepRecordEntity>> {
    return await executeFamilyUnitOfWork<SleepRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "delete",
      entityType: "sleep",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.sleepRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row || row.deletedAt !== null) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const row = await tx.sleepRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data: {
            version: meta.nextVersion,
            deletedAt: new Date(),
            updatedAt: new Date(),
          },
        });

        const entity = mapSleepRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            deleted: true,
            version: entity.version,
          },
          summary: `Deleted sleep: ${entity.id}`,
          occurredAt: entity.startedAt,
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
  ): Promise<CommandExecutionResult<SleepRecordEntity>> {
    return await executeFamilyUnitOfWork<SleepRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "restore",
      entityType: "sleep",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.sleepRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const row = await tx.sleepRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data: {
            version: meta.nextVersion,
            deletedAt: null,
            updatedAt: new Date(),
          },
        });

        const entity = mapSleepRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            sleepType: entity.sleepType,
            startedAt: entity.startedAt.toISOString(),
            endedAt: entity.endedAt?.toISOString() ?? null,
            nightWakingCount: entity.nightWakingCount,
            version: entity.version,
          },
          summary: `Restored sleep: ${entity.id}`,
          occurredAt: entity.startedAt,
        };
      },
    });
  }

  async findById(
    principal: UserPrincipal,
    familyId: string,
    babyId: string,
    id: string
  ): Promise<SleepRecordEntity | null> {
    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasFamily) throw new FamilyAccessDeniedError(familyId);

    const hasBaby = principal.babyMemberships?.some(
      (m) => m.userId === principal.userId && m.babyId === babyId && m.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId);

    const row = await this.prisma.sleepRecord.findUnique({
      where: { id },
    });
    if (!row || row.familyId !== familyId || row.babyId !== babyId || row.deletedAt !== null) {
      return null;
    }
    return mapSleepRow(row);
  }

  async findActiveByBaby(
    principal: UserPrincipal,
    familyId: string,
    babyId: string
  ): Promise<SleepRecordEntity | null> {
    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasFamily) throw new FamilyAccessDeniedError(familyId);

    const hasBaby = principal.babyMemberships?.some(
      (m) => m.userId === principal.userId && m.babyId === babyId && m.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId);

    const row = await this.prisma.sleepRecord.findFirst({
      where: {
        familyId,
        babyId,
        endedAt: null,
        deletedAt: null,
      },
    });
    if (!row) return null;
    return mapSleepRow(row);
  }

  async listByBaby(
    principal: UserPrincipal,
    familyId: string,
    babyId: string,
    options: { limit?: number; beforeStartedAt?: Date; beforeId?: string } = {}
  ): Promise<ReadonlyArray<SleepRecordEntity>> {
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

    const where: Prisma.SleepRecordWhereInput = {
      familyId,
      babyId,
      deletedAt: null,
    };

    if (options.beforeStartedAt) {
      if (options.beforeId) {
        where.OR = [
          { startedAt: { lt: options.beforeStartedAt } },
          {
            startedAt: options.beforeStartedAt,
            id: { lt: options.beforeId },
          },
        ];
      } else {
        where.startedAt = { lt: options.beforeStartedAt };
      }
    }

    const rows = await this.prisma.sleepRecord.findMany({
      where,
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: limit,
    });

    return rows.map(mapSleepRow);
  }
}

export const ScopedSleepRepository = SleepRepository;
export type ScopedSleepRepository = SleepRepository;