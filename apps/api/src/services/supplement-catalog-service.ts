import crypto from "node:crypto";
import { Prisma, type PrismaClient } from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import {
  BabyAccessDeniedError,
  BadRequestError,
  ConcurrencyConflictError,
  FamilyAccessDeniedError,
  RecordNotFoundError,
} from "@growdesk/database";
import type {
  CreateSupplementProductRequest,
  CreateSupplementScheduleRequest,
  SupplementProduct,
  SupplementSchedule,
  UpdateSupplementProductRequest,
} from "@growdesk/contracts";

type DateLike = Date | null;

function dateOnly(value: DateLike): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

function decimal(value: Prisma.Decimal | string | number | null | undefined, fallback = "0"): string {
  return value === null || value === undefined ? fallback : value.toString();
}

function jsonValue(value: Prisma.JsonValue | null): unknown {
  return value === null ? null : value;
}

function productDto(row: {
  id: string;
  familyId: string;
  name: string;
  brand: string | null;
  dosageForm: string | null;
  unitName: string;
  defaultDose: Prisma.Decimal;
  nutrientsJson: Prisma.JsonValue | null;
  notes: string | null;
  isActive: boolean;
  isArchived: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}): SupplementProduct {
  return {
    id: row.id,
    familyId: row.familyId,
    name: row.name,
    brand: row.brand,
    dosageForm: row.dosageForm,
    unitName: row.unitName,
    defaultDose: decimal(row.defaultDose),
    nutrientsJson: jsonValue(row.nutrientsJson),
    notes: row.notes,
    isActive: row.isActive && !row.isArchived,
    isArchived: row.isArchived,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function scheduleDto(row: {
  id: string;
  familyId: string;
  babyId: string;
  productId: string;
  frequency: string;
  customDaysJson: Prisma.JsonValue | null;
  targetDose: Prisma.Decimal;
  reminderTime: string | null;
  isActive: boolean;
  startDate: Date | null;
  notes: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  product: Parameters<typeof productDto>[0];
  isCompletedToday: boolean;
}): SupplementSchedule {
  return {
    id: row.id,
    familyId: row.familyId,
    babyId: row.babyId,
    productId: row.productId,
    product: productDto(row.product),
    frequency: row.frequency,
    customDays: jsonValue(row.customDaysJson),
    targetDose: decimal(row.targetDose),
    reminderTime: row.reminderTime,
    isActive: row.isActive,
    startDate: dateOnly(row.startDate),
    notes: row.notes,
    version: row.version,
    isCompletedToday: row.isCompletedToday,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class SupplementCatalogService {
  constructor(private readonly prisma: PrismaClient) {}

  private assertFamilyAccess(principal: UserPrincipal, familyId: string, write = false): void {
    const membership = principal.familyMemberships.find(
      (item) => item.familyId === familyId && item.status === "active",
    );
    if (!membership || (write && membership.role === "viewer")) {
      throw new FamilyAccessDeniedError(familyId);
    }
  }

  private async assertBabyAccess(
    principal: UserPrincipal,
    babyId: string,
    write = false,
  ): Promise<{ familyId: string }> {
    const membership = principal.babyMemberships?.find(
      (item) => item.babyId === babyId && item.status === "active",
    );
    if (!membership || (write && membership.role === "viewer")) {
      throw new BabyAccessDeniedError(babyId);
    }
    const baby = await this.prisma.baby.findUnique({
      where: { id: babyId },
      select: { familyId: true, deletedAt: true },
    });
    if (!baby || baby.deletedAt !== null || baby.familyId !== membership.familyId) {
      throw new BabyAccessDeniedError(babyId);
    }
    return { familyId: baby.familyId };
  }

  private async lockFamily(tx: Prisma.TransactionClient, familyId: string): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO "public"."family_sync_states" ("family_id", "epoch", "cursor", "created_at", "updated_at")
      VALUES (${familyId}, ${crypto.randomUUID()}, 0, NOW(), NOW())
      ON CONFLICT ("family_id") DO NOTHING
    `;
    await tx.$executeRaw`
      SELECT 1 FROM "public"."family_sync_states"
      WHERE "family_id" = ${familyId}
      FOR UPDATE
    `;
  }

  private async advanceFamily(tx: Prisma.TransactionClient, familyId: string): Promise<void> {
    await tx.familySyncState.update({
      where: { familyId },
      data: { cursor: { increment: 1 } },
    });
  }

  async listProducts(
    principal: UserPrincipal,
    familyId: string,
    options: { limit?: number; includeArchived?: boolean; cursor?: string } = {},
  ): Promise<{ data: SupplementProduct[]; page: { nextCursor: string | null } }> {
    this.assertFamilyAccess(principal, familyId);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    let cursorWhere: Prisma.SupplementProductWhereInput = {};
    if (options.cursor) {
      let decoded: string;
      try {
        decoded = Buffer.from(options.cursor, "base64url").toString("utf8");
      } catch {
        throw new BadRequestError("Invalid supplement product cursor", "INVALID_CURSOR");
      }
      const separator = decoded.indexOf("|");
      const datePart = separator > 0 ? decoded.slice(0, separator) : "";
      const id = separator > 0 ? decoded.slice(separator + 1) : "";
      const createdAt = new Date(datePart);
      // Promoted legacy products keep source-stable identifiers, so the
      // cursor must accept the same bounded URL-safe alphabet as path IDs
      // instead of assuming every row has a UUID primary key.
      if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !Number.isFinite(createdAt.getTime())) {
        throw new BadRequestError("Invalid supplement product cursor", "INVALID_CURSOR");
      }
      cursorWhere = {
        OR: [
          { createdAt: { lt: createdAt } },
          { createdAt, id: { lt: id } },
        ],
      };
    }
    const rows = await this.prisma.supplementProduct.findMany({
      where: {
        familyId,
        deletedAt: null,
        ...(options.includeArchived ? {} : { isArchived: false, isActive: true }),
        ...cursorWhere,
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });
    const visible = rows.slice(0, limit).map(productDto);
    const last = visible.at(-1);
    const hasMore = rows.length > limit;
    return {
      data: visible,
      page: { nextCursor: hasMore && last ? Buffer.from(`${last.createdAt}|${last.id}`).toString("base64url") : null },
    };
  }

  async createProduct(
    principal: UserPrincipal,
    familyId: string,
    input: CreateSupplementProductRequest,
  ): Promise<SupplementProduct> {
    this.assertFamilyAccess(principal, familyId, true);
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lockFamily(tx, familyId);
      const created = await tx.supplementProduct.create({
        data: {
          id: crypto.randomUUID(),
          familyId,
          name: input.name.trim(),
          brand: input.brand ?? null,
          dosageForm: input.dosageForm ?? null,
          unitName: input.unitName.trim(),
          defaultDose: new Prisma.Decimal(input.defaultDose ?? "1"),
          nutrientsJson: input.nutrientsJson === undefined ? Prisma.JsonNull : input.nutrientsJson as Prisma.InputJsonValue,
          notes: input.notes ?? null,
          isActive: true,
          isArchived: false,
          version: 1,
        },
      });
      await this.advanceFamily(tx, familyId);
      return created;
    });
    return productDto(row);
  }

  async updateProduct(
    principal: UserPrincipal,
    familyId: string,
    id: string,
    input: UpdateSupplementProductRequest,
  ): Promise<SupplementProduct> {
    this.assertFamilyAccess(principal, familyId, true);
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lockFamily(tx, familyId);
      const existing = await tx.supplementProduct.findUnique({ where: { id } });
      if (!existing || existing.familyId !== familyId || existing.deletedAt !== null) {
        throw new RecordNotFoundError("supplement_product", id);
      }
      if (input.baseVersion !== undefined && input.baseVersion !== existing.version) {
        throw new ConcurrencyConflictError("Supplement product changed; reload before saving");
      }
      const updated = await tx.supplementProduct.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.brand !== undefined ? { brand: input.brand } : {}),
          ...(input.dosageForm !== undefined ? { dosageForm: input.dosageForm } : {}),
          ...(input.unitName !== undefined ? { unitName: input.unitName.trim() } : {}),
          ...(input.defaultDose !== undefined ? { defaultDose: new Prisma.Decimal(input.defaultDose) } : {}),
          ...(input.nutrientsJson !== undefined ? { nutrientsJson: input.nutrientsJson === null ? Prisma.JsonNull : input.nutrientsJson as Prisma.InputJsonValue } : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.isArchived !== undefined ? { isArchived: input.isArchived } : {}),
          version: { increment: 1 },
        },
      });
      await this.advanceFamily(tx, familyId);
      return updated;
    });
    return productDto(row);
  }

  async deleteProduct(principal: UserPrincipal, familyId: string, id: string): Promise<{ id: string; deleted: true }> {
    this.assertFamilyAccess(principal, familyId, true);
    await this.prisma.$transaction(async (tx) => {
      await this.lockFamily(tx, familyId);
      const existing = await tx.supplementProduct.findUnique({ where: { id } });
      if (!existing || existing.familyId !== familyId || existing.deletedAt !== null) {
        throw new RecordNotFoundError("supplement_product", id);
      }
      await tx.supplementProduct.update({
        where: { id },
        data: { deletedAt: new Date(), isArchived: true, isActive: false, version: { increment: 1 } },
      });
      await tx.supplementSchedule.updateMany({
        where: { familyId, productId: id, deletedAt: null },
        data: { deletedAt: new Date(), isActive: false, version: { increment: 1 } },
      });
      await this.advanceFamily(tx, familyId);
    });
    return { id, deleted: true };
  }

  async listSchedules(
    principal: UserPrincipal,
    babyId: string,
    date?: string,
  ): Promise<{ data: SupplementSchedule[]; page: { nextCursor: string | null } }> {
    const { familyId } = await this.assertBabyAccess(principal, babyId);
    const day = date ? new Date(`${date}T00:00:00.000Z`) : new Date();
    const next = new Date(day.getTime() + 24 * 60 * 60 * 1000);
    const records = await this.prisma.supplementRecord.findMany({
      where: { familyId, babyId, deletedAt: null, occurredAt: { gte: day, lt: next } },
      select: { productId: true },
    });
    const completed = new Set(records.map((row) => row.productId).filter((id): id is string => Boolean(id)));
    const rows = await this.prisma.supplementSchedule.findMany({
      where: { familyId, babyId, deletedAt: null, isActive: true },
      include: { product: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return {
      data: rows.map((row) => scheduleDto({ ...row, isCompletedToday: completed.has(row.productId) })),
      page: { nextCursor: null },
    };
  }

  async upsertSchedule(
    principal: UserPrincipal,
    babyId: string,
    input: CreateSupplementScheduleRequest,
  ): Promise<{ schedule: SupplementSchedule; created: boolean }> {
    const { familyId } = await this.assertBabyAccess(principal, babyId, true);
    const row = await this.prisma.$transaction(async (tx) => {
      await this.lockFamily(tx, familyId);
      const product = await tx.supplementProduct.findUnique({ where: { id: input.productId } });
      if (!product || product.familyId !== familyId || product.deletedAt !== null) {
        throw new RecordNotFoundError("supplement_product", input.productId);
      }
      const existing = input.id
        ? await tx.supplementSchedule.findUnique({ where: { id: input.id } })
        : await tx.supplementSchedule.findFirst({ where: { familyId, babyId, productId: input.productId, deletedAt: null } });
      if (input.id && !existing) {
        throw new RecordNotFoundError("supplement_schedule", input.id);
      }
      if (existing && (existing.familyId !== familyId || existing.babyId !== babyId || existing.deletedAt !== null)) {
        throw new RecordNotFoundError("supplement_schedule", input.id || existing.id);
      }
      if (existing && input.baseVersion !== undefined && input.baseVersion !== existing.version) {
        throw new ConcurrencyConflictError("Supplement schedule changed; reload before saving");
      }
      const startDate = input.startDate === undefined ? (existing?.startDate ?? null) : input.startDate === null ? null : new Date(`${input.startDate}T00:00:00.000Z`);
      const data = {
        familyId,
        babyId,
        productId: input.productId,
        frequency: input.frequency ?? existing?.frequency ?? "daily",
        customDaysJson: input.customDays === undefined ? (existing?.customDaysJson ?? Prisma.JsonNull) : input.customDays === null ? Prisma.JsonNull : input.customDays as Prisma.InputJsonValue,
        targetDose: new Prisma.Decimal(input.targetDose ?? existing?.targetDose?.toString() ?? "1"),
        reminderTime: input.reminderTime === undefined ? (existing?.reminderTime ?? null) : input.reminderTime,
        isActive: input.isActive ?? existing?.isActive ?? true,
        startDate,
        notes: input.notes === undefined ? (existing?.notes ?? null) : input.notes,
        version: { increment: existing ? 1 : 0 },
        deletedAt: null,
      };
      const saved = existing
        ? await tx.supplementSchedule.update({ where: { id: existing.id }, data, include: { product: true } })
        : await tx.supplementSchedule.create({ data: { id: crypto.randomUUID(), ...data, version: 1 }, include: { product: true } });
      await this.advanceFamily(tx, familyId);
      return { saved, created: !existing };
    });
    return {
      created: row.created,
      schedule: scheduleDto({ ...row.saved, isCompletedToday: false }),
    };
  }

  async deleteSchedule(principal: UserPrincipal, babyId: string, id: string): Promise<{ id: string; deleted: true }> {
    const { familyId } = await this.assertBabyAccess(principal, babyId, true);
    await this.prisma.$transaction(async (tx) => {
      await this.lockFamily(tx, familyId);
      const existing = await tx.supplementSchedule.findUnique({ where: { id } });
      if (!existing || existing.familyId !== familyId || existing.babyId !== babyId || existing.deletedAt !== null) {
        throw new RecordNotFoundError("supplement_schedule", id);
      }
      await tx.supplementSchedule.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false, version: { increment: 1 } },
      });
      await this.advanceFamily(tx, familyId);
    });
    return { id, deleted: true };
  }
}
