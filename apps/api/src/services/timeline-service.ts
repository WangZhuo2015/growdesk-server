import type { PrismaClient } from "@growdesk/database";
import {
  ScopedTimelineRepository,
  type TimelineEntryEntity,
  BabyAccessDeniedError,
} from "@growdesk/database";
import type { UserPrincipal } from "@growdesk/domain";
import type {
  TimelineEntry,
  TimelineEntityType,
} from "@growdesk/contracts";

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

export function encodeTimelineKeysetCursor(occurredAt: Date, id: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeTimelineKeysetCursor(cursor: string): { occurredAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const [dateStr, id] = raw.split("|");
    if (!dateStr || !id) return null;
    const occurredAt = new Date(dateStr);
    if (isNaN(occurredAt.getTime())) return null;
    return { occurredAt, id };
  } catch {
    return null;
  }
}

export function mapEntityToTimelineEntry(entity: TimelineEntryEntity): TimelineEntry {
  const toIso = (d: Date | string): string =>
    typeof d === "string" ? new Date(d).toISOString() : d.toISOString();

  return {
    id: entity.id,
    babyId: entity.babyId,
    entityType: entity.entityType as TimelineEntityType,
    entityId: entity.entityId,
    occurredAt: toIso(entity.occurredAt),
    summary: entity.summary,
    version: entity.version.toString(),
  };
}

export class TimelineService {
  private readonly repo: ScopedTimelineRepository;

  constructor(private readonly prisma: PrismaClient) {
    this.repo = new ScopedTimelineRepository(prisma);
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

  async listTimeline(
    principal: UserPrincipal,
    babyId: string,
    pagination: KeysetPaginationQuery & { entityType?: string } = {}
  ): Promise<PaginatedResult<TimelineEntry>> {
    const familyId = await this.resolveBabyFamily(babyId);
    const limit = Math.min(pagination.limit ?? 50, 200);

    let beforeOccurredAt: Date | undefined;
    let beforeId: string | undefined;

    if (pagination.cursor) {
      const decoded = decodeTimelineKeysetCursor(pagination.cursor);
      if (decoded) {
        beforeOccurredAt = decoded.occurredAt;
        beforeId = decoded.id;
      }
    }

    const records = await this.repo.listByBaby(principal, familyId, babyId, {
      limit: limit + 1,
      beforeOccurredAt,
      beforeId,
      entityType: pagination.entityType,
    });

    const hasMore = records.length > limit;
    const pageItems = hasMore ? records.slice(0, limit) : records;
    let nextCursor: string | null = null;

    if (hasMore && pageItems.length > 0) {
      const lastItem = pageItems[pageItems.length - 1];
      if (lastItem) {
        nextCursor = encodeTimelineKeysetCursor(lastItem.occurredAt, lastItem.id);
      }
    }

    return {
      data: pageItems.map(mapEntityToTimelineEntry),
      page: {
        nextCursor,
      },
    };
  }
}
