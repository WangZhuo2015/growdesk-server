import { PrismaClient, Prisma } from "./generated/client.js";
import { UserPrincipal } from "@growdesk/domain";
import { executeFamilyUnitOfWork, CommandExecutionResult } from "./unit-of-work.js";
import { FamilyAccessDeniedError, BabyAccessDeniedError, RecordNotFoundError } from "./errors.js";

export interface CreateFoodInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly recordDate: string;
  readonly mealType: string;
  readonly occurredAt?: Date | null;
  readonly foodItemIds?: string[];
  readonly portionDescription?: string | null;
  readonly reaction?: string | null;
  readonly notes?: string | null;
}

export interface UpdateFoodInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly baseVersion: number;
  readonly recordDate?: string;
  readonly mealType?: string;
  readonly occurredAt?: Date | null;
  readonly foodItemIds?: string[];
  readonly portionDescription?: string | null;
  readonly reaction?: string | null;
  readonly notes?: string | null;
}

export interface DeleteFoodInput {
  readonly commandId: string;
  readonly requestHash: string;
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly baseVersion: number;
}

export interface FoodRecordEntity {
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly recordDate: string;
  readonly mealType: string;
  readonly occurredAt: Date | null;
  readonly foodItemIds: string[];
  readonly portionDescription: string | null;
  readonly reaction: string | null;
  readonly notes: string | null;
  readonly version: number;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FoodLibraryItemEntity {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly allergenRisk: "low" | "medium" | "high";
  readonly recommendedAgeMonths: number;
  readonly familyStatus?: {
    readonly tried: boolean;
    readonly reaction: string | null;
  };
}

export interface BabyFoodPlanEntity {
  readonly babyId: string;
  readonly planData: Record<string, unknown>;
  readonly updatedAt: Date;
}

function mapFoodRow(row: {
  id: string;
  familyId: string;
  babyId: string;
  recordDate: string;
  mealType: string;
  occurredAt: Date | null;
  foodItemIds: string[];
  portionDescription: string | null;
  reaction: string | null;
  notes: string | null;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): FoodRecordEntity {
  return {
    ...row,
  };
}

export class FoodRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(
    principal: UserPrincipal,
    input: CreateFoodInput
  ): Promise<CommandExecutionResult<FoodRecordEntity>> {
    return await executeFamilyUnitOfWork<FoodRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "create",
      entityType: "food",
      entityId: input.id,
      baseVersion: null,
      getExistingVersion: async (tx) => {
        const row = await tx.foodRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true },
        });
        return row?.version ?? null;
      },
      execute: async (tx, meta) => {
        const row = await tx.foodRecord.create({
          data: {
            id: input.id,
            familyId: input.familyId,
            babyId: input.babyId,
            recordDate: input.recordDate,
            mealType: input.mealType,
            occurredAt: input.occurredAt ?? null,
            foodItemIds: input.foodItemIds ?? [],
            portionDescription: input.portionDescription ?? null,
            reaction: input.reaction ?? null,
            notes: input.notes ?? null,
            version: meta.nextVersion,
          },
        });

        const entity = mapFoodRow(row);
        const occurredAt = entity.occurredAt ?? new Date(`${entity.recordDate}T12:00:00.000Z`);

        return {
          result: entity,
          payload: {
            id: entity.id,
            recordDate: entity.recordDate,
            mealType: entity.mealType,
            occurredAt: entity.occurredAt?.toISOString() ?? null,
            foodItemIds: entity.foodItemIds,
            portionDescription: entity.portionDescription,
            reaction: entity.reaction,
            version: entity.version,
          },
          summary: `Food: ${entity.mealType}`,
          occurredAt,
        };
      },
    });
  }

  async update(
    principal: UserPrincipal,
    input: UpdateFoodInput
  ): Promise<CommandExecutionResult<FoodRecordEntity>> {
    return await executeFamilyUnitOfWork<FoodRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "update",
      entityType: "food",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.foodRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row || row.deletedAt !== null) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const existing = await tx.foodRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
        });
        if (!existing || existing.deletedAt !== null) {
          throw new RecordNotFoundError("food_record", input.id);
        }

        const data: Prisma.FoodRecordUncheckedUpdateInput = {
          version: meta.nextVersion,
          updatedAt: new Date(),
        };

        if (input.recordDate !== undefined) {
          data.recordDate = input.recordDate;
        }
        if (input.mealType !== undefined) {
          data.mealType = input.mealType;
        }
        if (input.occurredAt !== undefined) {
          data.occurredAt = input.occurredAt;
        }
        if (input.foodItemIds !== undefined) {
          data.foodItemIds = input.foodItemIds;
        }
        if (input.portionDescription !== undefined) {
          data.portionDescription = input.portionDescription;
        }
        if (input.reaction !== undefined) {
          data.reaction = input.reaction;
        }
        if (input.notes !== undefined) {
          data.notes = input.notes;
        }

        const row = await tx.foodRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data,
        });

        const entity = mapFoodRow(row);
        const occurredAt = entity.occurredAt ?? new Date(`${entity.recordDate}T12:00:00.000Z`);

        return {
          result: entity,
          payload: {
            id: entity.id,
            recordDate: entity.recordDate,
            mealType: entity.mealType,
            occurredAt: entity.occurredAt?.toISOString() ?? null,
            foodItemIds: entity.foodItemIds,
            portionDescription: entity.portionDescription,
            reaction: entity.reaction,
            version: entity.version,
          },
          summary: `Updated food: ${entity.mealType}`,
          occurredAt,
        };
      },
    });
  }

  async delete(
    principal: UserPrincipal,
    input: DeleteFoodInput
  ): Promise<CommandExecutionResult<FoodRecordEntity>> {
    return await executeFamilyUnitOfWork<FoodRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "delete",
      entityType: "food",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.foodRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row || row.deletedAt !== null) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const row = await tx.foodRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data: {
            version: meta.nextVersion,
            deletedAt: new Date(),
            updatedAt: new Date(),
          },
        });

        const entity = mapFoodRow(row);
        const occurredAt = entity.occurredAt ?? new Date(`${entity.recordDate}T12:00:00.000Z`);

        return {
          result: entity,
          payload: {
            id: entity.id,
            deleted: true,
            version: entity.version,
          },
          summary: `Deleted food: ${entity.id}`,
          occurredAt,
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
  ): Promise<CommandExecutionResult<FoodRecordEntity>> {
    return await executeFamilyUnitOfWork<FoodRecordEntity>(this.prisma, {
      principal,
      familyId: input.familyId,
      babyId: input.babyId,
      commandId: input.commandId,
      requestHash: input.requestHash,
      operation: "restore",
      entityType: "food",
      entityId: input.id,
      baseVersion: input.baseVersion,
      getExistingVersion: async (tx) => {
        const row = await tx.foodRecord.findUnique({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          select: { version: true, deletedAt: true },
        });
        if (!row) return null;
        return row.version;
      },
      execute: async (tx, meta) => {
        const row = await tx.foodRecord.update({
          where: { id: input.id, familyId: input.familyId, babyId: input.babyId },
          data: {
            version: meta.nextVersion,
            deletedAt: null,
            updatedAt: new Date(),
          },
        });

        const entity = mapFoodRow(row);
        const occurredAt = entity.occurredAt ?? new Date(`${entity.recordDate}T12:00:00.000Z`);

        return {
          result: entity,
          payload: {
            id: entity.id,
            recordDate: entity.recordDate,
            mealType: entity.mealType,
            occurredAt: entity.occurredAt?.toISOString() ?? null,
            foodItemIds: entity.foodItemIds,
            portionDescription: entity.portionDescription,
            reaction: entity.reaction,
            version: entity.version,
          },
          summary: `Restored food: ${entity.id}`,
          occurredAt,
        };
      },
    });
  }

  async findById(
    principal: UserPrincipal,
    familyId: string,
    babyId: string,
    id: string
  ): Promise<FoodRecordEntity | null> {
    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasFamily) throw new FamilyAccessDeniedError(familyId);

    const hasBaby = principal.babyMemberships?.some(
      (m) => m.userId === principal.userId && m.babyId === babyId && m.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId);

    const row = await this.prisma.foodRecord.findUnique({
      where: { id },
    });
    if (!row || row.familyId !== familyId || row.babyId !== babyId || row.deletedAt !== null) {
      return null;
    }
    return mapFoodRow(row);
  }

  async listByBaby(
    principal: UserPrincipal,
    familyId: string,
    babyId: string,
    options: { limit?: number; beforeRecordDate?: string; beforeId?: string } = {}
  ): Promise<ReadonlyArray<FoodRecordEntity>> {
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

    const where: Prisma.FoodRecordWhereInput = {
      familyId,
      babyId,
      deletedAt: null,
    };

    if (options.beforeRecordDate) {
      if (options.beforeId) {
        where.OR = [
          { recordDate: { lt: options.beforeRecordDate } },
          {
            recordDate: options.beforeRecordDate,
            id: { lt: options.beforeId },
          },
        ];
      } else {
        where.recordDate = { lt: options.beforeRecordDate };
      }
    }

    const rows = await this.prisma.foodRecord.findMany({
      where,
      orderBy: [{ recordDate: "desc" }, { id: "desc" }],
      take: limit,
    });

    return rows.map(mapFoodRow);
  }
}

export const ScopedFoodRepository = FoodRepository;
export type ScopedFoodRepository = FoodRepository;

export class FoodLibraryRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listItems(familyId?: string): Promise<FoodLibraryItemEntity[]> {
    const items = await this.prisma.foodLibraryItem.findMany({
      where: familyId
        ? {
            OR: [
              { isCustom: false },
              { isCustom: true, familyId },
            ],
          }
        : { isCustom: false },
      orderBy: [{ recommendedAgeMonths: "asc" }, { name: "asc" }],
    });

    const statuses: Map<string, { tried: boolean; reaction: string | null }> = new Map();
    if (familyId) {
      const statusRows = await this.prisma.familyFoodStatus.findMany({
        where: { familyId },
      });
      for (const row of statusRows) {
        statuses.set(row.foodItemId, { tried: row.tried, reaction: row.reaction });
      }
    }

    return items.map((item) => {
      const st = statuses.get(item.id);
      return {
        id: item.id,
        name: item.name,
        category: item.category,
        allergenRisk: item.allergenRisk as "low" | "medium" | "high",
        recommendedAgeMonths: item.recommendedAgeMonths,
        familyStatus: st ? { tried: st.tried, reaction: st.reaction } : undefined,
      };
    });
  }

  async createCustomItem(
    familyId: string,
    input: {
      name: string;
      category: string;
      allergenRisk: "low" | "medium" | "high";
      recommendedAgeMonths: number;
    }
  ): Promise<FoodLibraryItemEntity> {
    const id = `custom_${crypto.randomUUID()}`;
    const row = await this.prisma.foodLibraryItem.create({
      data: {
        id,
        name: input.name,
        category: input.category,
        allergenRisk: input.allergenRisk,
        recommendedAgeMonths: input.recommendedAgeMonths,
        isCustom: true,
        familyId,
      },
    });

    return {
      id: row.id,
      name: row.name,
      category: row.category,
      allergenRisk: row.allergenRisk as "low" | "medium" | "high",
      recommendedAgeMonths: row.recommendedAgeMonths,
    };
  }

  async updateFamilyStatus(
    familyId: string,
    foodItemId: string,
    status: { tried: boolean; reaction: string | null }
  ): Promise<void> {
    await this.prisma.familyFoodStatus.upsert({
      where: {
        uq_family_food_statuses: {
          familyId,
          foodItemId,
        },
      },
      create: {
        id: crypto.randomUUID(),
        familyId,
        foodItemId,
        tried: status.tried,
        reaction: status.reaction,
      },
      update: {
        tried: status.tried,
        reaction: status.reaction,
        updatedAt: new Date(),
      },
    });
  }
}

export class FoodPlanRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async getPlan(familyId: string, babyId: string): Promise<BabyFoodPlanEntity | null> {
    const row = await this.prisma.babyFoodPlan.findUnique({
      where: { babyId },
    });
    if (!row || row.familyId !== familyId) return null;
    return {
      babyId: row.babyId,
      planData: row.planData as Record<string, unknown>,
      updatedAt: row.updatedAt,
    };
  }

  async savePlan(
    familyId: string,
    babyId: string,
    planData: Record<string, unknown>
  ): Promise<BabyFoodPlanEntity> {
    const row = await this.prisma.babyFoodPlan.upsert({
      where: { babyId },
      create: {
        id: crypto.randomUUID(),
        familyId,
        babyId,
        planData: planData as Prisma.InputJsonValue,
      },
      update: {
        planData: planData as Prisma.InputJsonValue,
        updatedAt: new Date(),
      },
    });
    return {
      babyId: row.babyId,
      planData: row.planData as Record<string, unknown>,
      updatedAt: row.updatedAt,
    };
  }
}
