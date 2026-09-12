import { PrismaClient, Prisma } from "./generated/client.js";
import { UserPrincipal } from "@growdesk/domain";
import { FamilyAccessDeniedError, BabyAccessDeniedError } from "./errors.js";

export interface TimelineEntryEntity {
  readonly id: string;
  readonly familyId: string;
  readonly babyId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly occurredAt: Date;
  readonly summary: string;
  readonly details: Record<string, unknown> | null;
  readonly source: string;
  readonly version: number;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

function mapTimelineRow(row: {
  id: string;
  familyId: string;
  babyId: string;
  entityType: string;
  entityId: string;
  occurredAt: Date;
  summary: string;
  details: Prisma.JsonValue;
  source: string;
  version: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): TimelineEntryEntity {
  return {
    ...row,
    details: (typeof row.details === "object" && row.details !== null)
      ? (row.details as Record<string, unknown>)
      : null,
  };
}

export class TimelineRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async listByBaby(
    principal: UserPrincipal,
    familyId: string,
    babyId: string,
    options: { limit?: number; beforeOccurredAt?: Date; beforeId?: string } = {}
  ): Promise<ReadonlyArray<TimelineEntryEntity>> {
    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasFamily) throw new FamilyAccessDeniedError(familyId);

    const hasBaby = principal.babyMemberships?.some(
      (m) => m.userId === principal.userId && m.babyId === babyId && m.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId);

    const limit = Math.min(options.limit ?? 50, 200);

    const where: Prisma.TimelineEntryWhereInput = {
      familyId,
      babyId,
      deletedAt: null,
    };

    if (options.beforeOccurredAt) {
      if (options.beforeId) {
        where.OR = [
          { occurredAt: { lt: options.beforeOccurredAt } },
          { occurredAt: options.beforeOccurredAt, id: { lt: options.beforeId } },
        ];
      } else {
        where.occurredAt = { lt: options.beforeOccurredAt };
      }
    }

    const rows = await this.prisma.timelineEntry.findMany({
      where,
      orderBy: [
        { occurredAt: "desc" },
        { id: "desc" },
      ],
      take: limit,
    });

    return rows.map(mapTimelineRow);
  }
}
