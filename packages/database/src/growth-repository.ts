import { PrismaClient, Prisma } from "./generated/client.js";
import { UserPrincipal } from "@growdesk/domain";
import { executeFamilyUnitOfWork, type CommandExecutionResult, type TransactionClient } from "./unit-of-work.js";
import { BadRequestError, FamilyAccessDeniedError, BabyAccessDeniedError, RecordNotFoundError } from "./errors.js";

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
  /**
   * A narrow, typed projection of the importer metadata.  Keep the raw JSONB
   * private so arbitrary archive fields (including credentials) cannot cross
   * the repository/API boundary.
   */
  readonly legacyDate: string | null;
  readonly legacyAgeInMonths: number | null;
  readonly legacyAgeLabel: string | null;
  readonly legacyPercentile: number | null;
  readonly legacyClientId: string | null;
  readonly legacyRecordedById: string | null;
  readonly legacySource: string | null;
  readonly legacySourceAgent: string | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type LegacyMetadataObject = Record<string, unknown>;

function metadataObject(value: Prisma.JsonValue | null): LegacyMetadataObject | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as LegacyMetadataObject;
}

function metadataObjectField(value: unknown, key: string): LegacyMetadataObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  if (typeof field !== "object" || field === null || Array.isArray(field)) return null;
  return field as LegacyMetadataObject;
}

function legacyDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : null;
}

function legacyText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function legacyNonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function legacyPercentile(value: unknown): number | null {
  const result = legacyNonnegativeInteger(value);
  return result !== null && result <= 100 ? result : null;
}

function mapLegacyGrowthMetadata(
  legacyClientId: string | null,
  rawMetadata: Prisma.JsonValue | null,
): Pick<
  GrowthMeasurementEntity,
  | "legacyDate"
  | "legacyAgeInMonths"
  | "legacyAgeLabel"
  | "legacyPercentile"
  | "legacyClientId"
  | "legacyRecordedById"
  | "legacySource"
  | "legacySourceAgent"
> {
  const metadata = metadataObject(rawMetadata);
  // Only rows emitted by the GrowthMeasurement importer may opt into the
  // compatibility projection. A date-looking arbitrary JSON value is not
  // sufficient to make a canonical row appear imported.
  if (metadata?.sourceTable !== "GrowthMeasurement") {
    return {
      legacyDate: null,
      legacyAgeInMonths: null,
      legacyAgeLabel: null,
      legacyPercentile: null,
      legacyClientId: null,
      legacyRecordedById: null,
      legacySource: null,
      legacySourceAgent: null,
    };
  }

  const date = legacyDate(metadata.legacyDate);
  if (date === null) {
    return {
      legacyDate: null,
      legacyAgeInMonths: null,
      legacyAgeLabel: null,
      legacyPercentile: null,
      legacyClientId: null,
      legacyRecordedById: null,
      legacySource: null,
      legacySourceAgent: null,
    };
  }

  const growth = metadataObjectField(metadata, "legacyGrowth");
  return {
    legacyDate: date,
    legacyAgeInMonths: legacyNonnegativeInteger(growth?.ageInMonths),
    legacyAgeLabel: legacyText(growth?.ageLabel),
    legacyPercentile: legacyPercentile(growth?.percentile),
    legacyClientId: legacyClientId ?? legacyText(metadata.legacyClientId),
    legacyRecordedById: legacyText(metadata.legacyRecordedById),
    legacySource: legacyText(metadata.legacySource),
    legacySourceAgent: legacyText(metadata.legacySourceAgent),
  };
}

function parseDateOnly(date: Date | string): Date {
  if (date instanceof Date) {
    return date;
  }
  return new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
}

export function mapGrowthRow(row: {
  id: string;
  familyId: string;
  babyId: string;
  measurementDate: Date;
  weightKg: Prisma.Decimal | null;
  heightCm: Prisma.Decimal | null;
  headCircumferenceCm: Prisma.Decimal | null;
  attachmentId: string | null;
  notes: string | null;
  legacyClientId: string | null;
  legacyMetadata: Prisma.JsonValue | null;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): GrowthMeasurementEntity {
  const legacy = mapLegacyGrowthMetadata(row.legacyClientId, row.legacyMetadata);
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
    ...legacy,
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

/**
 * A growth photo is a family/baby-scoped attachment, not an arbitrary object
 * key supplied by the client. The row lock shares the delete lock in
 * AttachmentService: a delete that wins makes this validation fail, while a
 * successful validation prevents the attachment from being deleted until the
 * growth mutation commits.
 */
async function validateGrowthAttachment(
  tx: TransactionClient,
  attachmentId: string | null | undefined,
  familyId: string,
  babyId: string,
): Promise<void> {
  if (attachmentId == null) return;

  await tx.$queryRaw`SELECT id FROM public.attachments WHERE id = ${attachmentId} FOR UPDATE`;
  const attachment = await tx.attachment.findUnique({
    where: { id: attachmentId },
    select: {
      familyId: true,
      babyId: true,
      purpose: true,
      status: true,
      mimeType: true,
      deletedAt: true,
    },
  });

  if (!attachment) {
    throw new RecordNotFoundError("Attachment", attachmentId);
  }
  if (attachment.familyId !== familyId) {
    throw new FamilyAccessDeniedError(familyId);
  }
  if (attachment.babyId !== babyId) {
    throw new BabyAccessDeniedError(babyId, "ATTACHMENT_ACCESS_DENIED");
  }
  if (
    attachment.purpose !== "growth_photo" ||
    !attachment.mimeType.startsWith("image/") ||
    attachment.status !== "ready" ||
    attachment.deletedAt !== null
  ) {
    throw new BadRequestError(
      "Attachment must be a ready growth photo",
      "INVALID_GROWTH_ATTACHMENT",
    );
  }
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
        await validateGrowthAttachment(tx, input.attachmentId, input.familyId, input.babyId);
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

        await validateGrowthAttachment(tx, input.attachmentId, input.familyId, input.babyId);

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
