import { PrismaClient, Prisma } from "./generated/client.js";
import { UserPrincipal } from "@growdesk/domain";
import { executeFamilyUnitOfWork, CommandExecutionResult } from "./unit-of-work.js";
import { FamilyAccessDeniedError, BabyAccessDeniedError, RecordNotFoundError } from "./errors.js";

export interface CreateSupplementInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly supplementName: string;
  readonly occurredAt: Date;
  readonly amount?: string | null;
  readonly notes?: string | null;
  readonly source?: string;
  readonly sourceAgent?: string | null;
}

export interface UpdateSupplementInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly baseVersion: number;
  readonly supplementName?: string;
  readonly occurredAt?: Date;
  readonly amount?: string | null;
  readonly notes?: string | null;
}

export interface DeleteSupplementInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly baseVersion: number;
}

export interface SupplementRecordEntity {
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly supplementName: string;
  readonly occurredAt: Date;
  readonly amount: string | null;
  readonly notes: string | null;
  readonly recordedByUserId: string | null;
  readonly version: number;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function mapSupplementRow(row: {
  id: string;
  familyId: string;
  babyId: string;
  supplementName: string;
  occurredAt: Date;
  amount: string | null;
  notes: string | null;
  recordedByUserId: string | null;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): SupplementRecordEntity {
  return {
    ...row,
  };
}

export class SupplementRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    principal: UserPrincipal,
    input: CreateSupplementInput
  ): Promise<CommandExecutionResult<SupplementRecordEntity>> {
    return await executeFamilyUnitOfWork<SupplementRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "create",
      entityType: "supplement",
      entityId: input.id,
      baseVersion: null,
      getExistingVersion: async (tx) => {
        const row = await tx.supplementRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true },
        });
        return row?.version ?? null;
      },
      execute: async (tx, meta) => {
        const row = await tx.supplementRecord.create({
          data: {
            id: input.id,
            familyId: input.familyId,
            babyId: input.babyId,
            supplementName: input.supplementName,
            occurredAt: input.occurredAt,
            amount: input.amount ?? null,
            notes: input.notes ?? null,
            recordedByUserId: principal.userId,
            version: meta.nextVersion,
          },
        });

        const entity = mapSupplementRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            supplementName: entity.supplementName,
            occurredAt: entity.occurredAt.toISOString(),
            amount: entity.amount,
            version: entity.version,
          },
          summary: `Supplement: ${entity.supplementName}`,
          occurredAt: entity.occurredAt,
        };
      },
    });
  }

  async update(
    principal: UserPrincipal,
    input: UpdateSupplementInput
  ): Promise<CommandExecutionResult<SupplementRecordEntity>> {
    return await executeFamilyUnitOfWork<SupplementRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "update",
      entityType: "supplement",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.supplementRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row || row.deletedAt !== null) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const existing = await tx.supplementRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
        });
        if (!existing || existing.deletedAt !== null) {
          throw new RecordNotFoundError("supplement_record", input.id);
        }

        const data: Prisma.SupplementRecordUncheckedUpdateInput = {
          version: meta.nextVersion,
          updatedAt: new Date(),
        };

        if (input.supplementName !== undefined) {
          data.supplementName = input.supplementName;
        }
        if (input.occurredAt !== undefined) {
          data.occurredAt = input.occurredAt;
        }
        if (input.amount !== undefined) {
          data.amount = input.amount;
        }
        if (input.notes !== undefined) {
          data.notes = input.notes;
        }

        const row = await tx.supplementRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data,
        });

        const entity = mapSupplementRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            supplementName: entity.supplementName,
            occurredAt: entity.occurredAt.toISOString(),
            amount: entity.amount,
            version: entity.version,
          },
          summary: `Updated supplement: ${entity.supplementName}`,
          occurredAt: entity.occurredAt,
        };
      },
    });
  }

  async delete(
    principal: UserPrincipal,
    input: DeleteSupplementInput
  ): Promise<CommandExecutionResult<SupplementRecordEntity>> {
    return await executeFamilyUnitOfWork<SupplementRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "delete",
      entityType: "supplement",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.supplementRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row || row.deletedAt !== null) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const row = await tx.supplementRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data: {
            version: meta.nextVersion,
            deletedAt: new Date(),
            updatedAt: new Date(),
          },
        });

        const entity = mapSupplementRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            deleted: true,
            version: entity.version,
          },
          summary: `Deleted supplement: ${entity.id}`,
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
  ): Promise<CommandExecutionResult<SupplementRecordEntity>> {
    return await executeFamilyUnitOfWork<SupplementRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "restore",
      entityType: "supplement",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.supplementRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const row = await tx.supplementRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data: {
            version: meta.nextVersion,
            deletedAt: null,
            updatedAt: new Date(),
          },
        });

        const entity = mapSupplementRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            supplementName: entity.supplementName,
            occurredAt: entity.occurredAt.toISOString(),
            amount: entity.amount,
            version: entity.version,
          },
          summary: `Restored supplement: ${entity.id}`,
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
  ): Promise<SupplementRecordEntity | null> {
    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasFamily) throw new FamilyAccessDeniedError(familyId);

    const hasBaby = principal.babyMemberships?.some(
      (m) => m.userId === principal.userId && m.babyId === babyId && m.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId);

    const row = await this.prisma.supplementRecord.findUnique({
      where: { id },
    });
    if (!row || row.familyId !== familyId || row.babyId !== babyId || row.deletedAt !== null) {
      return null;
    }
    return mapSupplementRow(row);
  }

  async listByBaby(
    principal: UserPrincipal,
    familyId: string,
    babyId: string,
    options: { limit?: number; beforeOccurredAt?: Date; beforeId?: string } = {}
  ): Promise<ReadonlyArray<SupplementRecordEntity>> {
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

    const where: Prisma.SupplementRecordWhereInput = {
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

    const rows = await this.prisma.supplementRecord.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: limit,
    });

    return rows.map(mapSupplementRow);
  }
}

export const ScopedSupplementRepository = SupplementRepository;
export type ScopedSupplementRepository = SupplementRepository;
