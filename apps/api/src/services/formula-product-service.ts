import type { PrismaClient } from "@growdesk/database";
import {
  ScopedFormulaProductRepository,
  type FormulaProductEntity,
  RecordNotFoundError,
  BadRequestError,
} from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import type {
  CreateFormulaProductRequest,
  UpdateFormulaProductRequest,
  FormulaProduct,
} from "@growdesk/contracts";
import crypto from "node:crypto";

export function mapEntityToFormulaProduct(entity: FormulaProductEntity): FormulaProduct {
  return {
    id: entity.id,
    familyId: entity.familyId,
    brand: entity.brand,
    name: entity.name,
    stage: entity.stage,
    scoopGrams: entity.scoopWeightG,
    waterMlPerScoop: entity.waterPerScoopMl,
    reconstitutionRatio: entity.reconstitutionRatio,
    servingSizeUnit: entity.servingSizeUnit,
    nutrientsJson: entity.nutrientsJson,
    notes: entity.notes,
    isActive: entity.isActive,
    isDefault: entity.isDefault,
    isArchived: entity.isArchived,
    createdAt: entity.createdAt.toISOString(),
    updatedAt: entity.updatedAt.toISOString(),
  };
}

export class FormulaProductService {
  private readonly repo: ScopedFormulaProductRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.repo = new ScopedFormulaProductRepository(prisma);
  }

  async listFormulaProducts(
    principal: UserPrincipal,
    familyId: string,
    options: { limit?: number; includeArchived?: boolean; cursor?: string } = {}
  ): Promise<{ data: FormulaProduct[]; page: { nextCursor: string | null } }> {
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    let before: { createdAt: Date; id: string } | undefined;
    if (options.cursor) {
      const [date, id, extra] = Buffer.from(options.cursor, "base64url").toString("utf8").split("|");
      const createdAt = new Date(date ?? "");
      if (!Number.isFinite(createdAt.getTime()) || !id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || extra !== undefined) {
        throw new BadRequestError("Invalid formula product cursor", "INVALID_CURSOR");
      }
      before = { createdAt, id };
    }
    const records = await this.repo.listByFamily(principal, familyId, { ...options, limit, before, lookahead: true });
    const visible = records.slice(0, limit);
    const last = visible.at(-1);
    return {
      data: visible.map(mapEntityToFormulaProduct),
      page: { nextCursor: records.length > limit && last ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`).toString("base64url") : null },
    };
  }

  async createFormulaProduct(
    principal: UserPrincipal,
    familyId: string,
    body: CreateFormulaProductRequest
  ): Promise<FormulaProduct> {
    const id = crypto.randomUUID();
    const entity = await this.repo.create(principal, {
      id,
      familyId,
      brand: body.brand,
      name: body.name,
      stage: body.stage ?? null,
      scoopGrams: body.scoopGrams ?? null,
      waterMlPerScoop: body.waterMlPerScoop ?? null,
    });
    return mapEntityToFormulaProduct(entity);
  }

  async updateFormulaProduct(
    principal: UserPrincipal,
    familyId: string,
    id: string,
    body: UpdateFormulaProductRequest
  ): Promise<FormulaProduct> {
    const entity = await this.repo.update(principal, familyId, id, {
      brand: body.brand,
      name: body.name,
      stage: body.stage,
      scoopGrams: body.scoopGrams,
      waterMlPerScoop: body.waterMlPerScoop,
      isArchived: body.isArchived,
    });
    return mapEntityToFormulaProduct(entity);
  }

  async deleteFormulaProduct(
    principal: UserPrincipal,
    familyId: string,
    id: string
  ): Promise<{ success: true; id: string }> {
    const deleted = await this.repo.delete(principal, familyId, id);
    if (!deleted) {
      throw new RecordNotFoundError("formula_product", id);
    }
    return { success: true, id };
  }
}
