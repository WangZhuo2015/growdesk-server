import type { PrismaClient } from "@growdesk/database";
import {
  ScopedFoodRepository,
  FoodLibraryRepository,
  FoodPlanRepository,
  type FoodRecordEntity,
  RecordNotFoundError,
  BabyAccessDeniedError,
  FamilyAccessDeniedError,
  BadRequestError,
} from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import type {
  CreateFoodRequest,
  UpdateFoodRequest,
  FoodRecord,
  MealType,
  FoodReaction,
  FoodLibraryItem,
  CreateFoodLibraryItemRequest,
  FoodLibraryItemsQuery,
  FoodGuidelineItem,
  FoodPlan,
} from "@growdesk/contracts";
import crypto from "node:crypto";

const MAX_FOOD_PLAN_VERSION = 9_223_372_036_854_775_807n;

function parseFoodPlanVersion(value: string): bigint {
  let version: bigint;
  try {
    version = BigInt(value);
  } catch {
    throw new BadRequestError("baseVersion must be a non-negative 64-bit integer", "INVALID_BASE_VERSION");
  }
  if (version < 0n || version > MAX_FOOD_PLAN_VERSION) {
    throw new BadRequestError("baseVersion must be a non-negative 64-bit integer", "INVALID_BASE_VERSION");
  }
  return version;
}

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

export function encodeFoodCursor(recordDate: string, id: string): string {
  return Buffer.from(`${recordDate}|${id}`).toString("base64url");
}

export function decodeFoodCursor(cursor: string): { recordDate: string; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const [recordDate, id] = raw.split("|");
    if (!recordDate || !id) return null;
    return { recordDate, id };
  } catch {
    return null;
  }
}

export function mapEntityToFoodRecord(entity: FoodRecordEntity): FoodRecord {
  const toIso = (d: Date | string): string =>
    typeof d === "string" ? new Date(d).toISOString() : d.toISOString();

  return {
    id: entity.id,
    babyId: entity.babyId,
    familyId: entity.familyId,
    recordDate: entity.recordDate,
    mealType: entity.mealType as MealType,
    occurredAt: entity.occurredAt ? toIso(entity.occurredAt) : null,
    foodItemIds: entity.foodItemIds,
    portionDescription: entity.portionDescription,
    reaction: entity.reaction as FoodReaction | null,
    notes: entity.notes,
    version: entity.version.toString(),
    createdAt: toIso(entity.createdAt),
    updatedAt: toIso(entity.updatedAt),
  };
}

export const CLINICAL_FOOD_GUIDELINES: FoodGuidelineItem[] = [
  {
    monthAge: 6,
    title: "Stage 1: Introduction to Solids (6 Months)",
    content: "Begin with smooth, iron-fortified single-ingredient purees (iron cereal, pumpkin, sweet potato, avocado, apple). Introduce one new food every 3-5 days to observe tolerance.",
    forbiddenFoods: ["honey", "cow_milk", "added_salt", "added_sugar", "whole_nuts"],
  },
  {
    monthAge: 8,
    title: "Stage 2: Thicker Purees & Soft Mashed (7-9 Months)",
    content: "Progress from fine purees to lumpy mashes and soft finger foods. Introduce proteins (chicken, pork, egg yolk, tofu, white fish) and various fruits and vegetables.",
    forbiddenFoods: ["honey", "raw_eggs", "whole_grapes", "hard_candies", "added_salt"],
  },
  {
    monthAge: 10,
    title: "Stage 3: Chopped Table Foods (10-12 Months)",
    content: "Transition towards bite-sized soft cooked family foods (diced vegetables, meatballs, pasta, whole egg). Foster self-feeding with spoon and fingers.",
    forbiddenFoods: ["honey", "high_sodium_processed_food", "unpasteurized_dairy"],
  },
  {
    monthAge: 12,
    title: "Stage 4: Family Table Foods (12+ Months)",
    content: "Join standard family meal patterns with low sodium and gentle seasoning. Pasteurized whole cow milk can replace formula as primary beverage.",
    forbiddenFoods: ["unpasteurized_dairy", "choking_hazards_without_supervision"],
  },
];

export class FoodService {
  private readonly repo: ScopedFoodRepository;
  private readonly libraryRepo: FoodLibraryRepository;
  private readonly planRepo: FoodPlanRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.repo = new ScopedFoodRepository(prisma);
    this.libraryRepo = new FoodLibraryRepository(prisma);
    this.planRepo = new FoodPlanRepository(prisma);
  }

  /**
   * Resolve a family scope without ever selecting the first membership when
   * the principal belongs to more than one family. The omitted form remains
   * compatible with the legacy single-family Web client.
   */
  private resolveLibraryFamilyId(principal: UserPrincipal, requestedFamilyId?: string): string {
    const activeFamilies = principal.familyMemberships.filter((membership) => membership.status === "active");
    if (requestedFamilyId) {
      if (!activeFamilies.some((membership) => membership.familyId === requestedFamilyId)) {
        throw new FamilyAccessDeniedError(requestedFamilyId);
      }
      return requestedFamilyId;
    }
    if (activeFamilies.length === 1 && activeFamilies[0]) return activeFamilies[0].familyId;
    if (activeFamilies.length === 0) throw new FamilyAccessDeniedError("none");
    throw new BadRequestError("A familyId is required when the account has multiple active families", "FAMILY_SELECTION_REQUIRED");
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

  async listFoodRecords(
    principal: UserPrincipal,
    babyId: string,
    pagination: KeysetPaginationQuery = {}
  ): Promise<PaginatedResult<FoodRecord>> {
    const familyId = await this.resolveBabyFamily(babyId);
    const limit = Math.min(pagination.limit ?? 50, 200);

    let beforeRecordDate: string | undefined;
    let beforeId: string | undefined;

    if (pagination.cursor) {
      const decoded = decodeFoodCursor(pagination.cursor);
      if (decoded) {
        beforeRecordDate = decoded.recordDate;
        beforeId = decoded.id;
      }
    }

    const records = await this.repo.listByBaby(principal, familyId, babyId, {
      limit: limit + 1,
      beforeRecordDate,
      beforeId,
    });

    const hasMore = records.length > limit;
    const pageItems = hasMore ? records.slice(0, limit) : records;
    let nextCursor: string | null = null;

    if (hasMore && pageItems.length > 0) {
      const lastItem = pageItems[pageItems.length - 1];
      if (lastItem) {
        nextCursor = encodeFoodCursor(lastItem.recordDate, lastItem.id);
      }
    }

    return {
      data: pageItems.map(mapEntityToFoodRecord),
      page: {
        nextCursor,
      },
    };
  }

  async getFoodRecord(
    principal: UserPrincipal,
    babyId: string,
    id: string
  ): Promise<FoodRecord> {
    const familyId = await this.resolveBabyFamily(babyId);
    const record = await this.repo.findById(principal, familyId, babyId, id);
    if (!record) {
      throw new RecordNotFoundError("food_record", id);
    }
    return mapEntityToFoodRecord(record);
  }

  async createFoodRecord(
    principal: UserPrincipal,
    babyId: string,
    body: CreateFoodRequest,
    idempotencyKey?: string
  ): Promise<FoodRecord> {
    const familyId = await this.resolveBabyFamily(babyId);

    const commandId = idempotencyKey || crypto.randomUUID();
    const id = crypto.randomUUID();
    const occurredAt = body.occurredAt ? new Date(body.occurredAt) : null;

    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          operation: "create",
          entityType: "food",
          familyId,
          babyId,
          recordDate: body.recordDate,
          mealType: body.mealType,
          occurredAt: occurredAt?.toISOString() ?? null,
          foodItemIds: body.foodItemIds,
          portionDescription: body.portionDescription ?? null,
          reaction: body.reaction ?? null,
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
      recordDate: body.recordDate,
      mealType: body.mealType,
      occurredAt,
      foodItemIds: body.foodItemIds,
      portionDescription: body.portionDescription ?? null,
      reaction: body.reaction ?? null,
      notes: body.notes ?? null,
    });

    return mapEntityToFoodRecord(result.result);
  }

  async updateFoodRecord(
    principal: UserPrincipal,
    babyId: string,
    id: string,
    body: UpdateFoodRequest,
    idempotencyKey?: string
  ): Promise<FoodRecord> {
    const familyId = await this.resolveBabyFamily(babyId);

    const commandId = idempotencyKey || crypto.randomUUID();
    const baseVersion = parseInt(body.baseVersion, 10);
    const occurredAt = body.occurredAt !== undefined ? (body.occurredAt ? new Date(body.occurredAt) : null) : undefined;

    const requestHash = crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          operation: "update",
          entityType: "food",
          id,
          baseVersion,
          familyId,
          babyId,
          recordDate: body.recordDate,
          mealType: body.mealType,
          occurredAt: occurredAt?.toISOString(),
          foodItemIds: body.foodItemIds,
          portionDescription: body.portionDescription,
          reaction: body.reaction,
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
      recordDate: body.recordDate,
      mealType: body.mealType,
      occurredAt,
      foodItemIds: body.foodItemIds,
      portionDescription: body.portionDescription,
      reaction: body.reaction,
      notes: body.notes,
    });

    return mapEntityToFoodRecord(result.result);
  }

  async deleteFoodRecord(
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
          entityType: "food",
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

  // Food Library
  async listFoodLibraryItems(
    principal: UserPrincipal,
    query: FoodLibraryItemsQuery = {},
  ): Promise<FoodLibraryItem[]> {
    const familyId = this.resolveLibraryFamilyId(principal, query.familyId);
    const items = await this.libraryRepo.listItems(principal, familyId);
    return items as FoodLibraryItem[];
  }

  async createFoodLibraryItem(
    principal: UserPrincipal,
    body: CreateFoodLibraryItemRequest
  ): Promise<FoodLibraryItem> {
    const familyId = this.resolveLibraryFamilyId(principal, body.familyId);

    const item = await this.libraryRepo.createCustomItem(principal, familyId, {
      name: body.name,
      category: body.category,
      allergenRisk: body.allergenRisk,
      recommendedAgeMonths: body.recommendedAgeMonths,
      tried: body.tried,
    });

    // The repository commits the item and optional family status together.
    // A second write here would run after commit and could report a failed
    // request even though creation already succeeded (or overwrite a newer status).
    return item as FoodLibraryItem;
  }

  getFoodGuidelines(): FoodGuidelineItem[] {
    return CLINICAL_FOOD_GUIDELINES;
  }

  // Food Plan
  async getFoodPlan(principal: UserPrincipal, babyId: string): Promise<FoodPlan> {
    const familyId = await this.resolveBabyFamily(babyId);
    const hasBaby = principal.babyMemberships?.some(
      (m) => m.userId === principal.userId && m.babyId === babyId && m.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId);

    const plan = await this.planRepo.getPlan(familyId, babyId);
    if (!plan) {
      return {
        id: null,
        babyId,
        planData: {},
        createdAt: null,
        updatedAt: new Date().toISOString(),
        version: "0",
      };
    }

    return {
      id: plan.id,
      babyId: plan.babyId,
      planData: plan.planData,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
      version: plan.version.toString(),
    };
  }

  async saveFoodPlan(
    principal: UserPrincipal,
    babyId: string,
    planData: Record<string, unknown>,
    baseVersion: string,
  ): Promise<FoodPlan> {
    const familyId = await this.resolveBabyFamily(babyId);
    const hasBaby = principal.babyMemberships?.some(
      (m) => m.userId === principal.userId && m.babyId === babyId && m.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId);

    const plan = await this.planRepo.savePlan(familyId, babyId, planData, parseFoodPlanVersion(baseVersion));
    return {
      id: plan.id,
      babyId: plan.babyId,
      planData: plan.planData,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
      version: plan.version.toString(),
    };
  }
}
