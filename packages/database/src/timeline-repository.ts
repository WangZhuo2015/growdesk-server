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
    options: { limit?: number; beforeOccurredAt?: Date; beforeId?: string; entityType?: string } = {}
  ): Promise<ReadonlyArray<TimelineEntryEntity>> {
    const hasFamily = principal.familyMemberships.some(
      (m) => m.familyId === familyId && m.status === "active"
    );
    if (!hasFamily) throw new FamilyAccessDeniedError(familyId);

    const hasBaby = principal.babyMemberships?.some(
      (m) => m.familyId === familyId && m.babyId === babyId && m.status === "active"
    );
    if (!hasBaby) throw new BabyAccessDeniedError(babyId, "ACCESS_DENIED");

    // Public pages remain capped at 200. The service requests one additional
    // row to distinguish a full final page from a page with more history.
    const limit = Math.min(options.limit ?? 50, 201);

    const where: Prisma.TimelineEntryWhereInput = {
      familyId,
      babyId,
      deletedAt: null,
      // The public care timeline contract excludes medical/vaccine projections.
      // Filter before take/keyset pagination so those rows cannot consume pages.
      entityType: {
        in: ["feeding", "sleep", "diaper", "food", "supplement", "growth"]
          .filter(type => !options.entityType || type === options.entityType),
      },
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

export { TimelineRepository as ScopedTimelineRepository };
