import { PrismaClient, Prisma } from "./generated/client.js";
import { UserPrincipal } from "@growdesk/domain";
import { executeFamilyUnitOfWork, CommandExecutionResult } from "./unit-of-work.js";
import { FamilyAccessDeniedError, BabyAccessDeniedError, RecordNotFoundError } from "./errors.js";

export interface CreateGrowthMeasurementInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly measurementDate: Date | string;
  readonly weightKg?: string | null;
  readonly heightCm?: string | null;
  readonly headCircumferenceCm?: string | null;
  readonly attachmentId?: string | null;
  readonly notes?: string | null;
  readonly source?: string;
  readonly sourceAgent?: string | null;
}

export interface UpdateGrowthMeasurementInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly baseVersion: number;
  readonly measurementDate?: Date | string;
  readonly weightKg?: string | null;
  readonly heightCm?: string | null;
  readonly headCircumferenceCm?: string | null;
  readonly attachmentId?: string | null;
  readonly notes?: string | null;
}

export interface DeleteGrowthMeasurementInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly baseVersion: number;
}

export interface GrowthMeasurementEntity {
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly measurementDate: Date;
  readonly weightKg: string | null;
  readonly heightCm: string | null;
  readonly headCircumferenceCm: string | null;
  readonly attachmentId: string | null;
  readonly notes: string | null;
  readonly version: number;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function parseDateOnly(date: Date | string): Date {
  if (date instanceof Date) {
    return date;
  }
  return new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
}

function mapGrowthRow(row: {
  id: string;
  familyId: string;
  babyId: string;
  measurementDate: Date;
  weightKg: Prisma.Decimal | null;
  heightCm: Prisma.Decimal | null;
  headCircumferenceCm: Prisma.Decimal | null;
  attachmentId: string | null;
  notes: string | null;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): GrowthMeasurementEntity {
  return {
    id: row.id,
    familyId: row.familyId,
    babyId: row.babyId,
    measurementDate: row.measurementDate,
    weightKg: row.weightKg != null ? Number(row.weightKg).toFixed(2) : null,
    heightCm: row.heightCm != null ? Number(row.heightCm).toFixed(1) : null,
    headCircumferenceCm: row.headCircumferenceCm != null ? Number(row.headCircumferenceCm).toFixed(1) : null,
    attachmentId: row.attachmentId,
    notes: row.notes,
    version: row.version,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function formatGrowthSummary(entity: GrowthMeasurementEntity): string {
  const parts: string[] = [];
  if (entity.weightKg) parts.push(`${entity.weightKg} kg`);
  if (entity.heightCm) parts.push(`${entity.heightCm} cm`);
  if (entity.headCircumferenceCm) parts.push(`head ${entity.headCircumferenceCm} cm`);
  return `Growth: ${parts.join(", ") || "Recorded"}`;
}

export class ScopedGrowthRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    principal: UserPrincipal,
    input: CreateGrowthMeasurementInput
  ): Promise<CommandExecutionResult<GrowthMeasurementEntity>> {
    const measurementDate = parseDateOnly(input.measurementDate);

    return await executeFamilyUnitOfWork<GrowthMeasurementEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "create",
      entityType: "growth",
      entityId: input.id,
      baseVersion: null,
      getExistingVersion: async (tx) => {
        const row = await tx.growthMeasurement.findUnique({
          where: { id: input.id },
          select: { version: true },
        });
        return row?.version ?? null;
      },
      execute: async (tx, meta) => {
        const row = await tx.growthMeasurement.create({
          data: {
            id: input.id,
            familyId: input.familyId,
            babyId: input.babyId,
            measurementDate,
            weightKg: input.weightKg != null ? new Prisma.Decimal(input.weightKg) : null,
            heightCm: input.heightCm != null ? new Prisma.Decimal(input.heightCm) : null,
            headCircumferenceCm: input.headCircumferenceCm != null ? new Prisma.Decimal(input.headCircumferenceCm) : null,
            attachmentId: input.attachmentId ?? null,
            notes: input.notes ?? null,
            version: meta.nextVersion,
          },
        });

        const entity = mapGrowthRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            measurementDate: entity.measurementDate.toISOString().slice(0, 10),
            weightKg: entity.weightKg,
            heightCm: entity.heightCm,
            headCircumferenceCm: entity.headCircumferenceCm,
            version: entity.version,
          },
          summary: formatGrowthSummary(entity),
          occurredAt: entity.measurementDate,
        };
      },
    });
  }

  async update(
    principal: UserPrincipal,
    input: UpdateGrowthMeasurementInput
  ): Promise<CommandExecutionResult<GrowthMeasurementEntity>> {
    return await executeFamilyUnitOfWork<GrowthMeasurementEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "update",
      entityType: "growth",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.growthMeasurement.findUnique({
          where: { id: input.id },
          select: { version: true, deletedAt: true },
        });
        if (!row || row.deletedAt !== null) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const existing = await tx.growthMeasurement.findUnique({
          where: { id: input.id },
        });
        if (!existing || existing.deletedAt !== null) {
          throw new RecordNotFoundError("growth_measurement", input.id);
        }

        const data: Prisma.GrowthMeasurementUncheckedUpdateInput = {
          version: meta.nextVersion,
          updatedAt: new Date(),
        };

        if (input.measurementDate !== undefined) {
          data.measurementDate = parseDateOnly(input.measurementDate);
        }
        if (input.weightKg !== undefined) {
          data.weightKg = input.weightKg != null ? new Prisma.Decimal(input.weightKg) : null;
        }
        if (input.heightCm !== undefined) {
          data.heightCm = input.heightCm != null ? new Prisma.Decimal(input.heightCm) : null;
        }
        if (input.headCircumferenceCm !== undefined) {
          data.headCircumferenceCm =
            input.headCircumferenceCm != null ? new Prisma.Decimal(input.headCircumferenceCm) : null;
        }
        if (input.attachmentId !== undefined) {
          data.attachmentId = input.attachmentId;
        }
        if (input.notes !== undefined) {
          data.notes = input.notes;
        }

        const row = await tx.growthMeasurement.update({
          where: { id: input.id },
          data,
        });

        const entity = mapGrowthRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            measurementDate: entity.measurementDate.toISOString().slice(0, 10),
            weightKg: entity.weightKg,
            heightCm: entity.heightCm,
            headCircumferenceCm: entity.headCircumferenceCm,
            version: entity.version,
          },
          summary: formatGrowthSummary(entity),
          occurredAt: entity.measurementDate,
        };
      },
    });
  }

  async delete(
    principal: UserPrincipal,
    input: DeleteGrowthMeasurementInput
  ): Promise<CommandExecutionResult<GrowthMeasurementEntity>> {
    return await executeFamilyUnitOfWork<GrowthMeasurementEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "delete",
      entityType: "growth",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.growthMeasurement.findUnique({
          where: { id: input.id },
          select: { version: true, deletedAt: true },
        });
        if (!row || row.deletedAt !== null) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const row = await tx.growthMeasurement.update({
          where: { id: input.id },
          data: {
            version: meta.nextVersion,
            deletedAt: new Date(),
            updatedAt: new Date(),
          },
        });

        const entity = mapGrowthRow(row);
        return {
          result: entity,
          payload: {
            id: entity.id,
            deletedAt: entity.deletedAt?.toISOString() ?? null,
            version: entity.version,
          },
          summary: `Deleted growth measurement: ${entity.id}`,
          occurredAt: entity.measurementDate,
        };
      },
    });
  }

  async findById(
    principal: UserPrincipal,
    familyId: string,
    babyId: string,
    id: string
  ): Promise<GrowthMeasurementEntity | null> {
    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasFamily) throw new FamilyAccessDeniedError(familyId);

    const hasBaby = principal.babyMemberships?.some(
      (bm) => bm.familyId === familyId && bm.babyId === babyId && bm.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId, "ACCESS_DENIED");

    const row = await this.prisma.growthMeasurement.findFirst({
      where: {
        id,
        familyId,
        babyId,
        deletedAt: null,
      },
    });

    return row ? mapGrowthRow(row) : null;
  }

  async listByBaby(
    principal: UserPrincipal,
    familyId: string,
    babyId: string,
    options: {
      limit?: number;
      beforeMeasurementDate?: Date;
      beforeId?: string;
    } = {}
  ): Promise<GrowthMeasurementEntity[]> {
    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasFamily) throw new FamilyAccessDeniedError(familyId);

    const hasBaby = principal.babyMemberships?.some(
      (bm) => bm.familyId === familyId && bm.babyId === babyId && bm.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId, "ACCESS_DENIED");

    const limit = options.limit ?? 50;

    const where: Prisma.GrowthMeasurementWhereInput = {
      familyId,
      babyId,
      deletedAt: null,
    };

    if (options.beforeMeasurementDate && options.beforeId) {
      where.OR = [
        {
          measurementDate: {
            lt: options.beforeMeasurementDate,
          },
        },
        {
          measurementDate: options.beforeMeasurementDate,
          id: {
            lt: options.beforeId,
          },
        },
      ];
    }

    const rows = await this.prisma.growthMeasurement.findMany({
      where,
      orderBy: [
        { measurementDate: "desc" },
        { id: "desc" },
      ],
      take: limit,
    });

    return rows.map(mapGrowthRow);
  }

  async listAllForChart(
    principal: UserPrincipal,
    familyId: string,
    babyId: string
  ): Promise<GrowthMeasurementEntity[]> {
    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasFamily) throw new FamilyAccessDeniedError(familyId);

    const hasBaby = principal.babyMemberships?.some(
      (bm) => bm.familyId === familyId && bm.babyId === babyId && bm.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId, "ACCESS_DENIED");

    const rows = await this.prisma.growthMeasurement.findMany({
      where: {
        familyId,
        babyId,
        deletedAt: null,
      },
      orderBy: [
        { measurementDate: "asc" },
        { id: "asc" },
      ],
    });

    return rows.map(mapGrowthRow);
  }
}
