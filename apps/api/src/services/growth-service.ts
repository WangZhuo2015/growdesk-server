import type { PrismaClient } from "@growdesk/database";
import {
  ScopedGrowthRepository,
  type GrowthMeasurementEntity,
  RecordNotFoundError,
  BabyAccessDeniedError,
} from "@growdesk/database";
import { buildWhoGrowthChartSet, type UserPrincipal } from "@growdesk/domain";
import type {
  CreateGrowthMeasurementRequest,
  UpdateGrowthMeasurementRequest,
  GrowthMeasurement,
  GrowthChartResponse,
} from "@growdesk/contracts";
import crypto from "node:crypto";

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

export function encodeGrowthKeysetCursor(measurementDate: Date, id: string): string {
  const dateStr = measurementDate.toISOString().slice(0, 10);
  return Buffer.from(`${dateStr}|${id}`).toString("base64url");
}

export function decodeGrowthKeysetCursor(cursor: string): { measurementDate: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const [dateStr, id] = raw.split("|");
    if (!dateStr || !id) return null;
    const measurementDate = new Date(`${dateStr}T00:00:00.000Z`);
    if (isNaN(measurementDate.getTime())) return null;
    return { measurementDate, id };
  } catch {
    return null;
  }
}

export function mapEntityToGrowthMeasurement(entity: GrowthMeasurementEntity): GrowthMeasurement {
  const toIso = (d: Date | string): string =>
    typeof d === "string" ? new Date(d).toISOString() : d.toISOString();

  const toDateStr = (d: Date | string): string =>
    typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);

  return {
    id: entity.id,
    babyId: entity.babyId,
    familyId: entity.familyId,
    measurementDate: toDateStr(entity.measurementDate),
    weightKg: entity.weightKg,
    heightCm: entity.heightCm,
    headCircumferenceCm: entity.headCircumferenceCm,
    attachmentId: entity.attachmentId,
    notes: entity.notes,
    version: entity.version.toString(),
    createdAt: toIso(entity.createdAt),
    updatedAt: toIso(entity.updatedAt),
  };
}

export class GrowthService {
  private readonly repo: ScopedGrowthRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.repo = new ScopedGrowthRepository(prisma);
  }

  private async resolveBaby(babyId: string): Promise<{ familyId: string; gender: string }> {
    const baby = await this.prisma.baby.findUnique({
      where: { id: babyId },
      select: { familyId: true, gender: true, deletedAt: true },
    });
    if (!baby || baby.deletedAt !== null) {
      throw new BabyAccessDeniedError(babyId, "BABY_NOT_FOUND");
    }
    return { familyId: baby.familyId, gender: baby.gender };
  }

  async listGrowthMeasurements(
    principal: UserPrincipal,
    babyId: string,
    pagination: KeysetPaginationQuery = {}
  ): Promise<PaginatedResult<GrowthMeasurement>> {
    const { familyId } = await this.resolveBaby(babyId);
    const limit = Math.min(pagination.limit ?? 50, 200);

    let beforeMeasurementDate: Date | undefined;
    let beforeId: string | undefined;

    if (pagination.cursor) {
      const decoded = decodeGrowthKeysetCursor(pagination.cursor);
      if (decoded) {
        beforeMeasurementDate = decoded.measurementDate;
        beforeId = decoded.id;
      }
    }

    const records = await this.repo.listByBaby(principal, familyId, babyId, {
      limit: limit + 1,
      beforeMeasurementDate,
      beforeId,
    });

    const hasMore = records.length > limit;
    const pageItems = hasMore ? records.slice(0, limit) : records;
    let nextCursor: string | null = null;

    if (hasMore && pageItems.length > 0) {
      const lastItem = pageItems[pageItems.length - 1];
      if (lastItem) {
        nextCursor = encodeGrowthKeysetCursor(lastItem.measurementDate, lastItem.id);
      }
    }

    return {
      data: pageItems.map(mapEntityToGrowthMeasurement),
      page: {
        nextCursor,
      },
    };
  }

  async getGrowthMeasurement(
    principal: UserPrincipal,
    babyId: string,
    id: string
  ): Promise<GrowthMeasurement> {
    const { familyId } = await this.resolveBaby(babyId);
    const entity = await this.repo.findById(principal, familyId, babyId, id);
    if (!entity) {
      throw new RecordNotFoundError("growth_measurement", id);
    }
    return mapEntityToGrowthMeasurement(entity);
  }

  async createGrowthMeasurement(
    principal: UserPrincipal,
    babyId: string,
    request: CreateGrowthMeasurementRequest,
    idempotencyKey?: string
  ): Promise<GrowthMeasurement> {
    const { familyId } = await this.resolveBaby(babyId);
    const id = crypto.randomUUID();
    const commandId = idempotencyKey ? `growth-create-${idempotencyKey}` : `growth-create-${id}`;
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex");

    const execResult = await this.repo.create(principal, {
      commandId,
      requestHash,
      id,
      familyId,
      babyId,
      measurementDate: request.measurementDate,
      weightKg: request.weightKg,
      heightCm: request.heightCm,
      headCircumferenceCm: request.headCircumferenceCm,
      attachmentId: request.attachmentId,
      notes: request.notes,
    });

    return mapEntityToGrowthMeasurement(execResult.result);
  }

  async updateGrowthMeasurement(
    principal: UserPrincipal,
    babyId: string,
    id: string,
    request: UpdateGrowthMeasurementRequest,
    idempotencyKey?: string
  ): Promise<GrowthMeasurement> {
    const { familyId } = await this.resolveBaby(babyId);
    const commandId = idempotencyKey ? `growth-update-${idempotencyKey}` : `growth-update-${id}-${request.baseVersion}`;
    const requestHash = crypto.createHash("sha256").update(JSON.stringify(request)).digest("hex");

    const execResult = await this.repo.update(principal, {
      commandId,
      requestHash,
      id,
      familyId,
      babyId,
      baseVersion: parseInt(request.baseVersion, 10),
      measurementDate: request.measurementDate,
      weightKg: request.weightKg,
      heightCm: request.heightCm,
      headCircumferenceCm: request.headCircumferenceCm,
      attachmentId: request.attachmentId,
      notes: request.notes,
    });

    return mapEntityToGrowthMeasurement(execResult.result);
  }

  async deleteGrowthMeasurement(
    principal: UserPrincipal,
    babyId: string,
    id: string,
    baseVersion: number,
    idempotencyKey?: string
  ): Promise<{ id: string; deleted: true }> {
    const { familyId } = await this.resolveBaby(babyId);
    const commandId = idempotencyKey ? `growth-delete-${idempotencyKey}` : `growth-delete-${id}-${baseVersion}`;
    const requestHash = crypto.createHash("sha256").update(JSON.stringify({ id, baseVersion })).digest("hex");

    const execResult = await this.repo.delete(principal, {
      commandId,
      requestHash,
      id,
      familyId,
      babyId,
      baseVersion,
    });

    return {
      id: execResult.result.id,
      deleted: true,
    };
  }

  async getGrowthChart(
    principal: UserPrincipal,
    babyId: string
  ): Promise<GrowthChartResponse["data"]> {
    const { familyId, gender } = await this.resolveBaby(babyId);
    const measurements = await this.repo.listAllForChart(principal, familyId, babyId);
    const whoPercentiles = buildWhoGrowthChartSet(gender);

    return {
      measurements: measurements.map(mapEntityToGrowthMeasurement),
      whoPercentiles,
    };
  }
}
