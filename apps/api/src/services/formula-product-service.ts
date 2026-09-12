import type { PrismaClient } from "@growdesk/database";
import {
  ScopedFormulaProductRepository,
  type FormulaProductEntity,
  RecordNotFoundError,
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
    options: { limit?: number; includeArchived?: boolean } = {}
  ): Promise<{ data: FormulaProduct[]; page: { nextCursor: null } }> {
    const records = await this.repo.listByFamily(principal, familyId, options);
    return {
      data: records.map(mapEntityToFormulaProduct),
      page: { nextCursor: null },
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
