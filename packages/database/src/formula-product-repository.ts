import { PrismaClient, Prisma } from "./generated/client.js";
import { UserPrincipal } from "@growdesk/domain";
import { FamilyAccessDeniedError, RecordNotFoundError } from "./errors.js";

export interface FormulaProductEntity {
  readonly id: string;
  readonly familyId: string;
  readonly brand: string;
  readonly name: string;
  readonly stage: string | null;
  readonly scoopWeightG: string | null;
  readonly waterPerScoopMl: string | null;
  readonly reconstitutionRatio: string | null;
  readonly servingSizeUnit: string;
  readonly nutrientsJson: unknown | null;
  readonly notes: string | null;
  readonly isActive: boolean;
  readonly isDefault: boolean;
  readonly isArchived: boolean;
  readonly version: number;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function mapFormulaProductRow(row: {
  id: string;
  familyId: string;
  brand: string;
  name: string;
  stage: string | null;
  scoopWeightG: Prisma.Decimal | null;
  waterPerScoopMl: Prisma.Decimal | null;
  reconstitutionRatio: Prisma.Decimal | null;
  servingSizeUnit: string;
  nutrientsJson: Prisma.JsonValue | null;
  notes: string | null;
  isActive: boolean;
  isDefault: boolean;
  isArchived: boolean;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): FormulaProductEntity {
  return {
    ...row,
    scoopWeightG: row.scoopWeightG ? row.scoopWeightG.toString() : null,
    waterPerScoopMl: row.waterPerScoopMl ? row.waterPerScoopMl.toString() : null,
    reconstitutionRatio: row.reconstitutionRatio ? row.reconstitutionRatio.toString() : null,
  };
}

export interface CreateFormulaProductInput {
  readonly id: string;
  readonly familyId: string;
  readonly brand: string;
  readonly name: string;
  readonly stage?: string | null;
  readonly scoopGrams?: string | number | null;
  readonly waterMlPerScoop?: string | number | null;
  readonly notes?: string | null;
}

export interface UpdateFormulaProductInput {
  readonly brand?: string;
  readonly name?: string;
  readonly stage?: string | null;
  readonly scoopGrams?: string | number | null;
  readonly waterMlPerScoop?: string | number | null;
  readonly isArchived?: boolean;
  readonly notes?: string | null;
}

export class ScopedFormulaProductRepository {
  constructor(private readonly prisma: PrismaClient) {}

  private checkFamilyAccess(principal: UserPrincipal, familyId: string, write = false): void {
    const membership = principal.familyMemberships.find(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!membership) {
      throw new FamilyAccessDeniedError(familyId);
    }
    if (write && membership.role === "viewer") {
      throw new FamilyAccessDeniedError(familyId);
    }
  }

  async create(
    principal: UserPrincipal,
    input: CreateFormulaProductInput
  ): Promise<FormulaProductEntity> {
    this.checkFamilyAccess(principal, input.familyId, true);

    const row = await this.prisma.formulaProduct.create({
      data: {
        id: input.id,
        familyId: input.familyId,
        brand: input.brand,
        name: input.name,
        stage: input.stage ?? null,
        scoopWeightG: input.scoopGrams !== undefined && input.scoopGrams !== null
          ? new Prisma.Decimal(input.scoopGrams.toString())
          : null,
        waterPerScoopMl: input.waterMlPerScoop !== undefined && input.waterMlPerScoop !== null
          ? new Prisma.Decimal(input.waterMlPerScoop.toString())
          : null,
        notes: input.notes ?? null,
      },
    });

    return mapFormulaProductRow(row);
  }

  async update(
    principal: UserPrincipal,
    familyId: string,
    id: string,
    input: UpdateFormulaProductInput
  ): Promise<FormulaProductEntity> {
    this.checkFamilyAccess(principal, familyId, true);

    const existing = await this.prisma.formulaProduct.findUnique({
      where: { id },
    });
    if (!existing || existing.familyId !== familyId || existing.deletedAt !== null) {
      throw new RecordNotFoundError("formula_product", id);
    }

    const data: Prisma.FormulaProductUpdateInput = {
      updatedAt: new Date(),
    };
    if (input.brand !== undefined) data.brand = input.brand;
    if (input.name !== undefined) data.name = input.name;
    if (input.stage !== undefined) data.stage = input.stage;
    if (input.scoopGrams !== undefined) {
      data.scoopWeightG = input.scoopGrams !== null ? new Prisma.Decimal(input.scoopGrams.toString()) : null;
    }
    if (input.waterMlPerScoop !== undefined) {
      data.waterPerScoopMl = input.waterMlPerScoop !== null ? new Prisma.Decimal(input.waterMlPerScoop.toString()) : null;
    }
    if (input.isArchived !== undefined) data.isArchived = input.isArchived;
    if (input.notes !== undefined) data.notes = input.notes;

    const row = await this.prisma.formulaProduct.update({
      where: { id },
      data,
    });

    return mapFormulaProductRow(row);
  }

  async delete(
    principal: UserPrincipal,
    familyId: string,
    id: string
  ): Promise<boolean> {
    this.checkFamilyAccess(principal, familyId, true);

    const existing = await this.prisma.formulaProduct.findUnique({
      where: { id },
    });
    if (!existing || existing.familyId !== familyId || existing.deletedAt !== null) {
      return false;
    }

    await this.prisma.formulaProduct.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        isArchived: true,
        updatedAt: new Date(),
      },
    });

    return true;
  }

  async findById(
    principal: UserPrincipal,
    familyId: string,
    id: string
  ): Promise<FormulaProductEntity | null> {
    this.checkFamilyAccess(principal, familyId, false);

    const row = await this.prisma.formulaProduct.findUnique({
      where: { id },
    });
    if (!row || row.familyId !== familyId || row.deletedAt !== null) {
      return null;
    }

    return mapFormulaProductRow(row);
  }

  async listByFamily(
    principal: UserPrincipal,
    familyId: string,
    options: { limit?: number; includeArchived?: boolean } = {}
  ): Promise<ReadonlyArray<FormulaProductEntity>> {
    this.checkFamilyAccess(principal, familyId, false);

    const limit = Math.min(options.limit ?? 50, 200);
    const where: Prisma.FormulaProductWhereInput = {
      familyId,
      deletedAt: null,
    };
    if (!options.includeArchived) {
      where.isArchived = false;
    }

    const rows = await this.prisma.formulaProduct.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return rows.map(mapFormulaProductRow);
  }
}
