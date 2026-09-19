import crypto from "node:crypto";
import { PrismaClient } from "@growdesk/database";
import { UserPrincipal } from "@growdesk/domain";
import {
  RegisterPushDeviceRequest,
  NotificationItem,
} from "@growdesk/contracts";
import { BadRequestError, RecordNotFoundError } from "@growdesk/database";

export function encodeNotificationCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeNotificationCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const separator = raw.indexOf("|");
    if (separator <= 0 || separator === raw.length - 1 || raw.indexOf("|", separator + 1) !== -1) return null;
    const createdAt = new Date(raw.slice(0, separator));
    const id = raw.slice(separator + 1);
    if (!Number.isFinite(createdAt.getTime()) || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export class NotificationService {
  constructor(private readonly prisma: PrismaClient) {}

  async registerPushDevice(
    principal: UserPrincipal,
    installationId: string,
    input: RegisterPushDeviceRequest
  ): Promise<{ data: { success: true } }> {
    await this.prisma.pushDevice.upsert({
      where: {
        uq_push_devices_user_installation: {
          userId: principal.userId,
          installationId,
        },
      },
      create: {
        id: crypto.randomUUID(),
        userId: principal.userId,
        installationId,
        platform: input.platform,
        environment: input.environment,
        token: input.token,
        deviceLabel: input.deviceLabel ?? null,
      },
      update: {
        platform: input.platform,
        environment: input.environment,
        token: input.token,
        deviceLabel: input.deviceLabel ?? null,
      },
    });

    return { data: { success: true } };
  }

  async unregisterPushDevice(
    principal: UserPrincipal,
    installationId: string
  ): Promise<{ data: { success: true } }> {
    await this.prisma.pushDevice.deleteMany({
      where: {
        userId: principal.userId,
        installationId,
      },
    });

    return { data: { success: true } };
  }

  async listNotifications(
    principal: UserPrincipal,
    options: { limit?: number; cursor?: string } = {}
  ): Promise<{ data: NotificationItem[]; page: { nextCursor: string | null } }> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const before = options.cursor ? decodeNotificationCursor(options.cursor) : null;
    if (options.cursor && !before) {
      throw new BadRequestError("Invalid notification cursor", "INVALID_NOTIFICATION_CURSOR");
    }

    const rows = await this.prisma.notification.findMany({
      where: {
        userId: principal.userId,
        ...(before
          ? {
              OR: [
                { createdAt: { lt: before.createdAt } },
                { createdAt: before.createdAt, id: { lt: before.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    let nextCursor: string | null = null;
    const lastRow = pageRows[pageRows.length - 1];
    if (hasMore && lastRow) {
      nextCursor = encodeNotificationCursor(lastRow.createdAt, lastRow.id);
    }

    const data: NotificationItem[] = pageRows.map((r) => ({
      id: r.id,
      userId: r.userId,
      eventKey: r.eventKey,
      title: r.title,
      body: r.body,
      data: (r.data as Record<string, unknown>) ?? undefined,
      readAt: r.readAt ? r.readAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
    }));

    return { data, page: { nextCursor } };
  }

  async markNotificationAsRead(
    principal: UserPrincipal,
    notificationId: string
  ): Promise<{ data: { success: true } }> {
    const notif = await this.prisma.notification.findUnique({
      where: { id: notificationId },
    });

    if (!notif || notif.userId !== principal.userId) {
      throw new RecordNotFoundError("Notification", notificationId);
    }

    if (!notif.readAt) {
      await this.prisma.notification.update({
        where: { id: notificationId },
        data: { readAt: new Date() },
      });
    }

    return { data: { success: true } };
  }
}
